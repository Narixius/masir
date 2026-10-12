import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { checkHandlerInfo } from "../../utils/handler.js";
import { callHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { createSpinner } from "../../utils/spinner.js";

export const stopDaemonCommand = defineCommand({
  meta: {
    description: "Stop the running masir daemon",
    name: "stop",
  },
  run() {
    const spinner = createSpinner();
    spinner.start("Checking daemon status...");
    const info = checkHandlerInfo();
    if (!info) {
      spinner.stop();
      log.warn(pc.yellow("Daemon is not running."));
      return;
    }
    spinner.message(`Stopping daemon (PID: ${info.helperPid})...`);
    const res = callHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
    if (!res.ok) {
      spinner.error(pc.red(`Failed to stop daemon: ${res.error}`));
      process.exit(1);
    }
    spinner.stop(pc.green(`Daemon (PID: ${info.helperPid}) shut down successfully.`));
  },
});
