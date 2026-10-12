import pc from "picocolors";

import { findPinnedNode } from "../../services/rules/pins.js";
import type { RuleOutbound, RuleVia, UserRule, XrayRuleJson } from "../../services/rules/schema.js";
import { getAllOutbounds } from "../../services/subscription/storage.js";
import { displayLabel } from "../../utils/terminal-text.js";

const outboundText = (outbound: RuleOutbound): string => {
  if (outbound === "block") {
    return pc.red(outbound);
  }
  return outbound === "direct" ? pc.green(outbound) : pc.cyan(outbound);
};

/** `[label, value]` per matcher, in the order people think about them. */
export const matcherLines = (rule: XrayRuleJson): [string, string][] => {
  const lines: [string, string][] = [];
  const add = (label: string, value: string | readonly string[] | undefined): void => {
    if (value !== undefined) {
      lines.push([label, typeof value === "string" ? value : value.join(", ")]);
    }
  };
  add("domain", rule.domain);
  add("ip", rule.ip);
  add("port", rule.port);
  add("network", rule.network);
  add("process", rule.process);
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

const coloredTarget = (rule: UserRule): string => {
  if (!rule.via) {
    return outboundText(rule.rule.outboundTag);
  }
  const pin = pinText(rule.via);
  return `${outboundText("proxy")} ${pc.dim("via")} ${pin.missing ? pc.yellow(pin.text) : pin.text}`;
};

/** `1. name → direct` followed by one indented line per matcher. */
export const describeRule = (rule: UserRule, position?: number): string[] => {
  const prefix = position === undefined ? "" : pc.dim(`${position}. `);
  const lines = [`${prefix}${pc.bold(rule.name)} ${pc.dim("→")} ${coloredTarget(rule)}`];
  for (const [label, value] of matcherLines(rule.rule)) {
    lines.push(`   ${pc.gray(`${label}:`)} ${value}`);
  }
  return lines;
};
