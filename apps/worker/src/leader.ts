import http from "node:http";
import type { Database } from "@gemdex/db";

/** Every worker competes for this Postgres advisory lock, and only the holder runs the loops. */
const LEADER_LOCK = 7270012;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type WorkerState = "starting" | "standby" | "active" | "stopping";

export interface Leadership {
  release: () => Promise<void>;
}

/**
 * Waits until this worker holds the lock, then keeps checking that it still does.
 *
 * Drops, Pulse prices, orders and chain sends must never run in two workers at once, and during an
 * update two workers do exist for a moment: the new one waits here as a standby until the old one
 * finishes its jobs and lets go. The hand-over takes well under a second.
 */
export async function holdLeadership(
  database: Database,
  opts: { onStandby: () => void; onLost: (why: string) => void; pollMs?: number },
): Promise<Leadership> {
  // A session lock belongs to one connection, so it gets a connection of its own.
  const conn = await database.sql.reserve();
  let waiting = false;
  for (;;) {
    const [row] = await conn.unsafe<{ ok: boolean }[]>(`select pg_try_advisory_lock(${LEADER_LOCK}) as ok`);
    if (row?.ok) break;
    if (!waiting) {
      waiting = true;
      opts.onStandby();
    }
    await sleep(opts.pollMs ?? 250);
  }

  let released = false;
  // If that connection drops, Postgres frees the lock and a standby takes over, so this worker must stop at once.
  const check = setInterval(() => {
    conn
      .unsafe<{ held: number }[]>(
        `select count(*)::int as held from pg_locks where locktype = 'advisory' and objid = ${LEADER_LOCK} and objsubid = 1 and pid = pg_backend_pid() and granted`,
      )
      .then(
        ([row]) => {
          if (!released && !row?.held) opts.onLost("the lock is no longer held");
        },
        (error: Error) => {
          if (!released) opts.onLost(error.message);
        },
      );
  }, 1_000);
  check.unref();

  return {
    release: async () => {
      released = true;
      clearInterval(check);
      try {
        await conn.unsafe(`select pg_advisory_unlock(${LEADER_LOCK})`);
      } finally {
        conn.release();
      }
    },
  };
}

/** True unless the database refuses. A slow answer (a long query ahead of it) is not a failure. */
export async function databaseAlive(database: Database): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, 2_000, true);
  });
  try {
    return await Promise.race([database.sql`select 1`.then(() => true, () => false), slow]);
  } finally {
    clearTimeout(timer);
  }
}

/** A tiny HTTP server for Docker's health check: GET /health answers 200 when healthy, 503 when not. */
export function serveHealth(port: number, host: string, check: () => Promise<{ ok: boolean } & Record<string, unknown>>) {
  const server = http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404).end();
      return;
    }
    check().then(
      (body) => response.writeHead(body.ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body)),
      () => response.writeHead(503).end(),
    );
  });
  server.on("error", (error) => console.error(`[worker] health check server: ${error.message}`));
  server.listen(port, host);
  server.unref();
}
