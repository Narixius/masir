// Spawning and stopping xray child processes. Shared by the main xray
// (services/xray.ts) and the throwaway latency-test xray (services/latency/).
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/** Grace period between SIGTERM and SIGKILL when stopping xray. */
export const STOP_GRACE_MS = 2000;
const STOP_POLL_MS = 50;
const MAX_PENDING_LINE = 65_536;

/** Line printed by the guardian with the real xray pid. */
export const XRAY_PID_PREFIX = "MASIR_XRAY_PID=";

/**
 * Runs xray under a `/bin/sh` guardian that kills it as soon as the parent
 * (`$3`) dies, so a crashed or SIGKILLed daemon/CLI never leaves xray behind.
 */
const GUARDIAN_SCRIPT = `
trap 'kill -TERM "$XRAY_PID" 2>/dev/null; exit 0' EXIT HUP INT TERM
if [ -n "$4" ]; then
  export XRAY_LOCATION_ASSET="$4"
fi
"$1" run -c "$2" &
XRAY_PID=$!
echo "${XRAY_PID_PREFIX}$XRAY_PID"

while kill -0 "$XRAY_PID" 2>/dev/null; do
  if ! kill -0 "$3" 2>/dev/null; then
    kill -TERM "$XRAY_PID" 2>/dev/null
    exit 0
  fi
  sleep 0.2
done

wait "$XRAY_PID" 2>/dev/null
exit $?
`;

/** Start `xray run -c configPath`, guarded on POSIX. stdout/stderr are piped. */
export const spawnGuardedXray = (executable: string, configPath: string, assetsPath: string): ChildProcess =>
  process.platform === "win32"
    ? spawn(executable, ["run", "-c", configPath], {
        detached: false,
        env: { ...process.env, XRAY_LOCATION_ASSET: assetsPath },
        stdio: ["ignore", "pipe", "pipe"],
      })
    : spawn("/bin/sh", ["-c", GUARDIAN_SCRIPT, "xray-guardian", executable, configPath, String(process.pid), assetsPath], {
        detached: true,
        env: { ...process.env, XRAY_LOCATION_ASSET: assetsPath },
        stdio: ["pipe", "pipe", "pipe"],
      });

/** Split a byte stream into lines. */
export const makeLineReader = (onLine: (line: string) => void) => {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString();
    let index = pending.indexOf("\n");
    while (index !== -1) {
      onLine(pending.slice(0, index).replace(/\r$/u, ""));
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
    }
    // guard against a runaway line with no newline
    if (pending.length > MAX_PENDING_LINE) {
      onLine(pending);
      pending = "";
    }
  };
};

/** SIGTERM the guardian's process group and the xray pid. */
export const killProcessTree = (child: ChildProcess, xrayPid?: number | null) => {
  try {
    child.stdin?.end();
  } catch {
    // Ignore error closing stdin
  }

  if (xrayPid) {
    try {
      process.kill(xrayPid, "SIGTERM");
    } catch {
      // Ignore
    }
  }

  // oxlint-disable-next-line eslint/prefer-destructuring
  const pid = child.pid;
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process already terminated
    }
  }
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Poll until every pid has exited; SIGKILL whatever outlives `graceMs`. */
export const waitForExit = async (pids: readonly number[], graceMs: number = STOP_GRACE_MS): Promise<void> => {
  const deadline = Date.now() + graceMs;
  while (pids.some(isAlive) && Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(STOP_POLL_MS);
  }
  for (const pid of pids.filter(isAlive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // exited meanwhile
    }
  }
};

/** Stop a guarded xray (guardian + xray pid) and wait until both are gone. */
export const stopGuardedXray = async (child: ChildProcess, xrayPid: number | null): Promise<void> => {
  const pids: number[] = [];
  for (const pid of [xrayPid, child.pid]) {
    if (typeof pid === "number" && pid > 0) {
      pids.push(pid);
    }
  }
  killProcessTree(child, xrayPid);
  await waitForExit(pids);
};
