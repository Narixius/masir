import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../protocol.js";
import { callHelper } from "../utils/ipc.js";
import { log } from "../utils/log.js";
import { createSpinner } from "../utils/spinner.js";
import { renderStatusTree } from "./status.js";

export const stopCommand = defineCommand({
  meta: {
    description: "Disconnect: stop xray (the daemon keeps running)",
    name: "disconnect",
    alias: ["stop"],
  },
  run() {
    const spinner = createSpinner();
    spinner.start("Stopping Xray process...");
    try {
      const res = callHelper<ResponseOf<"stop">>({ type: "stop" });
      if (!res.ok) {
        spinner.error(pc.red(`Failed to stop Xray: ${res.error}`));
        log.info(pc.dim("Inspect status with `masir status` or view logs with `masir logs`."));
        process.exit(1);
      }
      spinner.stop(pc.green("Xray process stopped successfully."));
      console.log(`\n${renderStatusTree()}`);
    } catch {
      spinner.stop();
      log.warn(pc.yellow("Helper daemon is not running (nothing to stop)."));
      console.log(`\n${renderStatusTree()}`);
    }
  },
});
