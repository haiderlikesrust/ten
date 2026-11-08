// Collector Crypt packs and sell-backs against the real adapter, with CC and the RPC mocked.
// Nothing here touches a network: an unexpected fetch fails the test.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountLayout, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { LocalSigner } from "../src/signers";
import { buildSolanaVenue, validatePackPayment, type PackIntent } from "../src/solana";
import { AddressBlocked, CC_DEVNET, MachineDown, TxRefused, role, type CcEndpoints, type PaidPack } from "../src/index";

const USDC = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PRICE = 25_000_000;
const MEMO = "pokemon_25-3f1c2a9e-1b2c-4d5e-8f90-123456789abc";
const cc = Keypair.generate();
const signer = new LocalSigner("cc-test");
const blockhash = Keypair.generate().publicKey.toBase58();
const ENDPOINTS: CcEndpoints = { ...CC_DEVNET, paymentWallet: cc.publicKey.toBase58() };

let player: PublicKey;
let vault: PublicKey;
beforeAll(async () => {
  player = await signer.addressOf(role("drops"));
  vault = await signer.addressOf(role("vault"));
});

/** CC's pack transaction as the spike decoded it: legacy, CC pays the fee and signs first. */
function packTx(opts: { amount?: number; to?: PublicKey; memo?: string; extraSigner?: PublicKey; microLamports?: number } = {}) {
  const to = opts.to ?? cc.publicKey;
  const ccAta = getAssociatedTokenAddressSync(USDC, to, true);
  const tx = new Transaction({ feePayer: cc.publicKey, blockhash, lastValidBlockHeight: 1 });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.microLamports ?? 10_000 }));
  tx.add(createAssociatedTokenAccountIdempotentInstruction(cc.publicKey, ccAta, to, USDC));
  tx.add(createTransferCheckedInstruction(getAssociatedTokenAddressSync(USDC, player, true), USDC, ccAta, player, opts.amount ?? PRICE, 6));
  const memoKeys = [{ pubkey: player, isSigner: true, isWritable: false }, ...(opts.extraSigner ? [{ pubkey: opts.extraSigner, isSigner: true, isWritable: false }] : [])];
  tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: memoKeys, data: Buffer.from(`${opts.memo ?? MEMO}:open`) }));
  tx.partialSign(cc);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

const unsigned = (b64: string) => VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
const intent = (over: Partial<PackIntent> = {}): PackIntent => ({ player, wallet: cc.publicKey, mint: USDC, amount: BigInt(PRICE), memo: MEMO, ...over });

function fakeRpc(over: Record<string, unknown> = {}) {
  return {
    rpcEndpoint: "http://127.0.0.1:1",
    isBlockhashValid: vi.fn(async () => ({ value: true })),
    simulateTransaction: vi.fn(async () => ({ value: { err: null } })),
    getSignatureStatuses: vi.fn(async () => ({ value: [null] })),
    getTransaction: vi.fn(async () => null),
    sendRawTransaction: vi.fn(async () => "sent"),
    getMultipleAccountsInfo: vi.fn(async () => []),
    ...over,
  };
}

type Reply = { status?: number; json?: unknown } | (() => never);
type Call = { path: string; body?: Record<string, unknown>; headers: Record<string, string> };

/** A scripted CC. Routes are keyed by path after /api/; anything else is a 404. */
function fakeCc(routes: Record<string, (body: Record<string, unknown> | undefined) => Reply>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\//, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[path];
    if (!route) return new Response("{}", { status: 404 });
    const reply = route(body);
    if (typeof reply === "function") return reply();
    return new Response(JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls, hits: (path: string) => calls.filter((c) => c.path === path).length };
}

