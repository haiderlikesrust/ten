// Real Postgres for local dev and tests, no Docker needed.
// Docker users can run `docker compose up -d` instead and set DATABASE_URL.
import fs from "node:fs";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";

export const PG_PORT = Number(process.env.PG_PORT ?? 54329);

export interface LocalPg {
  url: string;
  stop: () => Promise<void>;
}

export async function startPg(dir = path.resolve(".pg/dev"), port = PG_PORT): Promise<LocalPg> {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const fresh = !fs.existsSync(path.join(dir, "PG_VERSION"));
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "gemdex",
    password: "gemdex",
    port,
    persistent: true,
    // Windows defaults to WIN1252, which cannot store the emoji in real seller names.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase("gemdex");
  return {
    url: `postgres://gemdex:gemdex@127.0.0.1:${port}/gemdex`,
    stop: () => pg.stop(),
  };
}

if (process.argv[1]?.endsWith("pg.ts")) {
  const pg = await startPg();
  console.log(`postgres ready at ${pg.url}`);
  const shutdown = () => void pg.stop().then(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
