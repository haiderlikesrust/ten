/**
 * Runs once per server process. The Docker image sets NEXT_MANUAL_SIG_HANDLE, so stopping is handled
 * here: the server finishes open requests instead of exiting mid-response (docs/DOKPLOY.md).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.NEXT_MANUAL_SIG_HANDLE) return;
  const { drainOnSignals } = await import("./lib/drain");
  drainOnSignals();
}
