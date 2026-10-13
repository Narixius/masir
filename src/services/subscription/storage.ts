import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { getAppDirs, withFileLock, writeFileEnsured } from "../../utils/fs.js";
import type { ManagedOutbound, SubscriptionMeta, SubscriptionsIndex } from "./types.js";

// Both the CLI and the daemon (auto-update) change these files. Every
// read-modify-write of the index runs under `withIndexLock`, and every write
// is atomic (see `writeFileEnsured`).

export interface NodeRef {
  readonly subName: string;
  readonly outbound: ManagedOutbound;
}

const getSubsDir = (): string => join(getAppDirs().data, "subs");
const getIndexPath = (): string => join(getSubsDir(), "subscriptions.json");
const withIndexLock = <T>(fn: () => T): T => withFileLock(join(getSubsDir(), "subscriptions.lock"), fn);

const sanitizeName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^\.+|\.+$/u, "");

export const getSubFilePath = (name: string): string => join(getSubsDir(), `${sanitizeName(name)}.json`);

const EMPTY_INDEX: SubscriptionsIndex = { subscriptions: {} };

export const loadIndex = (): SubscriptionsIndex => {
  const indexPath = getIndexPath();
  if (!existsSync(indexPath)) {
    return EMPTY_INDEX;
  }
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as SubscriptionsIndex;
    if (typeof parsed === "object" && parsed !== null && typeof parsed.subscriptions === "object") {
      return parsed;
    }
  } catch {
    // Invalid JSON: treat as empty
  }
  return EMPTY_INDEX;
};

const saveIndex = (index: SubscriptionsIndex): void => {
  writeFileEnsured(getIndexPath(), JSON.stringify(index, null, 2));
};

/** The stored outbounds of one subscription, without re-reading the index. */
const readOutbounds = (name: string): ManagedOutbound[] | null => {
  try {
    const outbounds: unknown = JSON.parse(readFileSync(getSubFilePath(name), "utf-8"));
    return Array.isArray(outbounds) ? (outbounds as ManagedOutbound[]) : null;
  } catch {
    return null;
  }
};

/** Every node of every subscription, preferred subscription first. Reads each file once. */
const collectNodes = (index: SubscriptionsIndex, preferredSub?: string): NodeRef[] => {
  const names = Object.keys(index.subscriptions);
  const ordered = preferredSub && names.includes(preferredSub) ? [preferredSub, ...names.filter((n) => n !== preferredSub)] : names;
  const nodes: NodeRef[] = [];
  for (const subName of ordered) {
    for (const outbound of readOutbounds(subName) ?? []) {
      nodes.push({ outbound, subName });
    }
  }
  return nodes;
};

export const listSubscriptions = (): SubscriptionMeta[] =>
  Object.values(loadIndex().subscriptions).toSorted((a, b) => b.updatedAt - a.updatedAt);

export const getSubscription = (name: string): { meta: SubscriptionMeta; outbounds: ManagedOutbound[] } | null => {
  const meta = loadIndex().subscriptions[name];
  if (!meta) {
    return null;
  }
  const outbounds = readOutbounds(name);
  return outbounds ? { meta, outbounds } : null;
};

/** Another subscription whose name maps to the same file (e.g. "My Sub" vs "my-sub"). */
export const findNameConflict = (name: string): string | undefined => {
  const file = getSubFilePath(name);
  return Object.keys(loadIndex().subscriptions).find((other) => other !== name && getSubFilePath(other) === file);
};

export const saveSubscription = (meta: SubscriptionMeta, outbounds: readonly ManagedOutbound[]): void => {
  withIndexLock(() => {
    const conflict = findNameConflict(meta.name);
    if (conflict) {
      throw new Error(`Subscription name "${meta.name}" clashes with existing "${conflict}"; choose another name`);
    }
    writeFileEnsured(getSubFilePath(meta.name), JSON.stringify(outbounds, null, 2));
    const index = loadIndex();
    saveIndex({ ...index, subscriptions: { ...index.subscriptions, [meta.name]: meta } });
  });
};

export const removeSubscription = (name: string): boolean =>
  withIndexLock(() => {
    const index = loadIndex();
    if (!index.subscriptions[name]) {
      return false;
    }
    rmSync(getSubFilePath(name), { force: true });

    const subscriptions = Object.fromEntries(Object.entries(index.subscriptions).filter(([key]) => key !== name));
    const wasActiveSub = index.activeSubscriptionName === name;
    saveIndex({
      ...index,
      activeNodeId: wasActiveSub ? undefined : index.activeNodeId,
      activeSubscriptionName: wasActiveSub ? undefined : index.activeSubscriptionName,
      subscriptions,
    });
    return true;
  });

export const pruneOutbound = (subName: string, outboundId: string): boolean => {
  const sub = getSubscription(subName);
  if (!sub) {
    return false;
  }
  const filtered = sub.outbounds.filter((ob) => ob.id !== outboundId);
  if (filtered.length === sub.outbounds.length) {
    return false;
  }
  const nextMeta: SubscriptionMeta = {
    ...sub.meta,
    nodeCount: filtered.length,
  };
  saveSubscription(nextMeta, filtered);
  return true;
};

/** Make node `id` active; `subName` disambiguates when several subscriptions carry the same node. */
export const setActiveNode = (id: string, subName?: string): boolean =>
  withIndexLock(() => {
    const index = loadIndex();
    const match = collectNodes(index, subName).find((node) => node.outbound.id === id && (!subName || node.subName === subName));
    if (!match) {
      return false;
    }
    saveIndex({ ...index, activeNodeId: id, activeSubscriptionName: match.subName });
    return true;
  });

export const getActiveNodeId = (): string | undefined => loadIndex().activeNodeId;

export const getActiveNode = (): NodeRef | null => {
  const index = loadIndex();
  if (!index.activeNodeId) {
    return null;
  }
  return collectNodes(index, index.activeSubscriptionName).find((node) => node.outbound.id === index.activeNodeId) ?? null;
};

export const getAllOutbounds = (): NodeRef[] => collectNodes(loadIndex());
