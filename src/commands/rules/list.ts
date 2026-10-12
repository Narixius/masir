import { defineCommand } from "citty";
import pc from "picocolors";

import { routingForRules } from "../../services/rules/pins.js";
import { loadRules } from "../../services/rules/storage.js";
import { getActiveNodeId } from "../../services/subscription/storage.js";
import { log, note } from "../../utils/log.js";
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
    description: "List routing rules in match order",
    name: "list",
  },
  run({ args }) {
    const rules = loadRules();
    if (args.json) {
      console.log(JSON.stringify(routingForRules(rules, getActiveNodeId()).userRules, null, 2));
      return;
    }
    if (rules.length === 0) {
      log.info("No routing rules. Add one with `masir rules add --name <name> --domain <domain> --outbound direct`.");
      return;
    }
    const sections = rules.map((rule, i) => describeRule(rule, i + 1).join("\n"));
    sections.push(pc.dim("Top to bottom, the first match wins. DNS and LAN rules are built in."));
    note(sections.join("\n\n"), `Routing rules (${rules.length})`);
  },
});