function venueWith(rpc: ReturnType<typeof fakeRpc>, fetchImpl?: typeof fetch, extra: { endpoints?: CcEndpoints; ccApiKey?: string } = {}) {
  return buildSolanaVenue(
    { mode: "devnet", connection: rpc as unknown as Connection, signer, db: {} as never, endpoints: extra.endpoints ?? ENDPOINTS, fetchImpl, ccApiKey: extra.ccApiKey },
    { drops: "", vault: "", cashback: "", fee: "", feePayer: "" },
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("tests must not reach the network");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pack policy", () => {
  it("passes a correct pack and refuses a wrong amount, destination, memo or extra signer", async () => {
    const good = intent();
    expect(() => validatePackPayment(unsigned(packTx()), good)).not.toThrow();
    expect(() => validatePackPayment(unsigned(packTx({ amount: PRICE + 1 })), good)).toThrow(TxRefused);
    expect(() => validatePackPayment(unsigned(packTx({ amount: PRICE + 1 })), good)).toThrow(/amount/);
    expect(() => validatePackPayment(unsigned(packTx({ to: Keypair.generate().publicKey })), good)).toThrow(TxRefused);
    expect(() => validatePackPayment(unsigned(packTx({ memo: "pokemon_25-00000000-1b2c-4d5e-8f90-123456789abc" })), good)).toThrow(/memo/);
    expect(() => validatePackPayment(unsigned(packTx({ extraSigner: Keypair.generate().publicKey })), good)).toThrow(/signer/);
    // 60k units at 20 lamports each is 0.0012 SOL of priority fee: over the 0.001 cap.
    expect(() => validatePackPayment(unsigned(packTx({ microLamports: 20_000_000 })), good)).toThrow(/fee/);
  });

  it("refuses a pack CC has not really signed", async () => {
    const tx = unsigned(packTx());
    tx.signatures[0] = new Uint8Array(64).fill(9);
    expect(() => validatePackPayment(tx, intent())).toThrow(/signature/);
  });

  it("skips only the destination check while CC's payment wallet is unknown", async () => {
    const unknown = intent({ wallet: null });
    expect(() => validatePackPayment(unsigned(packTx({ to: Keypair.generate().publicKey })), unknown)).not.toThrow();
    expect(() => validatePackPayment(unsigned(packTx({ amount: PRICE * 2 })), unknown)).toThrow(/amount/);
    expect(() => validatePackPayment(unsigned(packTx({ extraSigner: Keypair.generate().publicKey })), unknown)).toThrow(/signer/);
  });
});

describe("signing CC's pack", () => {
  const op = async () => ({ type: "ccPack" as const, payer: role("drops"), amount: PRICE, memo: MEMO, raw: packTx() });

  it("signs, keeps CC's signature as the id, records the blockhash and simulates with signatures checked", async () => {
    const rpc = fakeRpc();
    const raw = packTx();
    const prepared = await venueWith(rpc).chain.prepare({ ...(await op()), raw });
    const envelope = JSON.parse(prepared.raw) as { via: string; b64: string; blockhash: string; signature: string };
    expect(envelope.via).toBe("gacha");
    expect(envelope.blockhash).toBe(blockhash);
    expect(prepared.signature).toBe(bs58.encode(Transaction.from(Buffer.from(raw, "base64")).signature!));
    expect(Transaction.from(Buffer.from(envelope.b64, "base64")).verifySignatures()).toBe(true);
    expect(rpc.simulateTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sigVerify: true }));
  });

  it("refuses to sign once the blockhash has died, so dead bytes are never signed again", async () => {
    const rpc = fakeRpc({ isBlockhashValid: vi.fn(async () => ({ value: false })) });
    const sign = vi.spyOn(signer, "sign");
    await expect(venueWith(rpc).chain.prepare(await op())).rejects.toThrow(TxRefused);
    expect(sign).not.toHaveBeenCalled();
  });

  it("refuses a pack that pays the wrong amount before anything is signed", async () => {
    const sign = vi.spyOn(signer, "sign");
    await expect(venueWith(fakeRpc()).chain.prepare({ ...(await op()), amount: PRICE * 2 })).rejects.toThrow(TxRefused);
    expect(sign).not.toHaveBeenCalled();
  });
});

describe("confirmation", () => {
  const raw = JSON.stringify({ via: "gacha", b64: "", signature: "sig", blockhash });

  it("is final only at confirmed or finalized", async () => {
    const at = (confirmationStatus: string, err: unknown) => fakeRpc({ getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus, err }] })) });
    expect(await venueWith(at("processed", { InstructionError: [0, "x"] })).chain.status("sig", raw)).toBe("pending");
    expect(await venueWith(at("confirmed", { InstructionError: [0, "x"] })).chain.status("sig", raw)).toBe("failed");
    expect(await venueWith(at("finalized", null)).chain.status("sig", raw)).toBe("confirmed");
  });

  it("calls an expired payment dead only after history is empty twice, a minute apart", async () => {
    const rpc = fakeRpc({ isBlockhashValid: vi.fn(async () => ({ value: false })) });
    const chain = venueWith(rpc).chain;
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    expect(await chain.status("sig", raw)).toBe("pending");
    now.mockReturnValue(1_030_000);
    expect(await chain.status("sig", raw)).toBe("pending");
    now.mockReturnValue(1_061_000);
    expect(await chain.status("sig", raw)).toBe("dead");
    expect(rpc.getTransaction).toHaveBeenCalledWith("sig", expect.objectContaining({ commitment: "confirmed" }));
  });

  it("an expired payment that history shows landed is confirmed, not dead", async () => {
    const rpc = fakeRpc({ isBlockhashValid: vi.fn(async () => ({ value: false })), getTransaction: vi.fn(async () => ({ meta: { err: null } })) });
    expect(await venueWith(rpc).chain.status("sig", raw)).toBe("confirmed");
  });
});

