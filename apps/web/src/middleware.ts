import { NextResponse, type NextRequest } from "next/server";

/**
 * Blocks restricted countries, listed in BLOCKED_COUNTRIES as two-letter codes.
 * Reads the country header set by Vercel or Cloudflare, so it does nothing in local dev.
 * This is a first line only: a VPN gets past it, and legal review decides the real list.
 */
export function middleware(request: NextRequest) {
  const blocked = (process.env.BLOCKED_COUNTRIES ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
  if (blocked.length === 0) return NextResponse.next();
  const country = request.headers.get("x-vercel-ip-country") ?? request.headers.get("cf-ipcountry");
  if (country && blocked.includes(country.toUpperCase()) && !request.nextUrl.pathname.startsWith("/blocked")) {
    return NextResponse.redirect(new URL("/blocked", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next|favicon.ico).*)"] };
