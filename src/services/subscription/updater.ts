import { loadRules, pinnedNodeIds } from "../rules/storage.js";
import { stableStringify } from "./id.js";
import { findClosestProxy } from "./matcher.js";
import { fetchAndParseSubscription } from "./parser.js";
import { getActiveNode, getSubscription, saveSubscription, setActiveNode } from "./storage.js";
import { SUBSCRIPTION_FORMAT_VERSION } from "./types.js";
import type { ActiveNodeStatus, ManagedOutbound, SubscriptionMeta, SubscriptionUpdateOutcome } from "./types.js";

export interface UpdateSubscriptionResult {
  readonly meta: SubscriptionMeta;
  readonly outbounds: readonly ManagedOutbound[];
  readonly activeNodeStatus: ActiveNodeStatus;
  /** A node some rule is pinned to changed or disappeared: the running config is stale. */
  readonly pinnedNodesChanged: boolean;
  readonly removedActiveNode?: ManagedOutbound;
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
  const activeNode = getActiveNode();
  const isActiveSub = activeNode !== null && activeNode.subName === name;
  const previousActive = isActiveSub ? current.outbounds.find((ob) => ob.id === activeNode.outbound.id) : undefined;

  let activeNodeStatus: ActiveNodeStatus = "not-active";
  let savedOutbounds = outbounds;
  let removedActiveNode: ManagedOutbound | undefined;
  let newActiveIdToSet: string | undefined;

  if (previousActive) {
    const exactNext = outbounds.find((ob) => ob.id === previousActive.id);
    if (exactNext) {
      activeNodeStatus = connectionFingerprint(previousActive) === connectionFingerprint(exactNext) ? "unchanged" : "changed";
    } else if (outbounds.length > 0) {
      const prevIdx = current.outbounds.findIndex((ob) => ob.id === previousActive.id);
      const closest = findClosestProxy(previousActive, outbounds, prevIdx !== -1 ? prevIdx : 0);
      if (closest) {
        if (closest.isStructureUpdate) {
          // Confidently the same server with new details: stay connected to it.
          activeNodeStatus = "changed";
          newActiveIdToSet = closest.best.id;
        } else {
          // No confident match: keep the old config saved so the connection is unchanged;
          // an interactive `sub update` then asks for a new proxy.
          activeNodeStatus = "removed";
          savedOutbounds = [...outbounds, previousActive];
          removedActiveNode = previousActive;
        }
      }
    } else {
      activeNodeStatus = "removed";
      savedOutbounds = [previousActive];
      removedActiveNode = previousActive;
    }
  }

  const nextMeta: SubscriptionMeta = {
    ...current.meta,
    formatVersion: SUBSCRIPTION_FORMAT_VERSION,
    nodeCount: savedOutbounds.length,
    updatedAt: Date.now(),
    userinfo: userinfo ?? current.meta.userinfo,
  };

  saveSubscription(nextMeta, savedOutbounds);

  if (newActiveIdToSet) {
    setActiveNode(newActiveIdToSet, name);
  }

  const pinnedNodesChanged = pinnedNodeIds(loadRules()).some((id) => {
    const status = compareActiveNode(id, current.outbounds, outbounds);
    return status === "changed" || status === "removed";
  });
  return {
    activeNodeStatus,
    meta: nextMeta,
    outbounds: savedOutbounds,
    pinnedNodesChanged,
    removedActiveNode,
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
      outcomes.push({
        activeNodeStatus: result.activeNodeStatus,
        name,
        nodeCount: result.outbounds.length,
        ok: true,
        removedActiveNode: result.removedActiveNode,
      });
    } catch (error: unknown) {
      outcomes.push({ error: error instanceof Error ? error.message : String(error), name, ok: false });
    }
  }
  return {
    needsReload,
    outcomes,
  };
};