describe("submitting through CC", () => {
  const envelope = JSON.stringify({ via: "gacha", b64: Buffer.from("signed").toString("base64"), signature: "sig", blockhash });

  it("falls back to a checked RPC send when CC does not accept it", async () => {
    for (const reply of [{ json: { success: false } }, { status: 500, json: {} }, () => { throw new Error("network down"); }] as Reply[]) {
      const rpc = fakeRpc();
      const api = fakeCc({ submitTransaction: () => reply });
      await venueWith(rpc, api.fetchImpl, { ccApiKey: "key" }).chain.send(envelope);
      expect(rpc.sendRawTransaction).toHaveBeenCalledWith(Buffer.from("signed"), { skipPreflight: false, maxRetries: 2 });
      expect(api.calls[0]!.headers["x-api-key"]).toBe("key");
    }
  });

  it("sends nothing else when CC accepts it, or when the network already has it", async () => {
    const rpc = fakeRpc();
    await venueWith(rpc, fakeCc({ submitTransaction: () => ({ json: { success: true, signature: "sig", confirmationStatus: "confirmed" } }) }).fetchImpl).chain.send(envelope);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();

    const seen = fakeRpc({ getSignatureStatuses: vi.fn(async () => ({ value: [{ confirmationStatus: "processed", err: null }] })) });
    const api = fakeCc({ submitTransaction: () => ({ json: { success: true, signature: "sig" } }) });
    await venueWith(seen, api.fetchImpl).chain.send(envelope);
    expect(api.calls).toHaveLength(0);
  });
});

describe("generating a pack", () => {
  const catalog = (price = 25) => () => ({ json: { machines: [{ code: "pokemon_25", price }] } });
  const generate = (api: ReturnType<typeof fakeCc>) =>
    venueWith(fakeRpc(), api.fetchImpl).gacha.generate({ machine: "pokemon_25", price: PRICE, player: role("drops"), deliverTo: Keypair.generate().publicKey.toBase58(), turbo: true });

  it("treats a rate limit as retryable, never as a machine that is down", async () => {
    const error = await generate(fakeCc({ machines: catalog(), generatePack: () => ({ status: 429, json: { error: "Too many requests" } }) })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MachineDown);
    expect(error).not.toBeInstanceOf(AddressBlocked);
  });

  it("knows CC's own machine-off message, a blocked address, and a changed price", async () => {
    await expect(generate(fakeCc({ machines: catalog(), generatePack: () => ({ status: 400, json: { error: "Machine is off" } }) }))).rejects.toThrow(MachineDown);
    await expect(generate(fakeCc({ machines: catalog(), generatePack: () => ({ status: 400, json: { details: "Machine is off balance" } }) }))).rejects.toThrow(MachineDown);
    await expect(generate(fakeCc({ machines: catalog(), generatePack: () => ({ status: 403 }) }))).rejects.toThrow(AddressBlocked);
    const repriced = fakeCc({ machines: catalog(50), generatePack: () => ({ json: { memo: MEMO, transaction: "x" } }) });
    await expect(generate(repriced)).rejects.toThrow(MachineDown);
    expect(repriced.hits("generatePack")).toBe(0);
  });

  it("checks the order's fields and never asks for Turbo", async () => {
    await expect(generate(fakeCc({ machines: catalog(), generatePack: () => ({ json: { memo: 7, transaction: "x" } }) }))).rejects.toThrow(/invalid pack order/);
    const api = fakeCc({ machines: catalog(), generatePack: () => ({ json: { memo: MEMO, transaction: "tx" } }) });
    expect(await generate(api)).toEqual({ memo: MEMO, raw: "tx", turbo: false });
    expect(api.calls.find((c) => c.path === "generatePack")!.body!.turbo).toBe(false);
  });
});

