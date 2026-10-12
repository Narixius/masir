import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import pc from "picocolors";

import { loadSettings, resolveAssetsPath } from "../config/settings.js";
import type { InfoResult, ResponseOf } from "../protocol.js";
import { isDaemonServiceInstalled, isServiceSupported } from "../services/daemon-service/daemon-service.js";
import { tryCallHelper } from "./ipc.js";
import type { SpinnerInstance } from "./spinner.js";

export type ClackSpinner = SpinnerInstance;

export interface EnsureHandlerOptions {
  /** The daemon must run as root (TUN mode). */
  privileged?: boolean;
  /** Optional interactive spinner to report progress. */
  spinner?: ClackSpinner;
}

const READY_TIMEOUT_MS = 5000;
/** Longer when privileged: the user may still be typing their sudo password. */
const PRIVILEGED_READY_TIMEOUT_MS = 30_000;
const POLL_MS = 100;
const SHUTDOWN_TIMEOUT_MS = 3000;

/** The running daemon's identity, or `null` when no daemon answers. */
export const checkHandlerInfo = (): InfoResult | null => {
  const res = tryCallHelper<ResponseOf<"info">>({ type: "info" });
  return res?.ok ? res.result : null;
};

const waitUntil = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(POLL_MS);
    if (done()) {
      return true;
    }
  }
  return false;
};

const isTsDev = (): boolean => Boolean(process.argv[1]?.endsWith(".ts"));

/** Command that runs `masir daemon run` (the compiled binary, or tsx in development). */
const daemonCommandLine = (): { exe: string; args: string[] } =>
  isTsDev()
    ? {
        args: ["--import", "./src/shim.dev.ts", process.argv[1] as string, "daemon", "run"],
        exe: "node_modules/.bin/tsx",
      }
    : { args: ["daemon", "run"], exe: process.execPath };

const shellEscape = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;

/** Environment a root daemon needs: sudo resets it, and the daemon must know whose it is. */
const rootDaemonEnv = (ownerUid: number): string[] => {
  const settings = loadSettings();
  const assetsPath = resolveAssetsPath(settings.xrayAssetsPath, settings.xrayExecutable);
  const vars = [`MASIR_ALLOWED_UID=${ownerUid}`, `XRAY_LOCATION_ASSET=${assetsPath}`];
  for (const name of ["HOME", "PATH", "XRAY_EXECUTABLE", "MASIR_SOCKET"]) {
    const value = process.env[name];
    if (value) {
      vars.push(`${name}=${value}`);
    }
  }
  return vars;
};

/**
 * Start the daemon detached. Privileged means root: directly when this CLI is
 * already root (`sudo masir connect --tun`), otherwise through `sudo`, which asks
 * for the password or Touch ID here in the terminal.
 */
export const spawnDaemonProcess = (privileged = false): number => {
  const { exe, args } = daemonCommandLine();
  const isRoot = process.getuid?.() === 0;
  const ownerUid = isRoot ? Number(process.env.SUDO_UID) : (process.getuid?.() ?? 0);

  if (privileged && !isRoot) {
    const envVars = rootDaemonEnv(ownerUid);
    const escapedEnv = envVars.map(shellEscape).join(" ");
    const escapedExe = shellEscape(exe);
    const escapedArgs = args.map(shellEscape).join(" ");
    const currentDir = shellEscape(process.cwd());
    const script = `cd ${currentDir} && nohup env ${escapedEnv} ${escapedExe} ${escapedArgs} >/dev/null 2>&1 &`;

    const auth = spawnSync("sudo", ["sh", "-c", script], {
      stdio: "inherit",
    });
    if (auth.status !== 0) {
      console.error("Authentication failed or canceled.");
      return 0;
    }
    return 1;
  }

  const env: NodeJS.ProcessEnv = privileged && isRoot ? { ...process.env, MASIR_ALLOWED_UID: String(ownerUid) } : process.env;

  const child = spawn(exe, args, {
    detached: true,
    env,
    stdio: "ignore",
  });

  child.unref();
  return child.pid ?? 0;
};

