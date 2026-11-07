// Boots the real gateway and worker against live CC data on a temporary database,
// then checks the main paths over HTTP. Run with: pnpm smoke
import { spawn } from "node:child_process";
import { createTestDb } from "./testdb";

const PORT = 4011;
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS ?? 45_000);
const testDb = await createTestDb(4);
const env = { ...process.env, DATABASE_URL: testDb.pg.url, GEMDEX_MODE: "paper", GATEWAY_PORT: String(PORT) };

// Direct node processes, so kill() reaches exactly what this script started and nothing else.
const start = (file: string) => spawn(process.execPath, ["--import", "tsx", file], { env });
const procs = [start("apps/gateway/src/index.ts"), start("apps/worker/src/index.ts")];
for (const proc of procs) {
  proc.stdout.on("data", (d) => process.stdout.write(d));
  proc.stderr.on("data", (d) => {
    const text = String(d);
    if (!/punycode|trace-deprecation|bigint/.test(text)) process.stdout.write(text);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = `http://127.0.0.1:${PORT}`;

async function call(path: string, init?: RequestInit) {
  const res = await fetch(url + path, init);
  return { status: res.status, body: (await res.json()) as any };
}

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, detail);
  if (!ok) failed++;
}

try {
  await sleep(WAIT_MS);
  check("health", (await call("/health")).body.ok === true);

  const pulse = (await call("/pulse")).body;
  check("listings ingested", pulse.fresh.length > 10, pulse.fresh.length);
  check("below insured found", pulse.below.length > 0, pulse.below[0]?.name?.slice(0, 40));
  check("pulls ingested", pulse.pulls.length > 0, pulse.pulls.length);

  const machines = (await call("/machines")).body;
  check("machines ingested", machines.length > 20, machines.length);

  const auth = (await call("/auth/paper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "smoke" }) })).body;
  const headers = { "content-type": "application/json", authorization: `Bearer ${auth.token}` };
  const me = (await call("/me", { headers })).body;
  check("paper account funded", me.balance === 500_000_000, me.balance / 1e6);

  const drops = (await call("/drops")).body;
  check("scheduler running", drops.status?.pausedFor === null, JSON.stringify(drops.status));
  const hidden = drops.live.filter((d: any) => d.kind === "hidden");
  check("hidden cards stay secret", hidden.every((d: any) => d.card === null && d.nft === null && d.insuredValue === null), hidden.length);

  const open = await call("/orders/open", { method: "POST", headers, body: JSON.stringify({ machine: "pokemon_25", idempotencyKey: "smoke-1" }) });
  check("pack order accepted", open.status === 200, open.body);
  await sleep(5_000);
  const portfolio = (await call("/portfolio", { headers })).body;
  check("pulled card in portfolio", portfolio.held.length === 1, portfolio.held[0]?.card?.name);
  check("connected wallet receives pulls", portfolio.held[0]?.wallet === "connected");
  const after = (await call("/me", { headers })).body;
  check("paid for the pack", after.balance === 475_000_000, after.balance / 1e6);
} catch (error) {
  check("smoke run", false, error);
}

for (const proc of procs) proc.kill();
await sleep(800);
await testDb.shutdown();
console.log(failed === 0 ? "\nAll smoke checks passed" : `\n${failed} smoke checks failed`);
process.exit(failed === 0 ? 0 : 1);
