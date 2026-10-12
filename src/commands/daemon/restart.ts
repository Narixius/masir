import { setTimeout as sleep } from "node:timers/promises";

import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { checkHandlerInfo, ensureHandlerIsReady } from "../../utils/handler.js";
import { callHelper, tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { createSpinner } from "../../utils/spinner.js";
import { renderStatusTree } from "../status.js";

const SHUTDOWN_WAIT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

const waitForDaemonShutdown = async (oldPid: number): Promise<void> => {
  const deadline = Date.now() + SHUTDOWN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(POLL_INTERVAL_MS);
    const next = checkHandlerInfo();
    if (next === null || next.helperPid !== oldPid) {
      return;
    }
  }
};

export const restartDaemonCommand = defineCommand({
  meta: {
    alias: ["reload"],
    description: "Restart the running masir daemon (and reconnect xray if it was running)",
    name: "restart",
  },
  async run() {
    const spinner = createSpinner();
    spinner.start("Checking daemon status...");
    const info = checkHandlerInfo();
    const prevStatus = info ? tryCallHelper<ResponseOf<"status">>({ type: "status" }) : null;
    const wasXrayRunning = Boolean(prevStatus?.ok && prevStatus.result.xray.running);
    const wasTun = Boolean(prevStatus?.ok && prevStatus.result.xray.mode === "tun");
    const wasPrivileged = info?.helperEuid === 0 || wasTun;

    if (info) {
      spinner.message(`Stopping running daemon (PID: ${info.helperPid})...`);
      tryCallHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
      await waitForDaemonShutdown(info.helperPid);
    }

    spinner.message(wasPrivileged ? "Starting privileged daemon..." : "Starting daemon...");
    const ready = await ensureHandlerIsReady({ privileged: wasPrivileged, spinner });
    if (!ready) {
      spinner.error(pc.red("Failed to restart daemon."));
      process.exit(1);
    }

    const newInfo = checkHandlerInfo();
    const daemonPid = newInfo?.helperPid ?? "unknown";

    if (wasXrayRunning) {
      spinner.message(wasTun ? "Reconnecting Xray in TUN mode..." : "Reconnecting Xray in Proxy mode...");
      const startRes = callHelper<ResponseOf<"start">>({ tun: wasTun, type: "start" });
      if (!startRes.ok) {
        spinner.error(pc.red(`Daemon restarted (PID: ${daemonPid}), but failed to reconnect Xray: ${startRes.error}`));
        log.info(pc.dim("Inspect status with `masir status` or view logs with `masir logs`."));
        process.exit(1);
      }
      const modeLabel = wasTun ? "TUN mode" : "Proxy mode";
      spinner.stop(pc.green(`Daemon restarted (PID: ${daemonPid}) and Xray reconnected in ${modeLabel}.`));
    } else {
      spinner.stop(pc.green(`Daemon restarted successfully (PID: ${daemonPid}).`));
    }

    console.log(`\n${renderStatusTree()}`);
  },
});
