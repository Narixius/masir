import { defineCommand } from "citty";
import pc from "picocolors";

import { getActiveNode, listSubscriptions } from "../../services/subscription/storage.js";
import { formatBytes, formatDate } from "../../utils/format.js";
import { log, note } from "../../utils/log.js";
import { displayLabel, terminalText } from "../../utils/terminal-text.js";

export const subListCommand = defineCommand({
  meta: {
    description: "List all subscriptions and traffic quotas",
    name: "list",
    alias: ["ls"],
  },
  run() {
    const subs = listSubscriptions();
    const active = getActiveNode();

    if (subs.length === 0) {
      log.info("No subscriptions found. Add one with `masir sub add <url>`.");
      return;
    }

    const sections: string[] = [];

    for (const sub of subs) {
      const isActiveSub = active?.subName === sub.name;
      const titlePrefix = isActiveSub ? pc.green("● ") : pc.gray("○ ");
      const nameTag = pc.bold(terminalText(sub.name));
      const activeTag = isActiveSub ? pc.cyan(` [Active: ${displayLabel(active.outbound)} (${active.outbound.id})]`) : "";

      const lines: string[] = [
        `${titlePrefix}${nameTag}${activeTag}`,
        `  ${pc.gray("URL:")} ${sub.url}`,
        `  ${pc.gray("Configs:")} ${sub.nodeCount} node(s)`,
        `  ${pc.gray("Updated:")} ${formatDate(sub.updatedAt)}`,
      ];

      if (sub.userinfo) {
        const used = sub.userinfo.upload + sub.userinfo.download;
        const { total } = sub.userinfo;
        const quotaStr = total > 0 ? `${formatBytes(used)} / ${formatBytes(total)}` : formatBytes(used);
        const expireStr = sub.userinfo.expire > 0 ? formatDate(sub.userinfo.expire * 1000) : "No expiration";

        lines.push(`  ${pc.gray("Traffic:")} ${quotaStr}`, `  ${pc.gray("Expires:")} ${expireStr}`);
      }

      sections.push(lines.join("\n"));
    }

    note(sections.join("\n\n"), `Configured Subscriptions (${subs.length})`);
  },
});
