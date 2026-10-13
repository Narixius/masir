import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { getAllOutbounds, listSubscriptions, pruneOutbound, setActiveNode } from "../../services/subscription/storage.js";
import type { SubscriptionUpdateOutcome } from "../../services/subscription/types.js";
import { updateSubscriptions } from "../../services/subscription/updater.js";
import { setExitCode } from "../../utils/exit-code.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { createSpinner } from "../../utils/spinner.js";
import { displayLabel } from "../../utils/terminal-text.js";
import { pickNode } from "./node-picker.js";

const reportOutcome = (outcome: SubscriptionUpdateOutcome): void => {
  if (!outcome.ok) {
    log.error(pc.red(`Failed to update "${outcome.name}": ${outcome.error}`));
    return;
  }
  log.step(pc.green(`Updated "${outcome.name}" (${outcome.nodeCount} configs).`));
  if (outcome.activeNodeStatus === "removed") {
    if (!process.stdin.isTTY) {
      log.warn(pc.yellow(`Warning: active config was removed from "${outcome.name}" by the provider. Kept active proxy in place.`));
    }
  } else if (outcome.activeNodeStatus === "changed") {
    log.step(pc.cyan(`Active config in "${outcome.name}" changed; running Xray reloads with it.`));
  }
};

const handleRemovedActiveNode = async (outcome: Extract<SubscriptionUpdateOutcome, { ok: true }>): Promise<void> => {
  const removedNode = outcome.removedActiveNode;
  if (!removedNode || !process.stdin.isTTY) {
    return;
  }

  log.warn(
    pc.yellow(`The current active proxy (${displayLabel(removedNode)}) was removed from subscription "${outcome.name}". Pick a new one:`)
  );

  const all = getAllOutbounds();
  if (all.length === 0) {
    return;
  }

  const chosen = await pickNode(all, "Choose active outbound configuration", { allowCancel: true });
  if (!chosen || chosen.outbound.id === removedNode.id) {
    log.info(pc.dim(`Keeping old active proxy ("${displayLabel(removedNode)}").`));
    return;
  }

  const targetId = chosen.outbound.id;
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
  pruneOutbound(outcome.name, removedNode.id);
};

/**
 * Refresh locally (the fetch can take longer than the IPC timeout), then let a
 * running daemon reload xray if the active node's settings changed.
 */
const updateLocally = async (names: readonly string[]): Promise<readonly SubscriptionUpdateOutcome[]> => {
  const spinner = createSpinner();
  spinner.start("Updating subscriptions...");
  const { outcomes, needsReload } = await updateSubscriptions(names, (name) => spinner.message(`Updating subscription "${name}"...`));
  spinner.stop(pc.green("Subscriptions fetched."));
  if (needsReload) {
    const res = tryCallHelper<ResponseOf<"sub:reload">>({ type: "sub:reload" });
    if (res && !res.ok) {
      log.warn(pc.yellow(`Running Xray was not reloaded: ${res.error}`));
    }
  }
  return outcomes;
};

export const subUpdateCommand = defineCommand({
  args: {
    name: {
      description: "Name of the subscription to update (optional; updates all if omitted)",
      type: "string",
    },
  },
  meta: {
    description: "Update one or all subscriptions",
    name: "update",
  },
  async run({ args }) {
    const subs = listSubscriptions();
    if (subs.length === 0) {
      log.info("No subscriptions found to update.");
      return;
    }

    const targetName = typeof args.name === "string" ? args.name.trim() : "";
    const targets = targetName.length > 0 ? subs.filter((s) => s.name === targetName) : subs;
    if (targets.length === 0) {
      log.error(pc.red(`Subscription "${targetName}" not found.`));
      setExitCode(1);
      return;
    }

    const outcomes = await updateLocally(targets.map((s) => s.name));
    for (const outcome of outcomes) {
      reportOutcome(outcome);
    }
    const successCount = outcomes.filter((o) => o.ok).length;
    log.success(pc.green(`Finished updating ${successCount} of ${targets.length} subscription(s).`));
    if (successCount < targets.length) {
      setExitCode(1);
    }

    let removedOutcome: Extract<SubscriptionUpdateOutcome, { ok: true }> | undefined;
    for (const o of outcomes) {
      if (o.ok && o.activeNodeStatus === "removed" && o.removedActiveNode !== undefined) {
        removedOutcome = o;
        break;
      }
    }
    if (removedOutcome) {
      await handleRemovedActiveNode(removedOutcome);
    }
  },
});
