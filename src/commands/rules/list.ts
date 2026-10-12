import { defineCommand } from "citty";
import pc from "picocolors";

import { loadSettings } from "../../config/settings.js";
import { routingForRules } from "../../services/rules/pins.js";
import { loadRules } from "../../services/rules/storage.js";
import { getActiveNodeId } from "../../services/subscription/storage.js";
import { log } from "../../utils/log.js";
import { describeRule } from "./describe.js";

export const rulesListCommand = defineCommand({
  args: {
    json: {
      default: false,
      description: "print the rules exactly as xray receives them",
      type: "boolean",
    },
  },
  meta: {
    alias: ["ls"],
    description: "List routing rules in match order",
    name: "list",
  },
  run({ args }) {
    const rules = loadRules();
    const { routingMode } = loadSettings();
    const modeLabel = routingMode === "direct" ? pc.green("direct") : pc.cyan("proxy");
    if (args.json) {
      console.log(JSON.stringify(routingForRules(rules, getActiveNodeId()).userRules, null, 2));
      return;
    }
    if (rules.length === 0) {
      log.info(
        `No custom routing rules (default mode: ${modeLabel}). Add one with \`masir rules add\` or switch mode with \`masir mode\`.`
      );
      return;
    }
    const lines: string[] = [`${pc.bold("Routing rules")} ${pc.dim(`(${rules.length})`)}`, ""];
    for (const [i, rule] of rules.entries()) {
      lines.push(describeRule(rule, i + 1).join("\n"));
      if (i < rules.length - 1) {
        lines.push("");
      }
    }
    lines.push(
      "",
      `${pc.bold(`${rules.length + 1}. default`)} ${pc.dim("→")} ${modeLabel} ${pc.dim("(catch-all • change with `masir mode`)")}`,
      "",
      pc.dim("Top to bottom, the first match wins. DNS and LAN rules are built in.")
    );
    console.log(lines.join("\n"));
  },
});
