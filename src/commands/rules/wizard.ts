// The interactive rule builder: `masir rules add` (and `rules edit` with no
// flags) in a terminal. Every part of a rule is asked for with a picker;
// anything given as a flag is used as-is and not asked again. Nothing is saved
// until the user confirms the reviewed rule and xray accepts it.
import { basename } from "node:path";

import pc from "picocolors";

import { humanizeGeoValue } from "../../services/geo/geo.js";
import { parseRule } from "../../services/rules/schema.js";
import type { UserRule } from "../../services/rules/schema.js";
import { withRuleInserted } from "../../services/rules/storage.js";
import { log, note } from "../../utils/log.js";
import { multiselectPrompt, selectPrompt, textPrompt } from "../../utils/prompts.js";
import { describeRule } from "./describe.js";
import { pickDomains, pickIps, pickNetwork, pickPorts, pickProcesses, pickProtocols, pickSourceIps } from "./pickers.js";
import { checkName, definedFields, resolveTarget, xrayRejection } from "./shared.js";
import type { RuleInput, RuleTarget } from "./shared.js";

type MatcherKind = "process" | "domain" | "ip" | "port" | "network" | "protocol" | "source" | "sourcePort";

const KINDS: readonly { readonly kind: MatcherKind; readonly label: string; readonly hint: string }[] = [
  { hint: "an app and all its helper processes", kind: "process", label: "Apps" },
  { hint: "geosite categories or your own domains", kind: "domain", label: "Websites" },
  { hint: "countries, private networks, or your own IPs", kind: "ip", label: "IP addresses" },
  { hint: "HTTPS, DNS, calls, …", kind: "port", label: "Ports" },
  { hint: "TCP or UDP", kind: "network", label: "Network" },
  { hint: "HTTP, TLS, QUIC, BitTorrent", kind: "protocol", label: "Protocol" },
  { hint: "where the connection comes from", kind: "source", label: "Source IP" },
  { hint: "the connection's local port", kind: "sourcePort", label: "Source port" },
];

const hasKind = (rule: RuleInput, kind: MatcherKind): boolean => {
  switch (kind) {
    case "process": {
      return rule.process !== undefined;
    }
    case "domain": {
      return rule.domain !== undefined;
    }
    case "ip": {
      return rule.ip !== undefined;
    }
    case "port": {
      return rule.port !== undefined;
    }
    case "network": {
      return rule.network !== undefined;
    }
    case "protocol": {
      return rule.protocol !== undefined;
    }
    case "source": {
      return rule.source !== undefined;
    }
    default: {
      return rule.sourcePort !== undefined;
    }
  }
};

const orUndefined = <T>(values: T[]): T[] | undefined => (values.length > 0 ? values : undefined);

/** Ask which kinds of match the rule uses, then run each kind's picker (current values pre-selected). */
export const chooseMatchers = async (current: RuleInput): Promise<RuleInput> => {
  const kinds = await multiselectPrompt<MatcherKind>({
    initialValues: KINDS.filter((item) => hasKind(current, item.kind)).map((item) => item.kind),
    message: "What should this rule match?",
    options: KINDS.map((item) => ({ hint: item.hint, label: item.label, value: item.kind })),
  });
  // Fields the wizard has no picker for (user, inboundTag, attrs) carry over.
  const next: RuleInput = { attrs: current.attrs, inboundTag: current.inboundTag, user: current.user };
  for (const kind of kinds) {
    switch (kind) {
      case "process": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.process = orUndefined(await pickProcesses(current.process ?? []));
        break;
      }
      case "domain": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.domain = orUndefined(await pickDomains(current.domain ?? []));
        break;
      }
      case "ip": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.ip = orUndefined(await pickIps(current.ip ?? []));
        break;
      }
      case "port": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.port = await pickPorts(current.port);
        break;
      }
      case "network": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.network = await pickNetwork(current.network);
        break;
      }
      case "protocol": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.protocol = orUndefined(await pickProtocols(current.protocol ?? []));
        break;
      }
      case "source": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.source = orUndefined(await pickSourceIps(current.source ?? []));
        break;
      }
      case "sourcePort": {
        // oxlint-disable-next-line eslint/no-await-in-loop
        next.sourcePort = await pickPorts(current.sourcePort, "Which source ports?");
        break;
      }
      default: {
        break;
      }
    }
  }
  return next;
};

/** 1-based position among `others` (rules besides this one); `undefined` = last. */
export const choosePosition = async (others: readonly UserRule[], current?: number): Promise<number | undefined> => {
  if (others.length === 0) {
    return undefined;
  }
  const options = [
    { hint: "checked after every other rule", label: "Last", value: "last" },
    { hint: "checked before every other rule", label: "First", value: "1" },
    ...others
      .slice(1)
      .map((rule, i) => ({ hint: `between ${others[i]?.name} and ${rule.name}`, label: `Before ${rule.name}`, value: String(i + 2) })),
  ];
  const chosen = await selectPrompt({
    defaultValue: current === undefined ? "last" : String(current),
    message: "Where in the list? (the first matching rule wins)",
    options,
  });
  return chosen === "last" ? undefined : Number(chosen);
};

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 32);

