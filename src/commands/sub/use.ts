import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { getAllOutbounds, listSubscriptions, setActiveNode } from "../../services/subscription/storage.js";
import { SUBSCRIPTION_FORMAT_VERSION } from "../../services/subscription/types.js";
import { updateSubscriptions } from "../../services/subscription/updater.js";
import { setExitCode } from "../../utils/exit-code.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { createSpinner } from "../../utils/spinner.js";
import { displayLabel } from "../../utils/terminal-text.js";
import { pickNode } from "./node-picker.js";

/**
 * Subscriptions saved before nodes carried remarks show every node as "proxy".
 * Refresh those once (the new format is recorded), so names appear.
 */
const backfillRemarks = async (): Promise<void> => {
  const stale = listSubscriptions()
    .filter((sub) => (sub.formatVersion ?? 1) < SUBSCRIPTION_FORMAT_VERSION)
    .map((sub) => sub.name);
  if (stale.length === 0) {
    return;
  }
  const spinner = createSpinner();
  spinner.start(`Loading server names for ${stale.join(", ")}...`);
  const { outcomes, needsReload } = await updateSubscriptions(stale);
  const failures = outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) {
    spinner.stop(pc.dim("Server names loaded."));
  } else {
    spinner.stop(pc.yellow(`Could not refresh ${failures.map((f) => f.name).join(", ")}; showing addresses instead.`));
  }
  if (needsReload) {
    tryCallHelper<ResponseOf<"sub:reload">>({ type: "sub:reload" });
  }
};

export const subUseCommand = defineCommand({
  args: {
    id: {
      description: "Short ID of the node to activate",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Switch active outbound configuration",
    name: "use",
  },
  async run({ args }) {
    const requestedId = typeof args.id === "string" ? args.id.trim() : "";
    if (requestedId.length === 0 && process.stdin.isTTY) {
      await backfillRemarks();
    }

    const all = getAllOutbounds();
    if (all.length === 0) {
      log.info("No outbound configs available. Add a subscription first with `masir sub add`.");
      return;
    }

    const chosen =
      requestedId.length > 0
        ? all.find((node) => node.outbound.id === requestedId)
        : await pickNode(all, "Choose active outbound configuration");
    if (!chosen) {
      log.error(pc.red(`Outbound node with ID "${requestedId}" not found in any subscription.`));
      setExitCode(1);
      return;
    }
    const targetId = chosen.outbound.id;

    // A running daemon owns the state: it records the choice and reloads xray.
    const res = tryCallHelper<ResponseOf<"sub:use">>({ id: targetId, subName: chosen.subName, type: "sub:use" });
    if (res && !res.ok) {
      log.error(pc.red(`Failed to switch outbound: ${res.error}`));
      setExitCode(1);
      return;
    }
    if (!res) {
      setActiveNode(targetId, chosen.subName);
    }

    log.success(pc.green(`Active outbound switched to "${displayLabel(chosen.outbound)}" [${targetId}].`));
    // if (res) {
    //   log.step(pc.cyan("Applied by the running daemon (xray reloaded if it was running)."));
    // }
  },
});
