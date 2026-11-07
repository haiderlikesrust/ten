// Checks the zero-downtime hand-over the way Dokploy runs an update: the new container starts first,
// then the old one is told to stop. Boots real workers and a gateway on a temporary database.
// Run with: pnpm handover
import { spawn, type ChildProcess } from "node:child_process";
import { createTestDb } from "./testdb";

const testDb = await createTestDb(4);
const base = { ...process.env, DATABASE_URL: testDb.pg.url, GEMDEX_MODE: "paper" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const started: ChildProcess[] = [];
let failed = 0;

function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}

/** Direct node processes with an IPC channel, so "shutdown" reaches exactly what this script started. */
function start(name: string, file: string, env: Record<string, string>) {
  const proc = spawn(process.execPath, ["--import", "tsx", file], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = new Promise<number | null>((resolve) => proc.on("exit", resolve));
  const print = (data: Buffer) => {
    for (const line of String(data).split("\n")) if (line.trim() && !/punycode|trace-deprecation|bigint/.test(line)) console.log(`  ${name} | ${line}`);
  };
  proc.stdout?.on("data", print);
  proc.stderr?.on("data", print);
  started.push(proc);
  return { proc, exited };
}

async function health(port: number): Promise<{ status: number; state?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    return { status: res.status, ...((await res.json()) as { state?: string }) };
  } catch {
    return { status: 0 };
  }
}

async function waitFor<T>(what: () => Promise<T>, until: (value: T) => boolean, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await what();
    if (until(value)) return value;
    await sleep(100);
  }
  return null;
}

try {
  // Workers --------------------------------------------------------------------
  const A = start("worker A", "apps/worker/src/index.ts", { WORKER_HEALTH_PORT: "4921" });
  const aActive = await waitFor(() => health(4921), (h) => h.state === "active", 90_000);
  check(aActive !== null, "the first worker becomes active");

  const B = start("worker B", "apps/worker/src/index.ts", { WORKER_HEALTH_PORT: "4922" });
  const bStandby = await waitFor(() => health(4922), (h) => h.state === "standby", 60_000);
  check(bStandby?.status === 200, "the second worker waits as a healthy standby", `HTTP ${bStandby?.status}`);

  // Both running for a while: only one may be active at any moment.
  let both = 0;
  for (let i = 0; i < 20; i++) {
    const [a, b] = await Promise.all([health(4921), health(4922)]);
    if (a.state === "active" && b.state === "active") both++;
    await sleep(100);
  }
  check(both === 0, "never two active workers", `${both} overlaps in 20 samples`);

  const stopAt = Date.now();
  A.proc.send("shutdown");
  const bActive = await waitFor(() => health(4922), (h) => h.state === "active", 15_000);
  const takeover = Date.now() - stopAt;
  check(bActive !== null, "the standby takes over when the old worker stops", `${takeover} ms after the stop`);
  check(takeover < 10_000, "the hand-over fits inside Docker's 10-second stop grace");
  const aCode = await Promise.race([A.exited, sleep(10_000).then(() => "still running")]);
  check(aCode === 0, "the old worker exits cleanly", `exit ${aCode}`);

  B.proc.send("shutdown");
  check((await Promise.race([B.exited, sleep(15_000).then(() => "still running")])) === 0, "the last worker exits cleanly");

  // Gateway --------------------------------------------------------------------
  const G = start("gateway", "apps/gateway/src/index.ts", { GATEWAY_PORT: "4931", DRAIN_DELAY_MS: "1500" });
  const up = await waitFor(() => health(4931), (h) => h.status === 200, 60_000);
  check(up !== null, "the gateway reports healthy");

  const ws = new WebSocket("ws://127.0.0.1:4931/stream");
  const opened = new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  const closed = new Promise<number>((resolve) => {
    ws.onclose = (event) => resolve(event.code);
  });
  check(await opened, "a browser stream connects");

  G.proc.send("shutdown");
  await sleep(300);
  const draining = await health(4931);
  check(draining.status === 503, "while stopping, the health check fails so traffic moves away", `HTTP ${draining.status}`);
  const meta = await fetch("http://127.0.0.1:4931/meta").then((r) => r.status, () => 0);
  check(meta === 200, "while stopping, requests still get answers", `HTTP ${meta}`);
  const code = await Promise.race([closed, sleep(10_000).then(() => -1)]);
  check(code === 1012, "the stream closes with 1012, so the browser reconnects at once", `code ${code}`);
  check((await Promise.race([G.exited, sleep(10_000).then(() => "still running")])) === 0, "the gateway exits cleanly");
} finally {
  for (const proc of started) if (proc.exitCode === null) proc.kill();
  await testDb.shutdown();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll hand-over checks passed");
process.exit(failed ? 1 : 0);
