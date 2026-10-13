// The grouped proxy list with live latency (one group per subscription),
// shared by `masir sub use` and rules pinned to a proxy (`--via`).
import pc from "picocolors";

import { outboundLabel } from "../../services/subscription/label.js";
import { getActiveNode, listSubscriptions } from "../../services/subscription/storage.js";
import type { NodeRef } from "../../services/subscription/storage.js";
import type { SubscriptionMeta } from "../../services/subscription/types.js";
import { formatBytes } from "../../utils/format.js";
import { createLatencyClient, latencyRefresher } from "../../utils/latency-client.js";
import { liveSelectPrompt } from "../../utils/prompts.js";
import type { LiveRow } from "../../utils/prompts.js";
import { displayLabel, terminalText } from "../../utils/terminal-text.js";

const MS_PER_SECOND = 1000;

/** `12 configs · 3.20 GB / 50.00 GB · expires 2026-11-02` */
const groupSummary = (meta: SubscriptionMeta | undefined, count: number, now: number): string => {
  const parts = [`${count} config${count === 1 ? "" : "s"}`];
  const info = meta?.userinfo;
  if (info) {
    const used = info.upload + info.download;
    parts.push(info.total > 0 ? `${formatBytes(used)} / ${formatBytes(info.total)}` : `${formatBytes(used)} used`);
    if (info.expire > 0) {
      const expiry = info.expire * MS_PER_SECOND;
      const date = new Date(expiry).toISOString().slice(0, 10);
      parts.push(expiry < now ? pc.red(`expired ${date}`) : `expires ${date}`);
    }
  }
  return parts.join(" · ");
};

interface Picker {
  readonly rows: LiveRow<string>[];
  /** Node id per row, "" for group headers (what the latency refresher tests). */
  readonly rowIds: string[];
  /** Row value -> node. */
  readonly nodes: Map<string, NodeRef>;
  readonly defaultValue?: string;
}

/** One group per subscription (by name), each headed by its usage summary. */
const buildPicker = (all: readonly NodeRef[], active: NodeRef | null): Picker => {
  const metaByName = new Map<string, SubscriptionMeta>();
  for (const meta of listSubscriptions()) {
    metaByName.set(meta.name, meta);
  }
  const groups = new Map<string, NodeRef[]>();
  for (const node of all) {
    const group = groups.get(node.subName);
    if (group) {
      group.push(node);
    } else {
      groups.set(node.subName, [node]);
    }
  }

  const rows: LiveRow<string>[] = [];
  const rowIds: string[] = [];
  const nodes = new Map<string, NodeRef>();
  let defaultValue: string | undefined;
  const now = Date.now();
  const names = [...groups.keys()].toSorted((a, b) => a.localeCompare(b));
  for (const name of names) {
    const members = groups.get(name) ?? [];
    rows.push({
      header: true,
      label: `${pc.bold(terminalText(name))}  ${pc.dim(groupSummary(metaByName.get(name), members.length, now))}`,
      value: "",
    });
    rowIds.push("");
    for (const node of members) {
      // Row values must be unique; the same node id can appear in two subscriptions.
      const value = String(rows.length);
      const isActive = active?.subName === node.subName && active.outbound.id === node.outbound.id;
      const activeMark = isActive ? ` ${pc.green("(active)")}` : "";
      // Filter on the logical-order name: the label may be display-reordered (RTL remarks).
      const search = `${outboundLabel(node.outbound)} ${node.outbound.protocol} ${node.subName}`;
      rows.push({ header: false, label: `${displayLabel(node.outbound)} ${pc.dim(node.outbound.protocol)}${activeMark}`, search, value });
      rowIds.push(node.outbound.id);
      nodes.set(value, node);
      if (isActive) {
        defaultValue = value;
      }
    }
  }
  return { defaultValue, nodes, rowIds, rows };
};

/** Let the user pick one node; the active one is marked and preselected. */
export const pickNode = async (
  all: readonly NodeRef[],
  message: string,
  options?: { readonly allowCancel?: boolean }
): Promise<NodeRef | undefined> => {
  const picker = buildPicker(all, getActiveNode());
  const latency = createLatencyClient();
  try {
    const value = options?.allowCancel
      ? await liveSelectPrompt({
          allowCancel: true,
          defaultValue: picker.defaultValue,
          message,
          refresh: latencyRefresher(latency, picker.rowIds),
          rows: picker.rows,
        })
      : await liveSelectPrompt({
          defaultValue: picker.defaultValue,
          message,
          refresh: latencyRefresher(latency, picker.rowIds),
          rows: picker.rows,
        });
    return value === undefined ? undefined : picker.nodes.get(value);
  } finally {
    await latency.close();
  }
};
