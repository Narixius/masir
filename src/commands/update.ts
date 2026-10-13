import { defineCommand } from "citty";

import { updateMasir } from "../services/masir-updater.js";
import { updateXrayCore } from "../services/xray-updater.js";
import { setExitCode } from "../utils/exit-code.js";

const updateMasirCommand = defineCommand({
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
    alias: ["cli"],
    description: "Update the masir binary to the latest release from GitHub",
    name: "masir",
  },
  async run({ args }) {
    const proxy = typeof args.proxy === "boolean" ? args.proxy : undefined;
    const ok = await updateMasir({ force: Boolean(args.force), proxy });
    if (!ok) {
      setExitCode(1);
    }
  },
});

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
    description: "Update masir binary or xray-core (`masir update` or `masir update xray-core`)",
    name: "update",
  },
  async run({ args, rawArgs }) {
    // If a subcommand like xray-core was passed, citty handles it.
    // If bare `masir update` (or flags like `masir update -f`) was passed, update masir binary.
    const hasSubcommand = rawArgs.some((arg) => arg === "xray-core" || arg === "xray" || arg === "masir" || arg === "cli");
    if (!hasSubcommand) {
      const proxy = typeof args.proxy === "boolean" ? args.proxy : undefined;
      const ok = await updateMasir({ force: Boolean(args.force), proxy });
      if (!ok) {
        setExitCode(1);
      }
    }
  },
  subCommands: {
    masir: updateMasirCommand,
    "xray-core": updateXrayCommand,
  },
});
