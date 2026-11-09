import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startPg, type LocalPg } from "./pg";

const root = process.cwd();
const out = path.join(root, ".chart-check");
fs.mkdirSync(out, { recursive: true });
const children: ChildProcess[] = [];
let pg: LocalPg | null = null;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url: string, timeout = 90_000) {
  const end = Date.now() + timeout;
  let last = "";
  while (Date.now() < end) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status}`;
    } catch (error) { last = error instanceof Error ? error.message : String(error); }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const log = (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) console.log(`${name}: ${text.slice(-1000)}`);
  };
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  children.push(child);
}

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  errors: string[] = [];
  missing: string[] = [];
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        if (message.method === "Runtime.exceptionThrown") this.errors.push(message.params.exceptionDetails?.text ?? "Runtime exception");
        if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") this.errors.push(message.params.args?.map((arg: any) => arg.value ?? arg.description ?? "").join(" "));
        if (message.method === "Network.responseReceived" && message.params.response.status === 404) this.missing.push(message.params.response.url);
      }
    };
  }
  async open() {
    await new Promise<void>((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = () => reject(new Error("Browser connection failed"));
    });
  }
  send(method: string, params: Record<string, unknown> = {}) {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string) {
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    return result.result.value;
  }
  close() { this.socket.close(); }
}

async function screenshot(cdp: Cdp, name: string) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(out, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  console.log(`screenshot: ${file}`);
}

async function waitText(cdp: Cdp, text: string, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await cdp.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)})`)) return;
    await sleep(400);
  }
  throw new Error(`Text not found: ${text}`);
}

async function waitChart(cdp: Cdp) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) {
    if (await cdp.evaluate(`!!document.querySelector('[aria-label^="Live"][aria-label*="price chart"] canvas')`)) return;
    await sleep(400);
  }
  throw new Error("Chart canvas not found");
}

let cdp: Cdp | null = null;
try {
  pg = await startPg(path.join(root, ".pg/chart-check"), 54431);
  const env = { ...process.env, DATABASE_URL: pg.url, GEMDEX_MODE: "paper", NEXT_TELEMETRY_DISABLED: "1" };
  run([path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"], path.join(root, "apps/gateway"), env, "gateway");
  run([path.join(root, "node_modules/tsx/dist/cli.mjs"), "src/index.ts"], path.join(root, "apps/worker"), env, "worker");
  run([path.join(root, "apps/web/node_modules/next/dist/bin/next"), "start", "-p", "3010"], path.join(root, "apps/web"), env, "web");
  await waitFor("http://127.0.0.1:3010");

  const browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
    "--headless=new", "--remote-debugging-port=9223", `--user-data-dir=${path.join(out, "browser")}`,
    "--no-first-run", "--disable-gpu", "--hide-scrollbars", "about:blank",
  ], { stdio: "ignore", windowsHide: true });
  children.push(browser);
  await waitFor("http://127.0.0.1:9223/json/version");
  const targets = await (await fetch("http://127.0.0.1:9223/json/list")).json();
  const page = targets.find((target: any) => target.type === "page");
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:3010/" });
  await waitText(cdp, "New Pulls");
  await sleep(5000);
  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Skip tour")?.click()`);

  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Connect")?.click()`);
  await waitText(cdp, "Start paper trading");
  await cdp.evaluate(`document.querySelector('input[aria-label="Display name"]')?.focus()`);
  await cdp.send("Input.insertText", { text: "ChartCheck" });
  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Start trading")?.click()`);
  await sleep(1200);
  const href = await cdp.evaluate(`document.querySelector('a[href^="/live/"]')?.href`);
  if (!href) throw new Error("No live card link found");
  await cdp.send("Page.navigate", { url: href });
  await waitChart(cdp);
  await sleep(1200);
  console.log("desktop:", JSON.stringify(await cdp.evaluate(`({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    candles: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    insured: document.body.innerText.includes("Insured"),
    updating: document.body.innerText.includes("Live") || document.body.innerText.includes("Updating")
  })`)));
  await screenshot(cdp, "desktop-candles");

  await cdp.evaluate(`[...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === "Line")?.click()`);
  await sleep(600);
  console.log("lineMode:", await cdp.evaluate(`!!document.querySelector('[aria-label^="Live line price chart"]')`));
  await screenshot(cdp, "desktop-line");

  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "-10%")?.click()`);
  console.log("limitInput:", await cdp.evaluate(`document.querySelector('input[aria-label="Limit price"]')?.value`));
  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Set")?.click()`);
  await waitText(cdp, "Limit order open", 10_000);
  console.log("limitSet:", true);
  await cdp.evaluate(`document.querySelector('button[aria-label="Cancel limit order"]')?.click()`);
  await waitText(cdp, "Limit order cancelled", 10_000);
  console.log("limitCancelled:", true);

  for (const width of [768, 1024]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    console.log(`breakpoint${width}:`, JSON.stringify(await cdp.evaluate(`({ viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth })`)));
  }

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitChart(cdp);
  await sleep(1000);
  console.log("mobile:", JSON.stringify(await cdp.evaluate(`({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    line: !!document.querySelector('[aria-label^="Live line price chart"]'),
    lock: document.body.innerText.includes("Locks in"),
    smallControls: [...document.querySelectorAll("button")].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44);
    }).map((node) => node.getAttribute("aria-label") || node.textContent?.trim()).slice(0, 20)
  })`)));
  await screenshot(cdp, "mobile-chart");
  await cdp.evaluate(`[...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Limit")?.click()`);
  await waitText(cdp, "Quick limit prices", 5000).catch(() => {});
  console.log("mobileLimit:", await cdp.evaluate(`!!document.querySelector('[role="dialog"][aria-label="Limit order"]')`));
  await screenshot(cdp, "mobile-limit");

  console.log("consoleErrors:", JSON.stringify(cdp.errors));
  console.log("notFound:", JSON.stringify([...new Set(cdp.missing)]));
  if (cdp.errors.length || cdp.missing.length) throw new Error("Browser release gate failed");
} finally {
  cdp?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
  if (pg) await pg.stop();
}
