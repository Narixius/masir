import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { loadRules, removeRules } from "../../services/rules/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { multiselectPrompt } from "../../utils/prompts.js";

export const rulesRmCommand = defineCommand({
  args: {
    names: {
      description: "names of the rules to remove",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Remove one or more routing rules",
    name: "rm",
  },
  async run({ args }) {
    const rules = loadRules();
    if (rules.length === 0) {
      log.info("No routing rules to remove.");
      return;
    }

    let names = args._.map(String).filter((name) => name.length > 0);
    if (names.length === 0) {
      if (!process.stdin.isTTY) {
        log.error(pc.red("Name the rules to remove: `masir rules rm <name>...`."));
        setExitCode(1);
        return;
      }
      names = await multiselectPrompt({
        message: "Select rules to remove",
        options: rules.map((rule) => ({ hint: `→ ${rule.rule.outboundTag}`, label: rule.name, value: rule.name })),
      });
      if (names.length === 0) {
        return;
      }
    }

    const removed = removeRules(names);
    for (const name of names) {
      if (removed.includes(name)) {
        log.step(pc.gray(`Removed rule "${name}"`));
      } else {
        log.warn(pc.yellow(`Rule "${name}" not found.`));
        setExitCode(1);
      }
    }
    if (removed.length === 0) {
      return;
    }

    const res = tryCallHelper<ResponseOf<"reload">>({ type: "reload" });
    if (res?.ok) {
      log.success(pc.green(`Removed ${removed.length} rule(s); the running xray was reloaded.`));
    } else if (res) {
      log.warn(pc.yellow(`Removed ${removed.length} rule(s), but reloading xray failed: ${res.error}`));
    } else {
      log.success(pc.green(`Removed ${removed.length} rule(s).`));
    }
  },
});
