// One command for local dev: Postgres, gateway, worker and web, without Docker.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startPg } from "./pg";

const only = process.argv.slice(2);
const pg = await startPg();
const env = { ...process.env, DATABASE_URL: pg.url, GEMDEX_MODE: process.env.GEMDEX_MODE ?? "paper", FORCE_COLOR: "1" };

const envFile = path.resolve(".env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match) (env as Record<string, string>)[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
}

const children: ChildProcess[] = [];
function run(name: string, args: string[]) {
  const child = spawn("pnpm", args, { env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) console.log(`${name.padEnd(8)}| ${line}`);
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code) => console.log(`${name.padEnd(8)}| exited ${code}`));
  children.push(child);
}

const wants = (name: string) => only.length === 0 || only.includes(name);
if (wants("gateway")) run("gateway", ["--filter", "@gemdex/gateway", "dev"]);
if (wants("worker")) run("worker", ["--filter", "@gemdex/worker", "dev"]);
if (wants("web")) run("web", ["--filter", "@gemdex/web", "dev"]);

console.log(`\n  Gemdex is starting in ${env.GEMDEX_MODE} mode`);
console.log("  Web      http://localhost:3010");
console.log("  Gateway  http://localhost:4010\n");

const shutdown = () => {
  for (const child of children) child.kill();
  void pg.stop().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
