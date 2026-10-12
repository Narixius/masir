// The "Connectivity" part of `masir status`: direct internet, the active
// proxy, and a one-line verdict, with spinners until the checks settle.
import { setTimeout as sleep } from "node:timers/promises";

import pc from "picocolors";

import type { LatencyEntry, NetDiagnosis } from "../protocol.js";
import { outboundLabel } from "../services/subscription/label.js";
import { getActiveNode, getSubscription } from "../services/subscription/storage.js";
import type { SubscriptionUserInfo } from "../services/subscription/types.js";
import { createLatencyClient, formatLatency } from "../utils/latency-client.js";
import { terminalText } from "../utils/terminal-text.js";

const FRAME_MS = 80;
/** Poll the checks every few frames; each poll is an IPC round trip. */
const POLL_EVERY_FRAMES = 2;
/** A dead proxy times out after ~5 s; give up waiting a little after that. */
const MAX_WAIT_MS = 15_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MS_PER_SECOND = 1000;

type VerdictLevel = "ok" | "warn" | "error";

export interface Verdict {
  readonly level: VerdictLevel;
  readonly text: string;
}

export interface ConnectivityReport {
  readonly diagnosis: NetDiagnosis;
  readonly proxyLabel?: string;
  readonly subscriptionIssue?: string;
  readonly verdict?: Verdict;
}

/** Expired or used-up subscription: the likeliest reason a proxy suddenly stops working. */
const subscriptionIssue = (name: string, info: SubscriptionUserInfo | undefined, now: number): string | undefined => {
  if (!info) {
    return undefined;
  }
  if (info.expire > 0 && info.expire * MS_PER_SECOND < now) {
    return `Subscription "${name}" expired on ${new Date(info.expire * MS_PER_SECOND).toISOString().slice(0, 10)}.`;
  }
  if (info.total > 0 && info.upload + info.download >= info.total) {
    return `Subscription "${name}" has used up its traffic quota.`;
  }
  return undefined;
};

const isOk = (entry: LatencyEntry | undefined): boolean => entry?.state === "ok";

export const verdictFor = (diagnosis: NetDiagnosis, issue?: string): Verdict | undefined => {
  if (!diagnosis.done) {
    return undefined;
  }
  const internet = isOk(diagnosis.direct);
  if (!diagnosis.proxy) {
    return internet
      ? { level: "warn", text: "Your internet works; no proxy is selected (`masir use`)." }
      : { level: "error", text: "No internet connection." };
  }
  const proxy = isOk(diagnosis.proxy);
  if (internet && proxy) {
    return { level: "ok", text: "Your internet and the proxy both work." };
  }
  if (proxy) {
    return { level: "ok", text: "The proxy works (direct internet access looks restricted)." };
  }
  if (internet) {
    const hint = issue ?? "Try another proxy with `masir use`.";
    return { level: "error", text: `Your internet works, but the proxy isn't responding. ${hint}` };
  }
  return { level: "error", text: "No internet connection: both the direct and the proxy checks failed." };
};

const entryText = (entry: LatencyEntry, frame: number): string => {
  if (entry.state === "pending") {
    return pc.cyan(SPINNER[frame % SPINNER.length] as string);
  }
  const detail = entry.state === "error" && entry.error ? pc.dim(` (${entry.error.split("\n")[0]})`) : "";
  return `${formatLatency(entry)}${detail}`;
};

const verdictText = (verdict: Verdict): string => {
  if (verdict.level === "ok") {
    return `${pc.green("✔")} ${verdict.text}`;
  }
  return verdict.level === "warn" ? `${pc.yellow("▲")} ${verdict.text}` : `${pc.red("✖")} ${verdict.text}`;
};

const renderLines = (report: ConnectivityReport, frame: number): string[] => {
  const { diagnosis } = report;
  const items: string[] = [`${pc.bold("Internet:")} ${entryText(diagnosis.direct, frame)} ${pc.dim("(direct)")}`];
  if (diagnosis.proxy) {
    const via = diagnosis.via === "running-xray" ? "via running xray" : "via test xray";
    items.push(
      `${pc.bold("Proxy:")} ${report.proxyLabel ? terminalText(report.proxyLabel) : diagnosis.proxy.id} ${entryText(diagnosis.proxy, frame)} ${pc.dim(`(${via})`)}`
    );
  } else {
    items.push(`${pc.bold("Proxy:")} ${pc.dim("none selected")}`);
  }
  if (report.verdict) {
    items.push(verdictText(report.verdict));
  }
  const lines = [pc.bold("Connectivity")];
  for (let i = 0; i < items.length; i += 1) {
    lines.push(`${i === items.length - 1 ? pc.dim("└─") : pc.dim("├─")} ${items[i]}`);
  }
  return lines;
};

/** Redraw the block in place: move up over the previous frame and clear it. */
const redraw = (lines: readonly string[], previousCount: number): number => {
  const up = previousCount > 0 ? `\u001B[${previousCount}A\u001B[J` : "";
  process.stdout.write(`${up}${lines.join("\n")}\n`);
  return lines.length;
};

const buildReport = (diagnosis: NetDiagnosis, proxyLabel: string | undefined, issue: string | undefined): ConnectivityReport => ({
  diagnosis,
  proxyLabel,
  subscriptionIssue: issue,
  verdict: verdictFor(diagnosis, issue),
});

/**
 * Run the checks and, when `render` is set, draw them (live on a TTY).
 * Resolves with the final report for `--json`.
 */
export const runConnectivityChecks = async (render: boolean): Promise<ConnectivityReport> => {
  const active = getActiveNode();
  const proxyLabel = active ? outboundLabel(active.outbound) : undefined;
  const issue = active ? subscriptionIssue(active.subName, getSubscription(active.subName)?.meta.userinfo, Date.now()) : undefined;
  const live = render && Boolean(process.stdout.isTTY);

  const client = createLatencyClient();
  try {
    let diagnosis = client.diagnose(true);
    let drawn = 0;
    let frame = 0;
    const deadline = Date.now() + MAX_WAIT_MS;
    while (!diagnosis.done && Date.now() < deadline) {
      if (live) {
        drawn = redraw(renderLines(buildReport(diagnosis, proxyLabel, issue), frame), drawn);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      await sleep(FRAME_MS);
      frame += 1;
      if (frame % POLL_EVERY_FRAMES === 0) {
        diagnosis = client.diagnose(false);
      }
    }
    const report = buildReport(diagnosis, proxyLabel, issue);
    if (render) {
      redraw(renderLines(report, frame), live ? drawn : 0);
    }
    return report;
  } finally {
    await client.close();
  }
};