describe("opening a paid pack", () => {
  const nft = Keypair.generate().publicKey.toBase58();
  const deliverTo = Keypair.generate().publicKey.toBase58();
  let paid: PaidPack;
  let pack: Record<string, unknown>;
  let send: Record<string, unknown> | null;
  let opened: Record<string, unknown>;

  beforeEach(async () => {
    paid = { memo: MEMO, machine: "pokemon_25", payer: role("drops"), deliverTo, turbo: false, signature: "PaySig" };
    pack = { status: "confirmed", refunded: false, wallet: player.toBase58(), pack_type: "pokemon_25", transaction_signature: "PaySig" };
    send = null;
    opened = {
      nft_address: nft, rarity: "Rare", roll: 4242,
      nftWon: { content: { metadata: { name: "2020 Pokemon Charizard Holo Fi", json_name: "2020 Pokemon Charizard Holo First Edition", attributes: [{ trait_type: "Insured Value", value: "$30" }] } } },
    };
  });

  const api = () => fakeCc({ "pack/status": () => ({ json: { pack, ...(send ? { send } : {}) } }), openPack: () => ({ json: opened }) });
  const gachaWith = (cc: ReturnType<typeof fakeCc>) => venueWith(fakeRpc(), cc.fetchImpl).gacha;

  it("waits while CC has not seen the payment, and reports a refund that arrives mid-wait", async () => {
    pack = { ...pack, status: "pending" };
    const cc = api();
    const gacha = gachaWith(cc);
    expect(await gacha.open(paid)).toEqual({ status: "waiting" });
    pack = { ...pack, refunded: true };
    expect(await gacha.open(paid)).toEqual({ status: "refunded" });
    expect(cc.hits("openPack")).toBe(0);
  });

  it("asks CC to open an unregistered pack after 30 seconds, at most once a minute", async () => {
    pack = { ...pack, status: "pending" };
    const cc = api();
    const gacha = gachaWith(cc);
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    await gacha.open(paid);
    now.mockReturnValue(5_031_000);
    await gacha.open(paid);
    now.mockReturnValue(5_060_000);
    await gacha.open(paid);
    expect(cc.hits("openPack")).toBe(1);
    now.mockReturnValue(5_092_000);
    await gacha.open(paid);
    expect(cc.hits("openPack")).toBe(2);
  });

  it("treats SEND_PENDING like WAITING_FOR_WEBHOOK", async () => {
    for (const code of ["SEND_PENDING", "WAITING_FOR_WEBHOOK"]) {
      opened = { code };
      expect(await gachaWith(api()).open(paid)).toEqual({ status: "waiting" });
    }
  });

  it("waits until the delivery itself is confirmed", async () => {
    send = { status: "pending", nft_address: nft, to_wallet: deliverTo };
    expect(await gachaWith(api()).open(paid)).toEqual({ status: "waiting" });
  });

  it("refuses a pull with no valid card, a delivery elsewhere, a record that is not our payment, or Turbo nobody asked for", async () => {
    send = { status: "confirmed", nft_address: nft, to_wallet: deliverTo };
    opened = { ...opened, nft_address: undefined };
    await expect(gachaWith(api()).open(paid)).rejects.toThrow(/no valid card/);
    opened = { ...opened, nft_address: "not-a-key" };
    await expect(gachaWith(api()).open(paid)).rejects.toThrow(/no valid card/);

    opened = { ...opened, nft_address: nft };
    send = { status: "confirmed", nft_address: nft, to_wallet: Keypair.generate().publicKey.toBase58() };
    await expect(gachaWith(api()).open(paid)).rejects.toThrow(/does not match/);

    send = { status: "confirmed", nft_address: nft, to_wallet: deliverTo };
    pack = { ...pack, transaction_signature: "SomeoneElse" };
    await expect(gachaWith(api()).open(paid)).rejects.toThrow(/does not match the payment/);

    pack = { ...pack, transaction_signature: "PaySig" };
    opened = { code: "TURBO_MODE_BUYBACK", buybackAmount: 12_000_000 };
    await expect(gachaWith(api()).open(paid)).rejects.toThrow(/Turbo/);
  });

  it("opens once delivery to the agreed wallet is confirmed, with CC's value, tier and full name", async () => {
    send = { status: "confirmed", nft_address: nft, to_wallet: deliverTo, insured_value: "$42.50", prize_tier: 2 };
    const result = await gachaWith(api()).open(paid);
    expect(result).toMatchObject({ status: "opened", nft, rarity: "rare", insuredValue: 42_500_000, roll: 4242, turboBuyback: null });
    expect(result.status === "opened" && result.card.name).toBe("2020 Pokemon Charizard Holo First Edition");
  });

  it("never reads a blank or zero value as a $0 card", async () => {
    send = { status: "confirmed", nft_address: nft, to_wallet: deliverTo, insured_value: "0" };
    expect(await gachaWith(api()).open(paid)).toMatchObject({ insuredValue: 30_000_000 });
    opened = { ...opened, rarity: undefined, nftWon: {} };
    send = { status: "confirmed", nft_address: nft, to_wallet: deliverTo, insured_value: "" };
    expect(await gachaWith(api()).open(paid)).toMatchObject({ insuredValue: null, rarity: null });
  });
});

