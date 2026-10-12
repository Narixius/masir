import { loadRules, pinnedNodeIds } from "../rules/storage.js";
import { stableStringify } from "./id.js";
import { fetchAndParseSubscription } from "./parser.js";
import { getActiveNodeId, getSubscription, saveSubscription } from "./storage.js";
import { SUBSCRIPTION_FORMAT_VERSION } from "./types.js";
import type { ActiveNodeStatus, ManagedOutbound, SubscriptionMeta, SubscriptionUpdateOutcome } from "./types.js";

export interface UpdateSubscriptionResult {
  readonly meta: SubscriptionMeta;
  readonly outbounds: readonly ManagedOutbound[];
  readonly activeNodeStatus: ActiveNodeStatus;
  /** A node some rule is pinned to changed or disappeared: the running config is stale. */
  readonly pinnedNodesChanged: boolean;
}

/** The connection-relevant part of an outbound; tag and remarks are display only. */
const connectionFingerprint = (outbound: ManagedOutbound): string =>
  stableStringify({
    mux: outbound.mux,
    protocol: outbound.protocol,
    proxySettings: outbound.proxySettings,
    settings: outbound.settings,
    streamSettings: outbound.streamSettings,
  });

const compareActiveNode = (
  activeId: string | undefined,
  before: readonly ManagedOutbound[],
  after: readonly ManagedOutbound[]
): ActiveNodeStatus => {
  const previous = activeId ? before.find((ob) => ob.id === activeId) : undefined;
  if (!previous) {
    return "not-active";
  }
  const next = after.find((ob) => ob.id === activeId);
  if (!next) {
    return "removed";
  }
  return connectionFingerprint(previous) === connectionFingerprint(next) ? "unchanged" : "changed";
};

export const updateSubscription = async (name: string): Promise<UpdateSubscriptionResult> => {
  const current = getSubscription(name);
  if (!current) {
    throw new Error(`Subscription "${name}" not found`);
  }

  const { outbounds, userinfo } = await fetchAndParseSubscription(current.meta.url);
  const nextMeta: SubscriptionMeta = {
    ...current.meta,
    formatVersion: SUBSCRIPTION_FORMAT_VERSION,
    nodeCount: outbounds.length,
    updatedAt: Date.now(),
    userinfo: userinfo ?? current.meta.userinfo,
  };

  saveSubscription(nextMeta, outbounds);

  const pinnedNodesChanged = pinnedNodeIds(loadRules()).some((id) => {
    const status = compareActiveNode(id, current.outbounds, outbounds);
    return status === "changed" || status === "removed";
  });
  return {
    activeNodeStatus: compareActiveNode(getActiveNodeId(), current.outbounds, outbounds),
    meta: nextMeta,
    outbounds,
    pinnedNodesChanged,
  };
};

export interface UpdateSubscriptionsResult {
  readonly outcomes: readonly SubscriptionUpdateOutcome[];
  /** The active node or a pinned node changed, so a running xray must reload. */
  readonly needsReload: boolean;
}

/**
 * Refresh the named subscriptions one after another. Shared by `masir sub update`
 * (when no daemon runs) and the daemon's `sub:update` / auto-update.
 */
/** Whether a refresh means a running xray must be rebuilt. */
const needsReloadAfter = (result: UpdateSubscriptionResult): boolean => result.activeNodeStatus === "changed" || result.pinnedNodesChanged;

export const updateSubscriptions = async (
  names: readonly string[],
  onProgress?: (name: string) => void
): Promise<UpdateSubscriptionsResult> => {
  const outcomes: SubscriptionUpdateOutcome[] = [];
  let needsReload = false;
  for (const name of names) {
    onProgress?.(name);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const result = await updateSubscription(name);
      if (needsReloadAfter(result)) {
        needsReload = true;
      }
      outcomes.push({ activeNodeStatus: result.activeNodeStatus, name, nodeCount: result.outbounds.length, ok: true });
    } catch (error: unknown) {
      outcomes.push({ error: error instanceof Error ? error.message : String(error), name, ok: false });
    }
  }
  return {
    needsReload,
    outcomes,
  };
};