const isGeo = (value: string): boolean => value.startsWith("geosite:") || value.startsWith("geoip:");

const subjectOf = (rule: RuleInput): string => {
  const app = rule.process?.find((value) => value.includes(".app/"));
  if (app) {
    return basename(app.slice(0, app.indexOf(".app/")));
  }
  const firstGeo = rule.domain?.find(isGeo) ?? rule.ip?.find(isGeo) ?? rule.domain?.[0] ?? rule.ip?.[0];
  if (firstGeo) {
    return humanizeGeoValue(firstGeo)?.label ?? firstGeo.replace(/^[a-z]+:/u, "");
  }
  if (rule.process?.[0]) {
    return basename(rule.process[0]);
  }
  return rule.port ? `port-${rule.port}` : (rule.protocol?.[0] ?? rule.network ?? "rule");
};

/** A free name like `iranian-websites-direct` or `linear-proxy`. */
export const suggestName = (rule: RuleInput, target: RuleTarget, existing: readonly UserRule[]): string => {
  const base = slug(`${subjectOf(rule)}-${target.outbound}`) || "rule";
  let name = base;
  for (let n = 2; existing.some((other) => other.name === name); n += 1) {
    name = `${base}-${n}`;
  }
  return name;
};

/** Ask for a valid, free rule name (suggestion pre-filled). */
export const chooseName = async (suggestion: string, existing: readonly UserRule[], except?: string): Promise<string> => {
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const answer = await textPrompt({ defaultValue: suggestion, message: "Rule name", placeholder: suggestion });
    const typed = answer.trim() || suggestion;
    const checked = checkName(typed, existing, except);
    if (checked.ok) {
      return checked.value;
    }
    log.error(pc.red(checked.error));
  }
};

/** The rule as it would be saved; an error when it isn't valid yet. */
const candidate = (
  name: string,
  matchers: RuleInput,
  target: RuleTarget,
  createdAt: number
): { readonly ok: true; readonly rule: UserRule } | { readonly ok: false; readonly error: string } => {
  const fields = definedFields({ ...matchers, outboundTag: target.outbound });
  const parsed = parseRule(fields);
  if (!parsed.ok) {
    return { error: parsed.error, ok: false };
  }
  return { ok: true, rule: { createdAt, name, rule: parsed.value, via: target.outbound === "proxy" ? target.via : undefined } };
};

const askTarget = async (current?: RuleTarget): Promise<RuleTarget> => {
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const target = await resolveTarget("", "");
    if (target.ok) {
      return target.value;
    }
    log.error(pc.red(target.error));
    if (current) {
      return current;
    }
  }
};

export interface WizardResult {
  readonly rule: UserRule;
}

export interface WizardPreset {
  readonly name?: string;
  readonly target?: RuleTarget;
}

type ReviewChoice = "save" | "matches" | "target" | "name" | "cancel";

/**
 * `masir rules add` in a terminal: ask for each part, review, check with xray,
 * return the rule (or `null` if cancelled). New rules go last; `rules edit`
 * moves them.
 */
export const runAddWizard = async (existing: readonly UserRule[], preset: WizardPreset): Promise<WizardResult | null> => {
  let matchers = await chooseMatchers({});
  let target = preset.target ?? (await askTarget());
  let name = preset.name ?? (await chooseName(suggestName(matchers, target, existing), existing));
  const createdAt = Date.now();

  for (;;) {
    const built = candidate(name, matchers, target, createdAt);
    let choice: ReviewChoice;
    if (built.ok) {
      const placed = existing.length + 1;
      note(describeRule(built.rule, placed).join("\n"), "Review");
      // oxlint-disable-next-line eslint/no-await-in-loop
      choice = await selectPrompt<ReviewChoice>({
        message: "Save this rule?",
        options: [
          { label: "Save", value: "save" },
          { label: "Change what it matches", value: "matches" },
          { label: "Change where traffic goes", value: "target" },
          { label: "Rename", value: "name" },
          { label: "Cancel", value: "cancel" },
        ],
      });
    } else {
      log.error(pc.red(`The rule isn't complete yet:\n${built.error}`));
      choice = "matches";
    }

    if (choice === "save" && built.ok) {
      if (xrayRejection(withRuleInserted(existing, built.rule)) === null) {
        return { rule: built.rule };
      }
    } else if (choice === "cancel") {
      log.info("Cancelled; nothing was saved.");
      return null;
    } else if (choice === "matches") {
      // oxlint-disable-next-line eslint/no-await-in-loop
      matchers = await chooseMatchers(matchers);
    } else if (choice === "target") {
      // oxlint-disable-next-line eslint/no-await-in-loop
      target = await askTarget(target);
    } else if (choice === "name") {
      // oxlint-disable-next-line eslint/no-await-in-loop
      name = await chooseName(name, existing);
    }
  }
};
