import { Worker } from "node:worker_threads";

export interface HealthWatchdogOptions {
  port: number;
  path?: string;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
}

/**
 * Start a watchdog that pings the API's own /health endpoint from a separate
 * worker thread and force-restarts the process if it stops responding.
 *
 * Platforms like Railway only restart a process that *exits* — a hung-but-alive
 * server (returns 502s/timeouts while the process keeps running) is never
 * restarted on its own. The watchdog turns a hang into a clean exit so the
 * platform's restart policy recovers it. It lives on its own thread so it still
 * fires when the main event loop is wedged.
 *
 * Runs in the compiled production build only (skipped under tsx in local dev).
 * Disable with HEALTH_WATCHDOG=off.
 */
export function startHealthWatchdog(options: HealthWatchdogOptions): void {
  if (process.env.HEALTH_WATCHDOG === "off") return;
  // In local dev the entry runs as .ts via tsx; the sibling worker is only
  // emitted as .js by the build, so only arm the watchdog in the built output.
  if (!import.meta.url.endsWith(".js")) return;

  const worker = new Worker(new URL("./watchdog-worker.js", import.meta.url), {
    workerData: {
      port: options.port,
      path: options.path ?? "/health",
      intervalMs: options.intervalMs ?? 10_000,
      timeoutMs: options.timeoutMs ?? 5_000,
      failureThreshold: options.failureThreshold ?? 3,
    },
  });
  worker.on("error", (err) => {
    console.error("[fig2code] watchdog worker error:", err);
  });
  // Don't let the watchdog thread keep the process alive on its own.
  worker.unref();
  console.log("[fig2code] health watchdog started");
}
