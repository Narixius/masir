import { defineCommand } from "citty";
import pc from "picocolors";

import { saveAssetsPath } from "../config/settings.js";
import type { ResponseOf } from "../protocol.js";
import { ensureMinimumXray } from "../services/xray-updater.js";
import { ensureHandlerIsReady } from "../utils/handler.js";
import { callHelper } from "../utils/ipc.js";
import { log } from "../utils/log.js";
import { createSpinner } from "../utils/spinner.js";
import { renderStatusTree } from "./status.js";

export const startCommand = defineCommand({
  args: {
    assets: {
      alias: "a",
      description: "custom path to directory containing geodata files (geoip.dat, geosite.dat)",
      type: "string",
    },
    tun: {
      alias: "t",
      default: false,
      description: "enable tun mode (runs the daemon as root; asks for your password)",
      type: "boolean",
    },
  },
  meta: {
    description: "Connect: start xray with the active proxy (--tun routes the whole system)",
    name: "connect",
    alias: ["start"],
  },
  async run({ args }) {
    if (args.assets) {
      saveAssetsPath(String(args.assets));
    }

    const xrayReady = await ensureMinimumXray();
    if (!xrayReady) {
      process.exit(1);
    }

    const isTun = Boolean(args.tun);
    const spinner = createSpinner();
    spinner.start(isTun ? "Preparing TUN mode..." : "Preparing Proxy mode...");

    const isReady = await ensureHandlerIsReady({
      privileged: isTun,
      spinner,
    });
    if (!isReady) {
      spinner.error(pc.red("Failed to ensure helper daemon is ready."));
      log.info(pc.dim("Inspect status with `masir status` or view logs with `masir logs`."));
      process.exit(1);
    }

    spinner.message(isTun ? "Configuring Xray in TUN mode..." : "Configuring Xray in Proxy mode...");

    const res = callHelper<ResponseOf<"start">>({
      assetsPath: args.assets ? String(args.assets) : undefined,
      tun: isTun,
      type: "start",
    });

    if (!res.ok) {
      spinner.error(pc.red(`Failed to start Xray: ${res.error}`));
      log.info(pc.dim("Inspect status with `masir status` or view logs with `masir logs`."));
      process.exit(1);
    }

    const { status, mode, pid, apiPort } = res.result;

    if (status === "already-running") {
      const modeLabel = mode === "tun" ? "TUN" : "Proxy";
      spinner.stop(pc.cyan(`Xray is already running in ${modeLabel} mode.`));
      console.log(`\n${renderStatusTree()}`);
      return;
    }

    if (status === "tun-enabled") {
      spinner.stop(pc.green("TUN mode enabled on running Xray (tun-in interface added)."));
      console.log(`\n${renderStatusTree()}`);
      return;
    }

    if (status === "tun-disabled") {
      spinner.stop(pc.green("TUN mode disabled on running Xray (running in Proxy mode)."));
      console.log(`\n${renderStatusTree()}`);
      return;
    }

    const modeLabel = mode === "tun" ? "TUN mode" : "Proxy mode";
    spinner.stop(pc.green(`Xray started successfully in ${modeLabel} (PID: ${pid}, Port: ${apiPort}).`));
    console.log(`\n${renderStatusTree()}`);
  },
});
