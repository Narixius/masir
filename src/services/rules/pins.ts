// Rules pinned to one proxy node (`masir rules add --via <node-id>`). Each
// pinned node becomes its own xray outbound, `node-<id>`, and its rules point
// there. A pin whose node no longer exists (subscription removed, or the
// provider dropped it) falls back to the active proxy: the rule keeps working.
import { toXrayOutbound } from "../config-manager.js";
import type { XrayOutbound } from "../config-manager.js";
import { getAllOutbounds } from "../subscription/storage.js";
import type { NodeRef } from "../subscription/storage.js";
import type { RuleVia, UserRule } from "./schema.js";
import { toXrayRules } from "./storage.js";
import type { TaggedXrayRule } from "./storage.js";

const PINNED_TAG_PREFIX = "node-";

/** The node a pin refers to, if it still exists (its own subscription first, then anywhere). */
export const findPinnedNode = (via: RuleVia, nodes: readonly NodeRef[]): NodeRef | undefined =>
  nodes.find((node) => node.outbound.id === via.nodeId && node.subName === via.subName) ??
  nodes.find((node) => node.outbound.id === via.nodeId);

export interface RoutingForRules {
  /** The rules as xray gets them, pins resolved. */
  readonly userRules: TaggedXrayRule[];
  /** One outbound per pinned node in use (not the active node: that is "proxy" already). */
  readonly outbounds: XrayOutbound[];
}

/** Rules and the extra outbounds they need, for a config whose active node is `activeNodeId`. */
export const routingForRules = (rules: readonly UserRule[], activeNodeId: string | undefined): RoutingForRules => {
  const nodes = getAllOutbounds();
  const tags = new Map<string, string>();
  const outbounds: XrayOutbound[] = [];
  const outboundFor = (rule: UserRule): string | undefined => {
    const node = rule.via ? findPinnedNode(rule.via, nodes) : undefined;
    if (!node) {
      return undefined;
    }
    const { id } = node.outbound;
    if (id === activeNodeId) {
      return undefined;
    }
    let tag = tags.get(id);
    if (!tag) {
      tag = `${PINNED_TAG_PREFIX}${id}`;
      tags.set(id, tag);
      outbounds.push(toXrayOutbound(node.outbound, tag));
    }
    return tag;
  };
  return { outbounds, userRules: toXrayRules(rules, outboundFor) };
};
