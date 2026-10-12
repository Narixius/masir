import { homedir } from "node:os";

import pc from "picocolors";

import { formatHumanName, humanizeGeoValue } from "../../services/geo/geo.js";
import { findPinnedNode } from "../../services/rules/pins.js";
import type { RuleOutbound, RuleVia, UserRule, XrayRuleJson } from "../../services/rules/schema.js";
import { getAllOutbounds } from "../../services/subscription/storage.js";
import { displayLabel } from "../../utils/terminal-text.js";

export const shortenPath = (path: string): string => {
  const home = homedir();
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`;
  }
  return path;
};

const outboundText = (outbound: RuleOutbound): string => {
  if (outbound === "block") {
    return pc.red(outbound);
  }
  return outbound === "direct" ? pc.green(outbound) : pc.cyan(outbound);
};

/** `geosite:category-ir` -> `geosite:category-ir (🇮🇷 Iranian Websites)`; other values unchanged. */
const withHumanName = (value: string): string => {
  const name = humanizeGeoValue(value);
  return name ? `${value} ${pc.dim(`(${formatHumanName(name)})`)}` : value;
};

export interface MatcherTreeItem {
  readonly label: string;
  readonly value: string;
}

/** Individual matcher items for tree rendering, expanding lists like processes onto their own branches. */
export const matcherTreeItems = (rule: XrayRuleJson): MatcherTreeItem[] => {
  const items: MatcherTreeItem[] = [];
  if (rule.domain) {
    for (const d of rule.domain) {
      items.push({ label: "domain", value: withHumanName(d) });
    }
  }
  if (rule.ip) {
    for (const ip of rule.ip) {
      items.push({ label: "ip", value: withHumanName(ip) });
    }
  }
  if (rule.port !== undefined) {
    items.push({ label: "port", value: rule.port });
  }
  if (rule.network !== undefined) {
    items.push({ label: "network", value: rule.network });
  }
  if (rule.process) {
    for (const p of rule.process) {
      items.push({ label: "process", value: shortenPath(p) });
    }
  }
  if (rule.protocol) {
    for (const proto of rule.protocol) {
      items.push({ label: "protocol", value: proto });
    }
  }
  if (rule.source) {
    for (const s of rule.source) {
      items.push({ label: "source", value: s });
    }
  }
  if (rule.sourcePort !== undefined) {
    items.push({ label: "source port", value: rule.sourcePort });
  }
  if (rule.inboundTag) {
    for (const tag of rule.inboundTag) {
      items.push({ label: "inbound", value: tag });
    }
  }
  if (rule.user) {
    for (const u of rule.user) {
      items.push({ label: "user", value: u });
    }
  }
  if (rule.attrs) {
    for (const [key, value] of Object.entries(rule.attrs)) {
      items.push({ label: "attrs", value: `${key}=${value}` });
    }
  }
  return items;
};

/** `[label, value]` per matcher, in the order people think about them. */
export const matcherLines = (rule: XrayRuleJson): [string, string][] => {
  const lines: [string, string][] = [];
  const add = (label: string, value: string | readonly string[] | undefined): void => {
    if (value !== undefined) {
      lines.push([label, typeof value === "string" ? value : value.join(", ")]);
    }
  };
  add("domain", rule.domain?.map(withHumanName));
  add("ip", rule.ip?.map(withHumanName));
  add("port", rule.port);
  add("network", rule.network);
  add("process", rule.process?.map(shortenPath));
  add("protocol", rule.protocol);
  add("source", rule.source);
  add("source port", rule.sourcePort);
  add("inbound", rule.inboundTag);
  add("user", rule.user);
  if (rule.attrs) {
    add(
      "attrs",
      Object.entries(rule.attrs).map(([key, value]) => `${key}=${value}`)
    );
  }
  return lines;
};

/** The pinned node's name, or why the pin is not in effect. */
const pinText = (via: RuleVia): { readonly text: string; readonly missing: boolean } => {
  const node = findPinnedNode(via, getAllOutbounds());
  return node
    ? { missing: false, text: displayLabel(node.outbound) }
    : { missing: true, text: `${via.nodeId} (gone: uses the active proxy)` };
};

/** Where the rule sends traffic, as plain text: `direct`, or `proxy via 🇩🇪 Germany`. */
export const targetText = (rule: UserRule): string => (rule.via ? `proxy via ${pinText(rule.via).text}` : rule.rule.outboundTag);

export const coloredTarget = (rule: UserRule): string => {
  if (!rule.via) {
    return outboundText(rule.rule.outboundTag);
  }
  const pin = pinText(rule.via);
  return `${outboundText("proxy")} ${pc.dim("via")} ${pin.missing ? pc.yellow(pin.text) : pin.text}`;
};

/** `1. name → direct` followed by tree branches for each matcher. */
export const describeRule = (rule: UserRule, position?: number): string[] => {
  const prefix = position === undefined ? "" : pc.dim(`${position}. `);
  const header = `${prefix}${pc.bold(rule.name)} ${pc.dim("→")} ${coloredTarget(rule)}`;
  const items = matcherTreeItems(rule.rule);
  if (items.length === 0) {
    return [header];
  }
  const lines = [header];
  const indent = position === undefined ? "  " : " ".repeat(String(position).length + 2);
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    const branch = isLast ? pc.dim("└─") : pc.dim("├─");
    lines.push(`${indent}${branch} ${pc.gray(`${item.label}:`)} ${item.value}`);
  }
  return lines;
};