describe("sell-back", () => {
  const nft = Keypair.generate().publicKey.toBase58();

  it("a quote that is not a clean 200 throws instead of reading as a closed window", async () => {
    const gacha = (reply: Reply) => venueWith(fakeRpc(), fakeCc({ "buyback/available": () => reply }).fetchImpl).gacha;
    await expect(gacha({ status: 429, json: { error: "slow down" } }).buybackQuote(nft)).rejects.toThrow(/429/);
    await expect(gacha({ json: { available: true, amount: 5 } }).buybackQuote(nft)).rejects.toThrow(/invalid buyback quote/);
    await expect(gacha({ json: { available: "yes", amount: 20_000_000 } }).buybackQuote(nft)).rejects.toThrow(/invalid buyback quote/);
    expect(await gacha({ json: { available: false } }).buybackQuote(nft)).toEqual({ available: false, amount: 0, expiresAt: null });
    expect(await gacha({ json: { available: true, amount: 20_000_000, buybackExpiresAt: "2026-11-10T00:00:00Z" } }).buybackQuote(nft)).toEqual({
      available: true, amount: 20_000_000, expiresAt: new Date("2026-11-10T00:00:00Z"),
    });
  });

  const tokenAccount = (owner: PublicKey, amount: bigint) => {
    const data = Buffer.alloc(165);
    AccountLayout.encode({
      mint: USDC, owner, amount, delegateOption: 0, delegate: PublicKey.default, state: 1 as never, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n,
      closeAuthorityOption: 0, closeAuthority: PublicKey.default,
    }, data);
    return data;
  };

  function saleTx(version: "v0" | "legacy") {
    const ix = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: vault, isSigner: true, isWritable: false }], data: Buffer.from("buyback") });
    if (version === "legacy") {
      const tx = new Transaction({ feePayer: cc.publicKey, blockhash, lastValidBlockHeight: 1 }).add(ix);
      tx.partialSign(cc);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    }
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: cc.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    tx.sign([cc]);
    return Buffer.from(tx.serialize()).toString("base64");
  }

  async function sell(received: bigint, version: "v0" | "legacy" = "v0") {
    const drops = player;
    const rpc = fakeRpc({
      getMultipleAccountsInfo: vi.fn(async () => [{ lamports: 1_000_000_000, data: Buffer.alloc(0) }, { lamports: 0, data: tokenAccount(vault, 0n) }, { lamports: 0, data: tokenAccount(drops, 5n) }]),
      simulateTransaction: vi.fn(async () => ({
        value: {
          err: null,
          accounts: [
            { lamports: 999_995_000, data: ["", "base64"] },
            { lamports: 0, data: [tokenAccount(vault, 0n).toString("base64"), "base64"] },
            { lamports: 0, data: [tokenAccount(drops, 5n + received).toString("base64"), "base64"] },
          ],
        },
      })),
    });
    return venueWith(rpc).chain.prepare({ type: "ccBuyback", owner: role("vault"), recipient: role("drops"), nft, amount: 20_000_000, raw: saleTx(version) });
  }

  it("signs a sale that pays at least the quote, and refuses one that pays less or is not v0", async () => {
    expect((await sell(20_000_000n)).signature).toBeTruthy();
    await expect(sell(19_999_999n)).rejects.toThrow(/less than CC quoted/);
    await expect(sell(20_000_000n, "legacy")).rejects.toThrow(TxRefused);
  });
});
