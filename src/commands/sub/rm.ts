import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { listSubscriptions, removeSubscription } from "../../services/subscription/storage.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { multiselectPrompt } from "../../utils/prompts.js";

export const subRemoveCommand = defineCommand({
  args: {
    names: {
      description: "Names of subscriptions to remove",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Remove one or more subscriptions",
    name: "remove",
    alias: ["rm"],
  },
  async run({ args }) {
    const subs = listSubscriptions();
    if (subs.length === 0) {
      log.info("No subscriptions configured.");
      return;
    }

    // Positional names (e.g. `masir sub rm sub-1 sub-2`); citty collects all of them in `_`.
    const directNames = args._.map(String).filter((name) => name.length > 0);
    let toRemove: string[] = [];

    if (directNames.length > 0) {
      toRemove = directNames;
    } else {
      const options = subs.map((s) => ({
        hint: `${s.nodeCount} configs · updated ${new Date(s.updatedAt).toISOString().slice(0, 10)}`,
        label: s.name,
        value: s.name,
      }));

      const selected = await multiselectPrompt({
        message: "Select subscriptions to remove",
        options,
      });

      if (selected.length === 0) {
        return;
      }
      toRemove = selected;
    }

    let removedCount = 0;
    for (const name of toRemove) {
      if (removeSubscription(name)) {
        log.step(pc.gray(`Removed subscription "${name}"`));
        removedCount += 1;
      } else {
        log.warn(pc.yellow(`Subscription "${name}" not found.`));
      }
    }

    if (removedCount > 0) {
      log.success(pc.green(`Successfully removed ${removedCount} subscription(s).`));
      const res = tryCallHelper<ResponseOf<"sub:reload">>({ type: "sub:reload" });
      if (res && !res.ok) {
        log.warn(pc.yellow(`Running Xray was not reloaded: ${res.error}`));
      }
    }
  },
});
