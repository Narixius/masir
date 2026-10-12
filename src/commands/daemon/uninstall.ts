import { spawnSync } from "node:child_process";

import { defineCommand } from "citty";
import pc from "picocolors";

import { isServiceSupported, uninstallDaemonService } from "../../services/daemon-service/daemon-service.js";
import { createSpinner } from "../../utils/spinner.js";

export const uninstallCommand = defineCommand({
  meta: {
    description: "Remove the masir daemon service. Asks for sudo.",
    name: "uninstall",
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
      const result = spawnSync("sudo", [process.execPath, "daemon", "uninstall"], { stdio: "inherit" });
      process.exit(result.status ?? 1);
    }

    const spinner = createSpinner();
    spinner.start("Removing masir daemon service...");
    try {
      uninstallDaemonService();
      spinner.stop(pc.green("Masir daemon service removed successfully."));
    } catch (error) {
      spinner.error(pc.red(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`));
      process.exit(1);
    }
  },
});
