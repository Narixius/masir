import { defineCommand } from "citty";
import pc from "picocolors";

import { loadSettings } from "../../config/settings.js";
import { isIpTarget, normalizeTarget, rulesInOrder, testRoute } from "../../services/rules/route-test.js";
import type { RouteResult } from "../../services/rules/route-test.js";
import { loadRules } from "../../services/rules/storage.js";
import { getActiveNode } from "../../services/subscription/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { log, note } from "../../utils/log.js";
import { displayLabel } from "../../utils/terminal-text.js";
import { targetText } from "./describe.js";

const PORT_MAX = 65_535;
const DEFAULT_PORT = 443;

const activeProxy = (): string => {
  const node = getActiveNode();
  return node ? `proxy (${displayLabel(node.outbound)})` : "proxy (none selected yet)";
};

/** Where the traffic goes, as people read it. */
const destination = (result: RouteResult): string => {
  const { matched } = result;
  if (!matched) {
    return loadSettings().routingMode === "direct" ? pc.green("direct") : pc.cyan(activeProxy());
  }
  if (matched.rule?.via) {
    return pc.cyan(targetText(matched.rule));
  }
  switch (matched.outboundTag) {
    case "direct": {
      return pc.green("direct");
    }
    case "block": {
      return pc.red("blocked");
    }
    case "proxy": {
      return pc.cyan(activeProxy());
    }
    default: {
      return pc.cyan(`${matched.outboundTag} (masir's DNS)`);
    }
  }
};

const ruleLine = (result: RouteResult): string => {
  const { matched } = result;
  if (!matched) {
    const mode = loadSettings().routingMode;
    const modeText = mode === "direct" ? pc.green("direct") : pc.cyan("the active proxy");
    return `${pc.gray("rule:")} none matched, so default mode (${modeText})`;
  }
  const position = matched.position === undefined ? "" : `${matched.position}. `;
  return `${pc.gray("rule:")} ${position}${pc.bold(matched.name)} ${pc.dim(`(${result.because.join(", ") || "matches everything"})`)}`;
};

export const rulesTestCommand = defineCommand({
  args: {
    network: { default: "tcp", description: "tcp or udp", type: "string" },
    port: { default: String(DEFAULT_PORT), description: "the destination port", type: "string" },
    process: { description: "the connecting app: a process name or full path", type: "string" },
    protocol: { description: "the sniffed protocol: http, tls, quic or bittorrent", type: "string" },
    target: { description: "a domain or IP, e.g. youtube.com or 10.0.0.5", required: true, type: "positional" },
  },
  meta: { description: "Show which rule routes a domain or IP, and where it goes", name: "test" },
  run({ args }) {
    const target = normalizeTarget(String(args.target));
    const port = Number(args.port);
    const network = String(args.network);
    if (!Number.isInteger(port) || port < 1 || port > PORT_MAX) {
      log.error(pc.red(`--port must be a port from 1 to ${PORT_MAX}.`));
      setExitCode(1);
      return;
    }
    if (network !== "tcp" && network !== "udp") {
      log.error(pc.red("--network must be tcp or udp."));
      setExitCode(1);
      return;
    }
    const result = testRoute(rulesInOrder(loadRules()), {
      network,
      port,
      process: args.process ? String(args.process) : undefined,
      protocol: args.protocol ? String(args.protocol) : undefined,
      target,
    });
    const lines = [`${pc.bold(target)}${pc.dim(`:${port}/${network}`)} ${pc.dim("→")} ${destination(result)}`, ruleLine(result)];
    if (result.notes.length > 0) {
      lines.push("");
      for (const text of result.notes) {
        lines.push(pc.dim(text));
      }
    }
    note(lines.join("\n"), isIpTarget(target) ? "Route for IP" : "Route for domain");
  },
});
