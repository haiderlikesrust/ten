export const GATEWAY = process.env.NEXT_PUBLIC_GATEWAY_URL || "http://127.0.0.1:4010";
export const WS_URL = GATEWAY.replace(/^http/, "ws");

const TOKEN_KEY = "gemdex.session";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private windows can refuse storage. The session then lasts until the tab closes.
  }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(GATEWAY + path, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export const newKey = () => crypto.randomUUID();
