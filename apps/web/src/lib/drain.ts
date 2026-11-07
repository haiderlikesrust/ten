// Node only: imported from instrumentation.ts when the server runs in the Docker image.
const DRAINING = Symbol.for("tenner.web.draining");
type Flagged = typeof globalThis & { [DRAINING]?: boolean };

export const isDraining = () => (globalThis as Flagged)[DRAINING] === true;

/**
 * Stopping for an update. The new container is already serving when Docker stops this one: report
 * unhealthy, give requests already on their way DRAIN_DELAY_MS to finish, then exit.
 */
export function drainOnSignals() {
  const stop = () => {
    if (isDraining()) return;
    (globalThis as Flagged)[DRAINING] = true;
    console.log("[web] stopping: finishing open requests");
    setTimeout(() => process.exit(0), Number(process.env.DRAIN_DELAY_MS ?? 3_000));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
