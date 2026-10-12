import { defineCommand } from "citty";
import pc from "picocolors";

import { updateXrayCore } from "../services/xray-updater.js";
import { setExitCode } from "../utils/exit-code.js";
import { log } from "../utils/log.js";

const updateXrayCommand = defineCommand({
  args: {
    force: {
      alias: "f",
      default: false,
      description: "re-download even if already on the latest version",
      type: "boolean",
    },
    proxy: {
      alias: "x",
      description: "download through the configured local mixed proxy port (--no-proxy to bypass)",
      type: "boolean",
    },
  },
  meta: {
    alias: ["xray"],
    description: "Download and install the latest Xray-core pre-release from GitHub (XTLS/Xray-core)",
    name: "xray-core",
  },
  async run({ args }) {
    const proxy = typeof args.proxy === "boolean" ? args.proxy : undefined;
    const ok = await updateXrayCore({ force: Boolean(args.force), proxy });
    if (!ok) {
      setExitCode(1);
    }
  },
});

export const updateCommand = defineCommand({
  meta: {
    description: "Update masir or xray-core (`masir update xray-core`)",
    name: "update",
  },
  run({ rawArgs }) {
    if (rawArgs.length > 0) {
      return;
    }
    log.info(`Self-update for the masir binary is coming soon. To update Xray-core, run ${pc.bold("`masir update xray-core`")}.`);
  },
  subCommands: {
    "xray-core": updateXrayCommand,
  },
});
