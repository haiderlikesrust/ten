import { BRAND } from "@gemdex/core";

const SECTIONS = [
  ["This is draft text", "These terms are a starting point and have not been reviewed by a lawyer. They must be replaced with reviewed terms before any real-money launch."],
  [`What ${BRAND.name} is`, `${BRAND.name} is an interface for Collector Crypt tokenized cards. Collector Crypt runs the packs, vaults, marketplace and buybacks. ${BRAND.name} is not affiliated with Collector Crypt, The Pokémon Company, Nintendo, or any card publisher. Card names and images belong to their owners.`],
  ["Packs are random", "Pack contents are random, and most pulls land in the lowest value range. You can lose money. Do not spend what you cannot afford to lose. Packs may be restricted or illegal where you live, and you are responsible for following your local laws."],
  ["Buying on Pulse", "Pulse prices open at insured value, then move automatically for a few minutes. They are not set by other buyers or by the card's market value. A price can end well above or far below insured value, and nothing says which way a card will go. The first valid click buys the card at the price at that moment, and that sale is final."],
  ["Insured value is not a price", "Insured value is a reference number set by Collector Crypt to calculate buybacks. It is not a market price or a promise that anyone will pay that amount. Portfolio value and profit figures use insured value and may be higher than what you could actually sell for."],
  ["Your trading wallet", "You can fund your trading wallet and export its private key. Anyone with that key can move your funds. Keep only what you plan to trade in it. Blockchain transactions cannot be reversed."],
  [`The ${BRAND.tokenTicker} token`, `${BRAND.tokenTicker} is not an investment, and nothing here promises any return. Cashback depends on the pool, your tier, machine caps and daily limits, and it can change or stop at any time.`],
  ["Fair play", "First valid click wins a card. Automated trading is possible and cannot be fully prevented. Wallets that fail settlement receive strikes and may be restricted."],
];

export default function TermsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <article className="mx-auto flex max-w-[700px] flex-col gap-5 p-5 sm:p-8">
        <h1 className="text-[28px] font-bold tracking-tight">Terms and risks</h1>
        {SECTIONS.map(([title, body]) => (
          <section key={title}>
            <h2 className="text-[16px] font-bold">{title}</h2>
            <p className="mt-1 text-[15px] leading-relaxed text-mute">{body}</p>
          </section>
        ))}
        <section>
          <h2 className="text-[16px] font-bold">Credits</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-mute">
            TradingView Lightweight Charts™, Copyright (c) TradingView, Inc. <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener" className="text-gold underline">tradingview.com</a>
          </p>
        </section>
      </article>
    </div>
  );
}