const printPrivilegeNotice = (): void => {
  const settings = loadSettings();
  const bar = pc.yellow("│");
  const branch = pc.yellow("└─");
  const icon = pc.yellow("▲");
  const title = pc.bold(pc.yellow("Elevated Privileges Required"));
  const exe = pc.cyan(settings.xrayExecutable);
  const cmd = pc.cyan("masir daemon enable");

  const lines: string[] = [
    `${icon}  ${title}`,
    `${bar}  TUN mode requires root to configure system routing tables and virtual network interfaces.`,
    `${bar}  The masir daemon and xray (${exe}) will run with elevated privileges.`,
  ];

  if (isServiceSupported() && !isDaemonServiceInstalled()) {
    lines.push(bar, `${branch} Tip: Run ${cmd} to run as a system service and skip password prompts.`);
  }

  console.log(`\n${lines.join("\n")}\n`);
};

const isBinaryUpdated = (info: InfoResult): boolean => {
  try {
    const currentMtime = statSync(process.execPath).mtimeMs;
    return Boolean(info.binaryMtime && currentMtime > info.binaryMtime + 1000);
  } catch {
    return false;
  }
};

const stopExistingDaemon = async (binaryUpdated: boolean, spinner?: ClackSpinner): Promise<boolean> => {
  if (binaryUpdated) {
    if (spinner) {
      spinner.message("Masir binary was updated; restarting daemon...");
    } else {
      console.log("Masir binary was updated; restarting daemon...");
    }
  } else if (spinner) {
    spinner.message("Restarting daemon as root for TUN mode...");
  } else {
    console.log("The running daemon is not privileged; restarting it as root for TUN mode...");
  }

  tryCallHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
  const gone = await waitUntil(() => checkHandlerInfo() === null, SHUTDOWN_TIMEOUT_MS);
  if (!gone) {
    if (spinner) {
      spinner.error(pc.red("Could not stop the running daemon."));
    } else {
      console.error("Could not stop the running daemon.");
    }
    return false;
  }
  return true;
};

export const ensureHandlerIsReady = async (options?: EnsureHandlerOptions): Promise<boolean> => {
  const requirePrivileged = Boolean(options?.privileged);
  const spinner = options?.spinner;
  const currentInfo = checkHandlerInfo();

  if (currentInfo) {
    const binaryUpdated = isBinaryUpdated(currentInfo);
    if (!binaryUpdated && (!requirePrivileged || currentInfo.helperEuid === 0)) {
      return true;
    }

    const stopped = await stopExistingDaemon(binaryUpdated, spinner);
    if (!stopped) {
      return false;
    }
  }

  if (requirePrivileged) {
    spinner?.stop();
    printPrivilegeNotice();
  } else if (spinner) {
    spinner.message("Spawning daemon process...");
  } else {
    console.log("Handler not available, spawning daemon process...");
  }

  const pid = spawnDaemonProcess(requirePrivileged);
  if (pid <= 0) {
    if (spinner) {
      spinner.error(pc.red("Failed to spawn daemon process."));
    } else {
      console.error("Failed to spawn daemon process");
    }
    return false;
  }

  if (requirePrivileged && spinner) {
    spinner.start("Connecting to privileged daemon...");
  }

  if (spinner) {
    spinner.message("Waiting for daemon socket...");
  }

  const ready = await waitUntil(
    () => {
      const info = checkHandlerInfo();
      return info !== null && (!requirePrivileged || info.helperEuid === 0);
    },
    requirePrivileged ? PRIVILEGED_READY_TIMEOUT_MS : READY_TIMEOUT_MS
  );
  if (!ready) {
    if (spinner) {
      spinner.error(pc.red("Daemon spawned but socket did not become ready in time."));
    } else {
      console.error("Daemon spawned but socket did not become ready in time.");
    }
    return false;
  }

  return true;
};
