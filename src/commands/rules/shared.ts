// Pieces shared by `rules add` and `rules edit`: matcher flags -> xray rule
// object, outbound/name resolution, the xray check, and applying to the daemon.
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { findApp, findRelated, listApps, listProcesses, ruleValuesFor } from "../../services/apps/apps.js";
import type { AppEntry } from "../../services/apps/apps.js";
import { asRuleOutbound, isValidRuleName, normalizeNetwork, RULE_OUTBOUNDS } from "../../services/rules/schema.js";
import type { RawRule, RuleOutbound, RuleVia, UserRule } from "../../services/rules/schema.js";
import { checkRulesWithXray } from "../../services/rules/validate.js";
import { getAllOutbounds } from "../../services/subscription/storage.js";
import type { NodeRef } from "../../services/subscription/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { log } from "../../utils/log.js";
import { liveSelectPrompt, multiselectPrompt, selectPrompt } from "../../utils/prompts.js";
import type { LiveRow } from "../../utils/prompts.js";
import { collectFlag, splitList } from "../../utils/raw-flags.js";
import { createSpinner } from "../../utils/spinner.js";
import { terminalText } from "../../utils/terminal-text.js";
import { pickNode } from "../sub/node-picker.js";

export type Step<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** Matcher flags; repeatable, so read from the raw argv (see utils/raw-flags.ts). */
export const MATCHER_FLAGS: readonly string[] = ["domain", "ip", "port", "network", "process", "protocol", "source", "source-port"];

/** citty definitions of the matcher flags (for help and completion; values come from `ruleFromFlags`). */
export const MATCHER_ARGS = {
  app: { description: 'an app and all its helper processes: --app "Google Chrome", or --app alone to pick one', type: "string" },
  domain: { description: "domain matcher, repeatable: google.com, geosite:ir, domain:x.com, full:, regexp:, keyword:", type: "string" },
  ip: { description: "IP matcher, repeatable: 1.1.1.1, 10.0.0.0/8, geoip:ir", type: "string" },
  network: { description: "tcp, udp, or tcp/udp", type: "string" },
  port: { description: "destination ports: 53, 1000-2000, 53,443", type: "string" },
  process: {
    description: 'exact process name, executable path, or a folder ending in / ("/Applications/Foo.app/" covers its helpers); repeatable',
    type: "string",
  },
  protocol: { description: "sniffed protocol, repeatable: http, tls, quic, bittorrent", type: "string" },
  source: { description: "source IP matcher, repeatable", type: "string" },
  "source-port": { description: "source ports, like --port", type: "string" },
} as const;

const OUTBOUND_HINTS: Record<RuleOutbound, string> = {
  block: "drop the connection",
  direct: "bypass the proxy",
  proxy: "send through the active proxy",
};

/** A rule being built or edited, before validation (see `parseRule`). */
export interface RuleInput {
  domain?: string[];
  ip?: string[];
  port?: string;
  network?: string;
  process?: string[];
  protocol?: string[];
  source?: string[];
  sourcePort?: string;
  user?: string[];
  inboundTag?: string[];
  attrs?: Record<string, string>;
  outboundTag?: string;
}

export const fail = (message: string): void => {
  log.error(pc.red(message));
  setExitCode(1);
};

export const text = (value: string | undefined): string => (typeof value === "string" ? value : "");

const isRegexp = (value: string): boolean => value.startsWith("regexp:");
const orUndefined = <T>(items: T[]): T[] | undefined => (items.length > 0 ? items : undefined);

/** `/Applications/Foo.app` as a process value matches nothing (it's a folder): make it a folder match. */
const asProcessValue = (value: string): string => (value.includes("/") && value.endsWith(".app") ? `${value}/` : value);

/** The xray rule fields described by the matcher flags; unset flags stay `undefined`. */
export const ruleFromFlags = (rawArgs: readonly string[]): RuleInput => {
  const list = (flag: string, keepWhole?: (value: string) => boolean): string[] => splitList(collectFlag(rawArgs, flag), keepWhole);
  const ports = list("port");
  const sourcePorts = list("source-port");
  const network = collectFlag(rawArgs, "network");
  return {
    domain: orUndefined(list("domain", isRegexp)),
    ip: orUndefined(list("ip")),
    network: network.length > 0 ? normalizeNetwork(network.join(",")) : undefined,
    port: ports.length > 0 ? ports.join(",") : undefined,
    // Paths may contain commas: one process per flag.
    process: orUndefined(
      collectFlag(rawArgs, "process")
        .filter((value) => value.length > 0)
        .map(asProcessValue)
    ),
    protocol: orUndefined(list("protocol").map((value) => value.toLowerCase())),
    source: orUndefined(list("source")),
    sourcePort: sourcePorts.length > 0 ? sourcePorts.join(",") : undefined,
  };
};

/** `--app` given, with or without a value (`--app` alone opens the picker). */
export const appFlagGiven = (rawArgs: readonly string[]): boolean =>
  rawArgs.some((token) => token === "--app" || token.startsWith("--app="));

