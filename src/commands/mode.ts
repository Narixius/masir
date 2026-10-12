import { defineCommand } from "citty";
import pc from "picocolors";

import { loadSettings, saveRoutingMode } from "../config/settings.js";
import type { RoutingMode } from "../config/settings.js";
import { setExitCode } from "../utils/exit-code.js";
import { log } from "../utils/log.js";
import { selectPrompt } from "../utils/prompts.js";
import { reloadDaemon } from "./rules/shared.js";

const formatMode = (mode: RoutingMode): string => (mode === "direct" ? pc.green("direct") : pc.cyan("proxy"));

const parseMode = (raw: string): RoutingMode | null => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "proxy" || normalized === "direct") {
    return normalized;
  }
  return null;
};

export const modeCommand = defineCommand({
  args: {
    mode: {
      description: "proxy or direct (catch-all route at the end of all rules)",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Switch the default catch-all routing mode (proxy or direct)",
    name: "mode",
  },
  async run({ args }) {
    const current = loadSettings().routingMode;
    const raw = typeof args.mode === "string" ? args.mode.trim() : "";

    let chosen: RoutingMode;
    if (raw.length > 0) {
      const parsed = parseMode(raw);
      if (!parsed) {
        log.error(pc.red(`Invalid mode "${raw}". Use "proxy" or "direct".`));
        setExitCode(1);
        return;
      }
      chosen = parsed;
    } else if (process.stdin.isTTY) {
      chosen = await selectPrompt<RoutingMode>({
        defaultValue: current,
        message: "Default routing mode (catch-all at the end of rules)",
        options: [
          { hint: "route unmatched traffic through the active proxy", label: "Proxy", value: "proxy" },
          { hint: "send unmatched traffic directly without proxy", label: "Direct", value: "direct" },
        ],
      });
    } else {
      console.log(current);
      return;
    }

    saveRoutingMode(chosen);
    const reloadNote = reloadDaemon();
    log.success(`${pc.green("Routing mode set to")} ${formatMode(chosen)} ${pc.dim(`(${reloadNote})`)}`);
  },
});
