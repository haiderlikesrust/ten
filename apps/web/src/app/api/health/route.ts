import { isDraining } from "@/lib/drain";

export const dynamic = "force-dynamic";

/** Docker's health check. It fails while the server is stopping, so nothing new is sent to it. */
export function GET() {
  const ok = !isDraining();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