export const usesMatcherFlags = (rawArgs: readonly string[]): boolean =>
  appFlagGiven(rawArgs) || MATCHER_FLAGS.some((flag) => collectFlag(rawArgs, flag).length > 0);

/** A bare name that is an app's name only matches its main process; point at `--app` instead. */
export const warnAboutBareAppNames = (rawArgs: readonly string[]): void => {
  const bare = collectFlag(rawArgs, "process").filter((value) => !value.includes("/"));
  if (bare.length === 0) {
    return;
  }
  const apps = listApps(listProcesses());
  for (const value of bare) {
    const app = apps.find((candidate) => candidate.bundle && candidate.name.toLowerCase() === value.toLowerCase());
    if (app) {
      log.warn(
        pc.yellow(
          `--process "${value}" matches only the main process, not ${app.name}'s helpers. Use --app "${app.name}" to cover them all.`
        )
      );
    }
  }
};

const shortHome = (path: string): string => {
  const home = process.env["HOME"] ?? "";
  return home.length > 0 && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

const pickApp = async (apps: readonly AppEntry[]): Promise<AppEntry | undefined> => {
  const rows: LiveRow<string>[] = [];
  const byValue = new Map<string, AppEntry>();
  for (const running of [true, false]) {
    const group = apps.filter((app) => app.running === running);
    if (group.length === 0) {
      continue;
    }
    rows.push({ header: true, label: pc.bold(running ? "Running" : "Installed"), value: "" });
    for (const app of group) {
      const value = String(rows.length);
      byValue.set(value, app);
      rows.push({ header: false, label: `${terminalText(app.name)} ${pc.dim(shortHome(app.path))}`, search: app.name, value });
    }
  }
  const chosen = await liveSelectPrompt({ message: "Pick an app", refresh: () => [], rows });
  return byValue.get(chosen);
};

/**
 * The process values `--app` stands for: the app's bundle (all its helpers),
 * plus the related programs the user keeps (all, when not interactive).
 * `null` value when `--app` was not given.
 */
export const resolveAppProcesses = async (rawArgs: readonly string[]): Promise<Step<string[] | null>> => {
  if (!appFlagGiven(rawArgs)) {
    return { ok: true, value: null };
  }
  const query = (collectFlag(rawArgs, "app")[0] ?? "").trim();
  const processes = listProcesses();
  const apps = listApps(processes);
  let app: AppEntry | undefined;
  if (query.length > 0) {
    const found = findApp(apps, query);
    if (Array.isArray(found)) {
      return { error: `"${query}" matches several apps: ${found.map((a) => a.name).join(", ")}. Use the full name.`, ok: false };
    }
    app = found;
  } else if (process.stdin.isTTY) {
    app = await pickApp(apps);
  } else {
    return { error: '--app needs an app name outside a terminal, e.g. --app "Google Chrome".', ok: false };
  }
  if (!app) {
    return { error: `No app named "${query}". Run \`masir rules add --app\` in a terminal to pick one.`, ok: false };
  }

  const values = ruleValuesFor(app);
  log.step(`${pc.bold(terminalText(app.name))} ${pc.dim(`→ ${values.map(shortHome).join(", ")} (covers its helper processes)`)}`);
  const related = findRelated(app, processes);
  if (related.length === 0) {
    return { ok: true, value: values };
  }
  let kept = related.map((item) => item.path);
  if (process.stdin.isTTY) {
    kept = await multiselectPrompt({
      initialValues: kept,
      message: `Also include programs ${app.name} uses?`,
      options: related.map((item) => ({ hint: item.reason, label: shortHome(item.path), value: item.path })),
    });
  } else {
    for (const item of related) {
      log.step(pc.dim(`also including ${shortHome(item.path)} (${item.reason})`));
    }
  }
  return { ok: true, value: [...values, ...kept] };
};

/** Add process values to a raw rule's `process` list, without duplicates. */
export const addProcesses = (fields: RawRule, values: readonly string[]): void => {
  const current = fields["process"];
  const list: string[] = [];
  if (Array.isArray(current)) {
    for (const value of current) {
      if (typeof value === "string" && !list.includes(value)) {
        list.push(value);
      }
    }
  }
  for (const value of values) {
    if (!list.includes(value)) {
      list.push(value);
    }
  }
  fields["process"] = list;
};

/** Drop unset fields so the validator sees exactly what was given. */
export const definedFields = (input: RuleInput): RawRule => {
  const fields: RawRule = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  return fields;
};

/** One xray rule object from JSON text (`--json`, or the editor buffer). */
export const parseJsonRule = (json: string, source = "--json"): Step<RawRule> => {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as RawRule };
    }
    return { error: `${source} must be one xray rule object, e.g. '{"domain":["geosite:google"],"outboundTag":"proxy"}'`, ok: false };
  } catch (error: unknown) {
    return { error: `${source} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, ok: false };
  }
};

/** A valid rule name not used by another rule (`except` = the rule being renamed). */
export const checkName = (name: string, existing: readonly UserRule[], except?: string): Step<string> => {
  if (name.length === 0) {
    return { error: "Missing rule name.", ok: false };
  }
  if (!isValidRuleName(name)) {
    return { error: `Invalid rule name "${name}": use letters, digits, - and _ (up to 48 characters).`, ok: false };
  }
  if (name !== except && existing.some((rule) => rule.name === name)) {
    return { error: `A rule named "${name}" already exists.`, ok: false };
  }
  return { ok: true, value: name };
};

/** `given` as an outbound; asks when empty and interactive. */
export const resolveOutbound = async (given: string): Promise<Step<RuleOutbound>> => {
  const value = given.trim().toLowerCase();
  const invalid = `Missing or invalid --outbound: use one of ${RULE_OUTBOUNDS.join(", ")}.`;
  if (value.length > 0) {
    const outbound = asRuleOutbound(value);
    return outbound ? { ok: true, value: outbound } : { error: invalid, ok: false };
  }
  if (!process.stdin.isTTY) {
    return { error: invalid, ok: false };
  }
  const chosen = await selectPrompt<RuleOutbound>({
    message: "Where should matching traffic go?",
    options: RULE_OUTBOUNDS.map((outbound) => ({ hint: OUTBOUND_HINTS[outbound], label: outbound, value: outbound })),
  });
  return { ok: true, value: chosen };
};

/** `--via`: pin a rule to one proxy node. */
export const VIA_ARG = {
  description: "pin the rule to one proxy by node id (ids show in `masir sub use`); if that proxy is removed, the active proxy is used",
  type: "string",
} as const;

/** Where a rule sends traffic: an outbound, plus a pinned node for "proxy". */
export interface RuleTarget {
  readonly outbound: RuleOutbound;
  readonly via?: RuleVia;
}

const PIN_CHOICE = "pin";

const pinTo = (node: NodeRef): RuleVia => ({ nodeId: node.outbound.id, subName: node.subName });

/**
 * The rule's target from `--outbound` / `--via`; asks when neither is given
 * and the terminal is interactive (with "a specific proxy…" opening the
 * proxy list).
 */
export const resolveTarget = async (givenOutbound: string, givenVia: string): Promise<Step<RuleTarget>> => {
  const outboundText = givenOutbound.trim().toLowerCase();
  const viaText = givenVia.trim();
  if (viaText.length > 0) {
    if (outboundText.length > 0 && outboundText !== "proxy") {
      return { error: `--via pins the rule to a proxy; it can't be combined with --outbound ${outboundText}.`, ok: false };
    }
    const node = getAllOutbounds().find((candidate) => candidate.outbound.id === viaText);
    if (!node) {
      return { error: `No proxy with id "${viaText}". Node ids show in \`masir sub use\`.`, ok: false };
    }
    return { ok: true, value: { outbound: "proxy", via: pinTo(node) } };
  }
  if (outboundText.length > 0 || !process.stdin.isTTY) {
    const outbound = await resolveOutbound(outboundText);
    return outbound.ok ? { ok: true, value: { outbound: outbound.value } } : outbound;
  }
  const choice = await selectPrompt<string>({
    message: "Where should matching traffic go?",
    options: [
      { hint: OUTBOUND_HINTS.proxy, label: "proxy", value: "proxy" },
      { hint: "pin to one proxy; falls back to the active one if it is removed", label: "a specific proxy…", value: PIN_CHOICE },
      { hint: OUTBOUND_HINTS.direct, label: "direct", value: "direct" },
      { hint: OUTBOUND_HINTS.block, label: "block", value: "block" },
    ],
  });
  if (choice !== PIN_CHOICE) {
    const outbound = asRuleOutbound(choice);
    return outbound ? { ok: true, value: { outbound } } : { error: "No outbound chosen.", ok: false };
  }
  const nodes = getAllOutbounds();
  if (nodes.length === 0) {
    return { error: "No proxies to pin to. Add a subscription first with `masir sub add`.", ok: false };
  }
  const node = await pickNode(nodes, "Pin the rule to which proxy?");
  return node ? { ok: true, value: { outbound: "proxy", via: pinTo(node) } } : { error: "No proxy chosen.", ok: false };
};

/** Validate the whole candidate rule set with xray; returns xray's reason when it rejects it. */
export const xrayRejection = (rules: readonly UserRule[]): string | null => {
  const spinner = createSpinner();
  spinner.start("Checking the rule with xray...");
  const check = checkRulesWithXray(rules);
  if (check.status === "invalid") {
    spinner.error(pc.red(`xray rejects this rule: ${check.reason}`));
    return check.reason;
  }
  if (check.status === "unchecked") {
    spinner.stop(pc.yellow(`Could not check the rule with xray (${check.reason}).`));
  } else {
    spinner.stop(pc.dim("xray accepts the rule."));
  }
  return null;
};

/** Reload a running xray with the saved rules, and say what happened. */
export const applyToDaemon = (): void => {
  const res = tryCallHelper<ResponseOf<"reload">>({ type: "reload" });
  if (!res) {
    log.step(pc.dim("Takes effect the next time xray starts (`masir start`)."));
  } else if (res.ok) {
    log.step(pc.cyan("Applied: the running xray was reloaded with the new rules."));
  } else {
    log.warn(pc.yellow(`Saved, but reloading xray failed: ${res.error}`));
  }
};
