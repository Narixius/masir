import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

import { defineCommand } from "citty";
import pc from "picocolors";

import { loadSettings } from "../../config/settings.js";
import type { EnvVar } from "../../services/daemon-service/daemon-service.js";
import { installDaemonService, isServiceSupported } from "../../services/daemon-service/daemon-service.js";
import { createSpinner } from "../../utils/spinner.js";

/** launchd/systemd start services with a minimal PATH, so a bare `xray` would not be found. */
const resolveXrayPath = (): string | null => {
  const { xrayExecutable } = loadSettings();
  if (isAbsolute(xrayExecutable)) {
    return xrayExecutable;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, xrayExecutable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
};

const fail = (message: string): never => {
  console.error(message);
  return process.exit(1);
};

/** Not root yet: re-run this command under sudo, passing along who we are. */
const relaunchWithSudo = (): never => {
  const uid = process.getuid?.() ?? 0;
  const home = process.env.HOME ?? "";
  if (process.argv[1]?.endsWith(".ts")) {
    return fail("Build the native binary first (pnpm build); the service needs a compiled masir.");
  }
  const result = spawnSync("sudo", ["env", `HOME=${home}`, `MASIR_ALLOWED_UID=${uid}`, process.execPath, "daemon", "enable"], {
    stdio: "inherit",
  });
  return process.exit(result.status ?? 1);
};

export const installCommand = defineCommand({
  meta: {
    description: "Run the daemon as a root system service, so TUN mode needs no password. Asks for sudo.",
    name: "enable",
    alias: ["install"],
  },
  run() {
    if (!isServiceSupported()) {
      fail(`Installing the daemon as a service is not supported on ${process.platform} yet.`);
    }
    if (process.getuid?.() !== 0) {
      relaunchWithSudo();
    }

    // Root from here on: the user we serve was passed in by the sudo relaunch (or by `sudo masir daemon enable`).
    const ownerUid = Number(process.env.MASIR_ALLOWED_UID ?? process.env.SUDO_UID);
    if (!(ownerUid > 0)) {
      fail("Run `masir daemon enable` as your normal user (not as root); it asks for sudo itself.");
    }
    const xray = resolveXrayPath();
    if (!xray) {
      fail("Could not find the xray executable. Set xrayExecutable in the masir config or XRAY_EXECUTABLE.");
    }

    const env: EnvVar[] = [
      { name: "HOME", value: process.env.HOME ?? "" },
      { name: "MASIR_ALLOWED_UID", value: String(ownerUid) },
      { name: "XRAY_EXECUTABLE", value: xray as string },
    ];
    const assets = process.env.XRAY_LOCATION_ASSET;
    if (assets) {
      env.push({ name: "XRAY_LOCATION_ASSET", value: assets });
    }

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
