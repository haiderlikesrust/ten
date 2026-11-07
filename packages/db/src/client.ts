import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export interface Database {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
}

export const DEFAULT_DATABASE_URL = "postgres://gemdex:gemdex@127.0.0.1:54329/gemdex";

export function connect(url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL, opts: { max?: number } = {}): Database {
  const client = postgres(url, { max: opts.max ?? 20, onnotice: () => {}, idle_timeout: 60 });
  return { db: drizzle(client, { schema }), sql: client, close: () => client.end({ timeout: 5 }) };
}

export async function runMigrations(url = process.env.DATABASE_URL || DEFAULT_DATABASE_URL): Promise<void> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Gateway and worker both migrate on boot, so the lock makes them take turns.
  await client`select pg_advisory_lock(7270011)`;
  try {
    await migrate(drizzle(client), { migrationsFolder: path.resolve(here, "../migrations") });
  } finally {
    await client`select pg_advisory_unlock(7270011)`;
    await client.end({ timeout: 5 });
  }
}
