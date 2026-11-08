"use client";

import { PrivyProvider, usePrivy, useSigners } from "@privy-io/react-auth";
import { toSolanaWalletConnectors, useExportWallet, useSignAndSendTransaction, useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { connectStream } from "@/lib/live";
import { useUi } from "@/lib/ui";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID!;
const SIGNER_ID = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID ?? "";
const USDC_MINT = process.env.NEXT_PUBLIC_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RPC_URL = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.mainnet-beta.solana.com";

const connectors = toSolanaWalletConnectors();

interface LinkedWallet {
  type: string;
  chainType?: string;
  walletClientType?: string;
  address?: string;
  delegated?: boolean;
}

function Bridge() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const { addSigners } = useSigners();
  const { exportWallet } = useExportWallet();
  const { ready: walletsReady, wallets } = useWallets();
  const { signAndSendTransaction } = useSignAndSendTransaction();
  const { signTransaction } = useSignTransaction();
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const syncing = useRef(false);

  const embedded = (user?.linkedAccounts as unknown as LinkedWallet[] | undefined)?.find(
    (account) => account.type === "wallet" && account.chainType === "solana" && account.walletClientType === "privy",
  );
  // Privy loads the trading wallet a moment after sign-in. Approving one-click trading before then fails with
  // "Wallet proxy not initialized", so nothing that signs runs until the wallet is loaded.
  const walletLoaded = walletsReady && !!embedded?.address && wallets.some((w) => w.address === embedded.address);

  /**
   * Trades the Privy sign-in for a Tenner session, first approving one-click trading if needed. It runs by itself
   * when there is no Tenner session yet, and again whenever Connect is pressed, so a dismissed approval or a failed
   * attempt can always be retried.
   */
  const finish = useRef<(force?: boolean) => void>(() => {});
  finish.current = (force = false) => {
    if (!ready || !authenticated || !embedded?.address || syncing.current) return;
    if (!force && getToken()) return;
    if (!walletLoaded) {
      // Runs by itself once the wallet loads. Only a press of Connect needs telling.
      if (force) toast({ tone: "info", title: "Your trading wallet is still loading", detail: "Sign-in finishes by itself in a moment." });
      return;
    }
    syncing.current = true;
    void (async () => {
      try {
        if (!embedded.delegated) {
          if (!SIGNER_ID) throw new Error("NEXT_PUBLIC_PRIVY_SIGNER_ID is not set");
          await addSigners({ address: embedded.address!, signers: [{ signerId: SIGNER_ID, policyIds: [] }] });
        }
        const accessToken = await getAccessToken();
        const { token } = await api<{ token: string }>("/auth/privy", { body: { accessToken } });
        setToken(token);
        connectStream();
        await client.invalidateQueries();
        useUi.getState().setConnectOpen(false);
      } catch (error) {
        toast({ tone: "bad", title: "Could not finish sign-in", detail: error instanceof Error ? error.message : String(error) });
      } finally {
        syncing.current = false;
      }
    })();
  };

  useEffect(() => {
    useUi.setState({
      wallet: {
        // Privy ignores a second login while it is signed in, so then Connect finishes the Tenner side instead.
        login: () => (authenticated ? finish.current(true) : login()),
        signOut: logout,
        exportKey: () => exportWallet({ address: embedded?.address ?? "" }),
        // Pops the user's own wallet, because only they can move a card it holds.
        signWithMain: async (base64) => {
          const main = wallets.find((w) => w.address !== embedded?.address);
          if (!main) throw new Error("Connect your main wallet");
          const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
          const { signedTransaction } = await signTransaction({ transaction: bytes, wallet: main });
          return btoa(String.fromCharCode(...signedTransaction));
        },
        withdraw: async (to, amount) => {
          const wallet = wallets.find((w) => w.address === embedded?.address);
          if (!wallet) throw new Error("Trading wallet is not ready");
          // Built here and approved by the user, so this path never touches the server.
          const { buildWithdraw } = await import("@/lib/withdraw");
          const bytes = await buildWithdraw({ from: wallet.address, to, amount, usdcMint: USDC_MINT, rpcUrl: RPC_URL });
          await signAndSendTransaction({ transaction: bytes, wallet });
        },
      },
    });
    return () => useUi.setState({ wallet: null });
  }, [authenticated, embedded?.address, exportWallet, login, logout, signAndSendTransaction, signTransaction, wallets]);

  useEffect(() => {
    finish.current();
  }, [authenticated, embedded?.address, embedded?.delegated, ready, walletLoaded]);

  // Signed in to Privy, but no trading wallet arrived. Say so instead of waiting forever.
  useEffect(() => {
    if (!ready || !authenticated || embedded?.address) return;
    const timer = setTimeout(
      () => toast({ tone: "bad", title: "Could not finish sign-in", detail: "Privy did not create a trading wallet. Turn on Solana embedded wallets for all users in Privy, then connect again." }),
      8_000,
    );
    return () => clearTimeout(timer);
  }, [authenticated, embedded?.address, ready, toast]);

  return null;
}

export default function WalletBridge() {
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["wallet"],
        appearance: { theme: "dark", accentColor: "#e5383b", walletChainType: "solana-only" },
        embeddedWallets: { solana: { createOnLogin: "all-users" } },
        externalWallets: { solana: { connectors } },
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}
