"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Wallet } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { Button, Empty, Field, PageHeader, Pill, SectionTitle, Skeleton, StatTile, Toggle, inputClass } from "@/components/bits";
import { api } from "@/lib/api";
import { ago, money } from "@/lib/format";
import { useMe, useMeta } from "@/lib/session";
import type { ActivityRow } from "@/lib/types";
import { useNow, useUi } from "@/lib/ui";

const signed = (micros: number) => `${micros >= 0 ? "+" : "-"}${money(Math.abs(micros))}`;

/** Every deposit, buy, refund and payout that moved this wallet, newest first. */
function MoneyLog() {
  const now = useNow();
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => api<ActivityRow[]>("/activity"), refetchInterval: 20_000 });
  const rows = (activity.data ?? []).filter((row) => row.delta !== 0);
  const moneyIn = rows.filter((row) => row.delta > 0).reduce((sum, row) => sum + row.delta, 0);
  const moneyOut = rows.filter((row) => row.delta < 0).reduce((sum, row) => sum - row.delta, 0);
  return (
    <section className="slab flex min-w-0 flex-col self-start xl:max-h-[calc(100dvh-236px)]" aria-label="Money in and out">
      <SectionTitle right={rows.length ? <span className="num text-[12.5px]"><span className="text-teal">+{money(moneyIn, true)}</span> <span className="text-faint">/</span> <span className="text-mute">-{money(moneyOut, true)}</span></span> : null}>Money in and out</SectionTitle>
      {activity.isLoading ? <Skeleton rows={5} /> : rows.length === 0 ? (
        <p className="px-3.5 pb-3.5 text-[13.5px] text-faint">Deposits, buys, refunds and cashback show up here.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {rows.map((row) => (
            <li key={row.id} className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 px-cut px-2 py-1.5 hover:bg-raised">
              <span className="num text-[12.5px] text-faint">{ago(row.at, now)}</span>
              <span className="truncate text-[13.5px]">{row.title}</span>
              <span className={`num text-[13.5px] font-medium ${row.delta > 0 ? "text-teal" : "text-mute"}`}>{signed(row.delta)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CopyButton({ value }: { value: string }) {
  const toast = useUi((s) => s.toast);
  return (
    <Button onClick={() => void navigator.clipboard.writeText(value).then(() => toast({ tone: "ok", title: "Copied" }))}>
      <Copy size={15} aria-hidden="true" /> Copy address
    </Button>
  );
}

export default function WalletPage() {
  const me = useMe();
  const meta = useMeta();
  const client = useQueryClient();
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const toast = useUi((s) => s.toast);
  const [limit, setLimit] = useState("");
  const [forward, setForward] = useState(false);
  const [withdrawTo, setWithdrawTo] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const wallet = useUi((s) => s.wallet);

  useEffect(() => {
    if (!me) return;
    setLimit(me.settings.tradeLimitUsd ? String(me.settings.tradeLimitUsd) : "");
    setForward(!!me.settings.autoForward);
  }, [me?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const faucet = useMutation({
    mutationFn: () => api("/wallet/faucet", { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      toast({ tone: "ok", title: "Added $100 of paper USDC" });
    },
  });
  const save = useMutation({
    mutationFn: () =>
      api("/me/settings", {
        method: "PATCH",
        body: {
          tradeLimitUsd: limit ? Number(limit) : undefined,
          autoForward: forward,
        },
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["me"] });
      toast({ tone: "ok", title: "Saved" });
    },
  });

  if (!me) {
    return (
      <Empty title="No wallet connected" icon={<Wallet size={22} aria-hidden="true" />}>
        <p>Connect to get a trading wallet for one-click sniping.</p>
        <div className="mt-3"><Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button></div>
      </Empty>
    );
  }

  const paper = meta.data?.paper;
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1360px] flex flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader title="Trading wallet" subtitle="Pays for Pulse and marketplace buys in one click. Keep only what you plan to trade in it." />

        <section className="grid grid-cols-3 gap-2">
          <StatTile label="Available" value={money(me.available)} tone="good" />
          <StatTile label="On hold" value={money(me.held)} />
          <StatTile label="Total" value={money(me.balance)} />
        </section>
        {me.strikes > 0 ? <p className="px-cut bg-loss/12 px-4 py-3 font-medium text-loss">{me.strikes} failed settlement{me.strikes > 1 ? "s" : ""} on this account. Keep your balance funded while a snipe settles.</p> : null}

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          <section className="slab min-w-0 self-start">
            <SectionTitle right={<Pill>Solana USDC only</Pill>}>Deposit</SectionTitle>
            <div className="flex flex-col items-center gap-3 p-4 pt-1">
              <div className="px-cut bg-white p-3.5"><QRCodeSVG value={me.tradingWallet} size={156} /></div>
              <div className="num w-full break-all px-cut bg-raised p-2.5 text-center text-[13px]">{me.tradingWallet}</div>
              <div className="flex flex-wrap justify-center gap-2">
                <CopyButton value={me.tradingWallet} />
                {paper ? <Button tone="snipe" disabled={faucet.isPending} onClick={() => faucet.mutate()}>Add <span className="num text-[15px] font-bold">$100</span> paper USDC</Button> : null}
              </div>
            </div>
          </section>

          <MoneyLog />

          <div className="flex min-w-0 flex-col gap-2 md:col-span-2 xl:col-span-1">
            <section className="slab min-w-0">
              <SectionTitle>Where your cards go</SectionTitle>
              <div className="flex flex-col gap-2.5 px-4 pb-4">
                <div className="num break-all px-cut bg-raised p-2.5 text-[13px]">{me.connectedWallet}</div>
                <p className="text-[13.5px] text-mute">Cards from Pulse and packs are delivered to this wallet. Marketplace buys land in the trading wallet first.</p>
                <Toggle checked={forward} onChange={setForward}>Forward marketplace buys here automatically</Toggle>
              </div>
            </section>

            <section className="slab min-w-0">
              <SectionTitle icon={<KeyRound size={16} className="text-gold" aria-hidden="true" />}>Export private key</SectionTitle>
              <div className="px-4 pb-4">
                <p className="text-[13.5px] text-mute">Your trading wallet is yours. The key shows once in a secure window, and anyone holding it can move your funds.</p>
                {paper ? (
                  <p className="mt-2.5 px-cut bg-raised p-2.5 text-[13px] text-faint">Paper wallets are simulated and have no key to export.</p>
                ) : (
                  <Button className="mt-2.5" disabled={!wallet} onClick={() => void wallet?.exportKey().catch((error: Error) => toast({ tone: "bad", title: "Could not open the key window", detail: error.message }))}>Export key</Button>
                )}
              </div>
            </section>

            {!paper ? (
              <section className="slab min-w-0">
                <SectionTitle>Withdraw USDC</SectionTitle>
                <form
                  className="flex flex-col gap-2.5 px-4 pb-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    // Money on hold is already promised to a buy that is settling; taking it would fail that buy.
                    if (Number(withdrawAmount) * 1e6 > me.available) {
                      toast({ tone: "bad", title: "More than you have available", detail: `You can withdraw up to ${money(me.available)}. The rest is on hold for buys that are settling.` });
                      return;
                    }
                    void wallet?.withdraw(withdrawTo.trim(), Number(withdrawAmount)).then(() => toast({ tone: "ok", title: "Withdrawal sent" })).catch((error: Error) => toast({ tone: "bad", title: "Withdrawal failed", detail: error.message }));
                  }}
                >
                  <Field label="To address"><input className={inputClass} value={withdrawTo} onChange={(e) => setWithdrawTo(e.target.value)} placeholder={me.connectedWallet} /></Field>
                  <Field label="Amount (USDC)"><input className={inputClass} inputMode="decimal" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} /></Field>
                  <Button type="submit" disabled={!wallet || !withdrawTo || !(Number(withdrawAmount) > 0)}>Withdraw</Button>
                  <p className="text-[12.5px] text-faint">You approve this yourself. The server can never send your funds anywhere. Your trading wallet pays the network fee, so it needs a little SOL (about 0.003).</p>
                </form>
              </section>
            ) : null}

            <section className="slab min-w-0">
              <SectionTitle>Trading limits</SectionTitle>
              <form
                className="flex flex-col gap-2.5 px-4 pb-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  save.mutate();
                }}
              >
                <Field label="Max per trade (USDC)" hint="Blocks any single marketplace buy above this"><input className={inputClass} inputMode="decimal" placeholder="No limit" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
                <Button type="submit" disabled={save.isPending}>Save</Button>
              </form>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
