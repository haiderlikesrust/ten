import { and, asc, eq, getSetting, gt, outbox, type Database } from "@gemdex/db";
import type { WebSocket } from "ws";
import { readSession } from "./auth";

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
  private flushing = false;
  private again = false;

  constructor(private readonly database: Database) {}

  async start(): Promise<void> {
    const latest = await this.database.db.select({ seq: outbox.seq }).from(outbox).orderBy(asc(outbox.seq));
    this.lastSeq = latest.at(-1)?.seq ?? 0;
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
      const rows = await this.database.db.select().from(outbox).where(gt(outbox.seq, this.lastSeq)).orderBy(asc(outbox.seq)).limit(500);
      for (const row of rows) {
        this.lastSeq = row.seq;
        const text = JSON.stringify({ seq: row.seq, topic: row.topic, payload: row.payload, at: row.at });
        for (const client of this.clients) {
          if (this.allowed(client, row.topic) && client.socket.readyState === 1) client.socket.send(text);
        }
      }
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
