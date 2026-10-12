import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { defineCommand } from "citty";
import pc from "picocolors";

import { loadSettings, resolveAssetsPath, resolveXrayExecutable } from "../../config/settings.js";
import type { ResponseOf } from "../../protocol.js";
import type { EnvVar } from "../../services/daemon-service/daemon-service.js";
import { installDaemonService, isServiceSupported } from "../../services/daemon-service/daemon-service.js";
import { checkHandlerInfo } from "../../utils/handler.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { createSpinner } from "../../utils/spinner.js";

/** launchd/systemd start services with a minimal PATH, so a bare `xray` would not be found. */
const resolveXrayPath = (): string | null => {
  const { xrayExecutable } = loadSettings();
  const resolved = resolveXrayExecutable(xrayExecutable);
  if (isAbsolute(resolved)) {
    try {
      accessSync(resolved, constants.X_OK);
      return resolved;
    } catch {
      // not executable
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) {
      const candidate = join(dir, xrayExecutable);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not in this directory
      }
    }
  }
  return null;
};

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

const stopRunningDaemon = async (): Promise<void> => {
  if (checkHandlerInfo()) {
    tryCallHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await sleep(100);
      if (checkHandlerInfo() === null) {
        break;
      }
    }
  }
};

/** Not root yet: re-run this command under sudo, passing along who we are. */
const relaunchWithSudo = async (): Promise<never> => {
  const uid = process.getuid?.() ?? 0;
  const home = process.env.HOME ?? "";
  const path = process.env.PATH ?? "";
  const xray = process.env.XRAY_EXECUTABLE ?? "";
  const assets = process.env.XRAY_LOCATION_ASSET ?? "";
  if (process.argv[1]?.endsWith(".ts")) {
    return fail("Build the native binary first (pnpm build); the service needs a compiled masir.");
  }
  await stopRunningDaemon();
  const envArgs = [`HOME=${home}`, `MASIR_ALLOWED_UID=${uid}`, `PATH=${path}`];
  if (xray) {
    envArgs.push(`XRAY_EXECUTABLE=${xray}`);
  }
  if (assets) {
    envArgs.push(`XRAY_LOCATION_ASSET=${assets}`);
  }
  const result = spawnSync("sudo", ["env", ...envArgs, process.execPath, "daemon", "enable"], {
    stdio: "inherit",
  });
  return process.exit(result.status ?? 1);
};

export const installCommand = defineCommand({
  meta: {
    alias: ["install"],
    description: "Run the daemon as a root system service, so TUN mode needs no password. Asks for sudo.",
    name: "enable",
  },
  async run() {
    if (!isServiceSupported()) {
      fail(`Installing the daemon as a service is not supported on ${process.platform} yet.`);
    }
    if (process.getuid?.() !== 0) {
      await relaunchWithSudo();
    }

    // Root from here on: the user we serve was passed in by the sudo relaunch (or by `sudo masir daemon enable`).
    const ownerUid = Number(process.env.MASIR_ALLOWED_UID ?? process.env.SUDO_UID);
    if (!(ownerUid > 0)) {
      fail("Run `masir daemon enable` as your normal user (not as root); it asks for sudo itself.");
    }

    await stopRunningDaemon();

    const xray = resolveXrayPath();
    if (!xray) {
      fail("Could not find the xray executable. Set xrayExecutable in the masir config or XRAY_EXECUTABLE.");
      return;
    }

    const settings = loadSettings();
    const assets = resolveAssetsPath(settings.xrayAssetsPath, xray);
    const standardPath = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    const envPath = process.env.PATH ? `${process.env.PATH}:${standardPath}` : standardPath;

    const env: EnvVar[] = [
      { name: "HOME", value: process.env.HOME ?? "" },
      { name: "MASIR_ALLOWED_UID", value: String(ownerUid) },
      { name: "XRAY_EXECUTABLE", value: xray },
      { name: "XRAY_LOCATION_ASSET", value: assets },
      { name: "PATH", value: envPath },
    ];

    const spinner = createSpinner();
    spinner.start("Registering masir daemon as a system service...");
    try {
      installDaemonService(process.execPath, env);
      spinner.stop(pc.green("Masir daemon enabled as a system service (runs as root, starts on boot)."));
      console.log(pc.dim(`\nIt will run xray from ${xray} as root; keep that file and your masir config secure.\n`));
    } catch (error) {
      spinner.error(pc.red(`Install failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  },
});
