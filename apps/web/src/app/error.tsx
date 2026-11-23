"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Button, Empty } from "@/components/bits";

/** Shown in place of a page that crashed. The rest of the site (menu, wallet, balances) keeps working around it. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("This page crashed:", error);
  }, [error]);
  return (
    <div className="flex h-full items-center justify-center">
      <Empty title="This page hit an error" icon={<TriangleAlert size={22} aria-hidden="true" />}>
        <p>Nothing was lost: your balance and cards are safe. Try the page again, or reload if it keeps happening.</p>
        {error.message ? <p className="num mt-2 break-words text-[12.5px] text-faint">{error.message.slice(0, 240)}</p> : null}
        <div className="mt-3 flex justify-center gap-2">
          <Button tone="primary" onClick={reset}><RotateCcw size={14} aria-hidden="true" /> Try again</Button>
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </Empty>
    </div>
  );
}
