"use client";

import { useEffect } from "react";

/**
 * The last resort, when the site's frame itself crashed (the menu, the wallet bridge). It replaces the whole page,
 * so it can't rely on the site's styles and carries its own. Next shows it instead of its bare "Application error".
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("The site crashed:", error);
  }, [error]);
  const button = { padding: "10px 16px", border: 0, cursor: "pointer", font: "inherit", fontWeight: 700 } as const;
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0c12", color: "#e8e6e1", fontFamily: "system-ui, sans-serif", padding: 16, boxSizing: "border-box" }}>
        <main style={{ maxWidth: 440, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Tenner hit an error</h1>
          <p style={{ margin: "0 0 6px", color: "#a3a09a" }}>Nothing was lost: your balance and cards are safe. Reload to carry on.</p>
          {error.message ? <p style={{ margin: "0 0 16px", fontSize: 12.5, color: "#77746e", wordBreak: "break-word" }}>{error.message.slice(0, 240)}</p> : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button type="button" onClick={() => window.location.reload()} style={{ ...button, background: "#e5383b", color: "#fff" }}>Reload</button>
            <button type="button" onClick={reset} style={{ ...button, background: "#1c1f29", color: "#e8e6e1" }}>Try again</button>
          </div>
        </main>
      </body>
    </html>
  );
}
