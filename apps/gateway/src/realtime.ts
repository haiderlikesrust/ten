import { and, asc, desc, eq, getSetting, gt, inArray, outbox, sql, type Database } from "@gemdex/db";
import type { WebSocket } from "ws";
import { readSession } from "./auth";

/** How far behind the newest event a late-committing one is still picked up. */
const LATE_WINDOW = 300;
/** The most events a reconnecting browser is sent to catch up. */
const REPLAY_MAX = 2_000;
/** How long after catching up a socket still checks for an event reaching it twice. */
const OVERLAP_MS = 10_000;

const PUBLIC_TOPICS = new Set(["drops", "wins", "pulls", "listings", "status", "gifts"]);

interface Client {
  socket: WebSocket;
  userTopic: string | null;
  /**
   * While a socket catches up, the live feed is already sending to it, so an event committed in that moment can
   * arrive by both routes. This holds what the socket has been sent until the two routes can no longer overlap.
   */
  seen: Set<number> | null;
}

/**
 * Fans out the outbox. Every event has a sequence number, so a client that drops off
 * can reconnect with lastSeq and get exactly what it missed.
 */
export class Realtime {
  private readonly clients = new Set<Client>();
  private lastSeq = 0;
  /**
   * Sequence numbers already sent. A row takes its number when it is inserted but only becomes visible when its
   * transaction commits, so a lower number can appear after a higher one. Each flush re-reads a short window behind
   * the newest, and this set keeps those reads from sending anything twice.
   */
  private readonly sent = new Set<number>();
  private flushing = false;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unlisten: (() => Promise<void>) | null = null;

  constructor(private readonly database: Database) {}

  async start(): Promise<void> {
    const latest = await this.database.db.select({ seq: outbox.seq }).from(outbox).orderBy(desc(outbox.seq)).limit(LATE_WINDOW);
    this.lastSeq = latest[0]?.seq ?? 0;
    // Everything already there counts as sent, so a restart doesn't replay it.
    for (const row of latest) this.sent.add(row.seq);
    const listening = await this.database.sql.listen("outbox", () => void this.flush());
    this.unlisten = () => listening.unlisten();
    this.timer = setInterval(() => void this.flush(), 2_000);
  }

  /** Ends the polling and the database listener, so nothing queries a database that is closing. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.unlisten?.().catch(() => {});
    this.unlisten = null;
  }

  private async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.flushing) {
      this.again = true;
      return;
    }
    this.flushing = true;
    try {
      const rows = await this.database.db.select().from(outbox).where(gt(outbox.seq, this.lastSeq - LATE_WINDOW)).orderBy(asc(outbox.seq)).limit(LATE_WINDOW + 500);
      for (const row of rows) {
        if (this.sent.has(row.seq)) continue;
        this.sent.add(row.seq);
        if (row.seq > this.lastSeq) this.lastSeq = row.seq;
        const text = JSON.stringify({ seq: row.seq, topic: row.topic, payload: row.payload, at: row.at });
        for (const client of this.clients) {
          if (!this.allowed(client, row.topic) || client.socket.readyState !== 1 || client.seen?.has(row.seq)) continue;
          client.seen?.add(row.seq);
          client.socket.send(text);
        }
      }
      for (const seq of this.sent) if (seq <= this.lastSeq - LATE_WINDOW) this.sent.delete(seq);
    } catch (error) {
      // A failed read must never take the gateway down: nothing was marked sent, so the next flush sends it.
      if (!this.stopped) console.error("[gateway] live feed read failed:", error instanceof Error ? error.message : error);
    } finally {
      this.flushing = false;
      if (this.again) {
        this.again = false;
        void this.flush();
      }
    }
  }

  private allowed(client: Client, topic: string): boolean {
    return PUBLIC_TOPICS.has(topic) || topic === client.userTopic;
  }

  async attach(socket: WebSocket, token: string | undefined, lastSeq: number | null): Promise<void> {
    try {
      const userId = await readSession(token);
      const client: Client = { socket, userTopic: userId ? `user:${userId}` : null, seen: lastSeq === null ? null : new Set() };
      this.clients.add(client);
      socket.on("close", () => this.clients.delete(client));
      socket.on("error", () => this.clients.delete(client));
      // The server's clock goes along, so a browser whose own clock is off can still count down correctly.
      socket.send(JSON.stringify({ topic: "hello", payload: { seq: this.lastSeq, now: Date.now() } }));

      if (lastSeq !== null) {
        // Only what this socket may see, and no price ticks: there is one a second, each replaced by the next, and
        // a few minutes of them used to fill the whole catch-up and push out the orders, wins and gifts that mattered.
        const topics = [...PUBLIC_TOPICS, ...(client.userTopic ? [client.userTopic] : [])];
        const rows = await this.database.db
          .select()
          .from(outbox)
          .where(and(gt(outbox.seq, lastSeq), inArray(outbox.topic, topics), sql`${outbox.payload}->>'type' is distinct from 'prices'`))
          .orderBy(asc(outbox.seq))
          .limit(REPLAY_MAX);
        for (const row of rows) {
          if (client.seen?.has(row.seq) || socket.readyState !== 1) continue;
          client.seen?.add(row.seq);
          socket.send(JSON.stringify({ seq: row.seq, topic: row.topic, payload: row.payload, at: row.at }));
        }
        setTimeout(() => (client.seen = null), OVERLAP_MS).unref();
      }
    } catch (error) {
      // The browser reconnects and resumes from its last event, so closing loses nothing. Never an unhandled rejection.
      console.error("[gateway] live feed connect failed:", error instanceof Error ? error.message : error);
      try {
        socket.close(1011, "Try again");
      } catch {
        // Already closed.
      }
    }
  }
}

export { eq, getSetting };
