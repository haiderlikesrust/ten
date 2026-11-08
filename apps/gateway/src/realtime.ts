import { and, asc, desc, eq, getSetting, gt, outbox, type Database } from "@gemdex/db";
import type { WebSocket } from "ws";
import { readSession } from "./auth";

/** How far behind the newest event a late-committing one is still picked up. */
const LATE_WINDOW = 300;

const PUBLIC_TOPICS = new Set(["drops", "wins", "pulls", "listings", "status", "gifts"]);

interface Client {
  socket: WebSocket;
  userTopic: string | null;
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

  constructor(private readonly database: Database) {}

  async start(): Promise<void> {
    const latest = await this.database.db.select({ seq: outbox.seq }).from(outbox).orderBy(desc(outbox.seq)).limit(LATE_WINDOW);
    this.lastSeq = latest[0]?.seq ?? 0;
    // Everything already there counts as sent, so a restart doesn't replay it.
    for (const row of latest) this.sent.add(row.seq);
    await this.database.sql.listen("outbox", () => void this.flush());
    setInterval(() => void this.flush(), 2_000);
  }

  private async flush(): Promise<void> {
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
          if (this.allowed(client, row.topic) && client.socket.readyState === 1) client.socket.send(text);
        }
      }
      for (const seq of this.sent) if (seq <= this.lastSeq - LATE_WINDOW) this.sent.delete(seq);
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
    const userId = await readSession(token);
    const client: Client = { socket, userTopic: userId ? `user:${userId}` : null };
    this.clients.add(client);
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
    socket.send(JSON.stringify({ topic: "hello", payload: { seq: this.lastSeq } }));

    if (lastSeq !== null) {
      const rows = await this.database.db.select().from(outbox).where(and(gt(outbox.seq, lastSeq))).orderBy(asc(outbox.seq)).limit(500);
      for (const row of rows) {
        if (this.allowed(client, row.topic)) socket.send(JSON.stringify({ seq: row.seq, topic: row.topic, payload: row.payload, at: row.at }));
      }
    }
  }
}

export { eq, getSetting };
