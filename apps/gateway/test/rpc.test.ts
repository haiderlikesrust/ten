import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueSession } from "../src/auth";
import { rpcRoutes } from "../src/rpc";

/** A stand-in Solana RPC that records what reached it and answers every call. */
let upstream: Server;
const received: unknown[] = [];

async function appWith(rpcUrl: string | undefined): Promise<FastifyInstance> {
  if (rpcUrl) process.env.SOLANA_RPC_URL = rpcUrl;
  else delete process.env.SOLANA_RPC_URL;
  const app = Fastify();
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  rpcRoutes(app, { mode: "mainnet" });
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string };
      received.push(call);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: call.method === "sendTransaction" ? "sig123" : { value: 42 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  app = await appWith(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
});

afterAll(async () => {
  await app.close();
  await new Promise((resolve) => upstream.close(resolve));
  delete process.env.SOLANA_RPC_URL;
});

const call = (method: string, id = 1) => ({ jsonrpc: "2.0", id, method, params: [] });

describe("browser RPC proxy", () => {
  it("forwards an allowed read and passes the answer back", async () => {
    received.length = 0;
    const res = await app.inject({ method: "POST", url: "/rpc", payload: call("getBalance", 7) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { value: 42 } });
    expect(received).toHaveLength(1);
  });

  it("refuses methods outside the allowlist without reaching the RPC", async () => {
    received.length = 0;
    for (const method of ["requestAirdrop", "getProgramAccounts", "getLargestAccounts"]) {
      const res = await app.inject({ method: "POST", url: "/rpc", payload: call(method) });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { message: string } }).error.message).toContain(method);
    }
    // One bad call in a batch refuses the whole batch.
    const batch = await app.inject({ method: "POST", url: "/rpc", payload: [call("getBalance"), call("getProgramAccounts", 2)] });
    expect(batch.statusCode).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses malformed calls and oversized batches", async () => {
    expect((await app.inject({ method: "POST", url: "/rpc", payload: { id: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/rpc", payload: [] })).statusCode).toBe(400);
    const big = Array.from({ length: 11 }, (_, i) => call("getBalance", i));
    expect((await app.inject({ method: "POST", url: "/rpc", payload: big })).statusCode).toBe(400);
  });

  it("only sends a transaction for a signed-in user", async () => {
    received.length = 0;
    const anonymous = await app.inject({ method: "POST", url: "/rpc", payload: call("sendTransaction") });
    expect(anonymous.statusCode).toBe(401);
    expect(received).toHaveLength(0);

    const token = await issueSession("user-1");
    const signedIn = await app.inject({ method: "POST", url: "/rpc", headers: { authorization: `Bearer ${token}` }, payload: call("sendTransaction") });
    expect(signedIn.statusCode).toBe(200);
    expect((signedIn.json() as { result: string }).result).toBe("sig123");
    expect(received).toHaveLength(1);
  });

  it("says so when the server has no RPC", async () => {
    const bare = await appWith(undefined);
    const res = await bare.inject({ method: "POST", url: "/rpc", payload: call("getBalance") });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { message: string } }).error.message).toMatch(/no Solana RPC/);
    await bare.close();
  });
});
