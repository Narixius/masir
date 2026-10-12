import { spawnSync } from "node:child_process";

import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { isServiceSupported, uninstallDaemonService } from "../../services/daemon-service/daemon-service.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { createSpinner } from "../../utils/spinner.js";

export const uninstallCommand = defineCommand({
  meta: {
    description: "Stop running the daemon as a system service. Asks for sudo.",
    name: "disable",
    alias: ["uninstall"],
  },
  run() {
    if (!isServiceSupported()) {
      console.error(`Not supported on ${process.platform} yet.`);
      process.exit(1);
    }
    if (process.getuid?.() !== 0) {
      if (process.argv[1]?.endsWith(".ts")) {
        console.error("Build the native binary first (pnpm build).");
        process.exit(1);
      }
      const result = spawnSync("sudo", [process.execPath, "daemon", "disable"], { stdio: "inherit" });
      process.exit(result.status ?? 1);
    }

    const spinner = createSpinner();
    spinner.start("Removing masir daemon service...");
    try {
      tryCallHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
      uninstallDaemonService();
      spinner.stop(pc.green("Masir daemon service removed successfully."));
    } catch (error) {
      spinner.error(pc.red(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  },
});
