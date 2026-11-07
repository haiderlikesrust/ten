// A real, throwaway Postgres per test file. Row locks and races cannot be faked.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { connect, runMigrations, type Database } from "@gemdex/db";
import { startPg, type LocalPg } from "./pg";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface TestDb extends Database {
  pg: LocalPg;
  shutdown: () => Promise<void>;
}

export async function createTestDb(max = 40): Promise<TestDb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemdex-pg-"));
  const pg = await startPg(dir, await freePort());
  await runMigrations(pg.url);
  const database = connect(pg.url, { max });
  return {
    ...database,
    pg,
    shutdown: async () => {
      await database.close();
      await pg.stop();
      // Windows can hold the folder for a moment after Postgres stops. A leftover temp folder is harmless.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Nothing depends on this folder being gone.
      }
    },
  };
}
