import { setTimeout as sleep } from "node:timers/promises";

import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { checkHandlerInfo, ensureHandlerIsReady } from "../../utils/handler.js";
import { callHelper } from "../../utils/ipc.js";
import { createSpinner } from "../../utils/spinner.js";
import { renderStatusTree } from "../status.js";

const SHUTDOWN_WAIT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

export const restartDaemonCommand = defineCommand({
  meta: {
    description: "Restart the running masir daemon",
    name: "restart",
  },
  async run() {
    const spinner = createSpinner();
    spinner.start("Checking daemon status...");
    const info = checkHandlerInfo();
    const wasPrivileged = info?.helperEuid === 0;

    if (info) {
      spinner.message(`Stopping running daemon (PID: ${info.helperPid})...`);
      callHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
      const deadline = Date.now() + SHUTDOWN_WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(POLL_INTERVAL_MS);
        if (checkHandlerInfo() === null) {
          break;
        }
      }
    }

    spinner.message(wasPrivileged ? "Starting privileged daemon..." : "Starting daemon...");
    const ready = await ensureHandlerIsReady({ privileged: wasPrivileged, spinner });
    if (!ready) {
      spinner.error(pc.red("Failed to restart daemon."));
      process.exit(1);
    }
    const newInfo = checkHandlerInfo();
    spinner.stop(pc.green(`Daemon restarted successfully (PID: ${newInfo?.helperPid ?? "unknown"}).`));
    console.log(`\n${renderStatusTree()}`);
  },
});
