import { workerData } from "node:worker_threads";

interface WatchdogConfig {
  port: number;
  path: string;
  intervalMs: number;
  timeoutMs: number;
  failureThreshold: number;
}

const config = workerData as WatchdogConfig;
let consecutiveFailures = 0;

async function check(): Promise<void> {
  let healthy = false;
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}${config.path}`, {
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    healthy = res.ok;
  } catch {
    healthy = false;
  }

  if (healthy) {
    consecutiveFailures = 0;
    return;
  }

  consecutiveFailures += 1;
  console.error(
    `[fig2code] watchdog: health check failed (${consecutiveFailures}/${config.failureThreshold})`,
  );

  if (consecutiveFailures >= config.failureThreshold) {
    console.error(
      "[fig2code] watchdog: API unresponsive — killing process so the platform restarts it clean",
    );
    // This runs on its own thread, so it fires even when the main event loop is
    // wedged. SIGKILL targets the shared PID; it is immediate and uncatchable,
    // so the platform's restart policy (ON_FAILURE) brings the API back.
    process.kill(process.pid, "SIGKILL");
  }
}

setInterval(() => {
  void check();
}, config.intervalMs);
