import { createLogger } from "evlog";

import { loadSettings } from "../../config/settings.js";
import { runXray } from "../run-xray.js";
import { xray } from "../xray.js";
import { listSubscriptions } from "./storage.js";
import type { SubscriptionUpdateOutcome } from "./types.js";
import { updateSubscriptions } from "./updater.js";

/** How often the daemon checks whether a subscription is due for refresh. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

/** Refresh subscriptions inside the daemon, reloading xray when the active node's settings changed. */
export const syncSubscriptions = async (names: readonly string[]): Promise<readonly SubscriptionUpdateOutcome[]> => {
  const log = createLogger({ operation: "subscription.sync" });
  const { outcomes, needsReload } = await updateSubscriptions(names);

  for (const outcome of outcomes) {
    if (!outcome.ok) {
      log.error(`Failed to update subscription "${outcome.name}": ${outcome.error}`);
    } else if (outcome.activeNodeStatus === "removed") {
      log.warn(`Active node was removed from subscription "${outcome.name}" by provider`);
    }
  }

  if (needsReload && xray.isRunning()) {
    log.info("Active node settings changed, reloading Xray...");
    await runXray({ reload: true, tun: xray.getMode() === "tun" });
  }
  log.emit();
  return outcomes;
};

/** Resolve `sub:update`'s optional name into the subscriptions to refresh. */
export const resolveSyncTargets = (name?: string): string[] => {
  const all = listSubscriptions().map((sub) => sub.name);
  if (name === undefined) {
    return all;
  }
  if (!all.includes(name)) {
    throw new Error(`Subscription "${name}" not found`);
  }
  return [name];
};

const dueSubscriptions = (now: number): string[] => {
  const { subUpdateIntervalMinutes } = loadSettings();
  return listSubscriptions()
    .filter((sub) => now - sub.updatedAt >= (sub.updateIntervalMinutes ?? subUpdateIntervalMinutes) * MS_PER_MINUTE)
    .map((sub) => sub.name);
};

export const checkAndRunAutoUpdate = async (): Promise<void> => {
  const due = dueSubscriptions(Date.now());
  if (due.length > 0) {
    createLogger({ operation: "subscription.auto-update" }).info(`Auto-updating: ${due.join(", ")}`);
    await syncSubscriptions(due);
  }
};

export const startSubscriptionSyncDaemon = (): NodeJS.Timeout =>
  setInterval(() => {
    void checkAndRunAutoUpdate();
  }, CHECK_INTERVAL_MS);
