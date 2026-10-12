// Which rule would route a connection, and where: `masir rules test`. Walks the
// rules in the order xray checks them (masir's built-in DNS rules, the user's
// rules, the LAN bypass, then the default: the active proxy). Like xray, a rule
// applies only when every one of its conditions matches.
import { basename } from "node:path";

import { geoMatches } from "../geo/geo.js";
import type { UserRule, XrayRuleJson } from "./schema.js";

export interface RouteQuery {
  /** A domain (`google.com`) or an IP (`1.2.3.4`). */
  readonly target: string;
  readonly port: number;
  readonly network: "tcp" | "udp";
  /** The connecting program: a name or an absolute path. */
  readonly process?: string;
  readonly protocol?: string;
}

type Conditions = Omit<XrayRuleJson, "outboundTag">;

export interface TestedRule {
  /** 1-based position among the user's rules; `undefined` for built-ins. */
  readonly position?: number;
  readonly name: string;
  readonly outboundTag: string;
  readonly conditions: Conditions;
  /** The user's rule, for pinned targets. */
  readonly rule?: UserRule;
}

export interface RouteResult {
  /** The rule that applies; `undefined` = none did, so the default (the active proxy). */
  readonly matched?: TestedRule;
  /** Why it matched, e.g. `domain: geosite:google`. */
  readonly because: string[];
  /** Rules above the match that could apply too under conditions the test can't know. */
  readonly notes: string[];
}

type CheckState = "yes" | "no" | "unknown";

interface Check {
  readonly state: CheckState;
  readonly why: string;
}

const YES = (why: string): Check => ({ state: "yes", why });
const NO: Check = { state: "no", why: "" };
const UNKNOWN = (why: string): Check => ({ state: "unknown", why });

const IPV4_OCTETS = 4;
const IPV4_BITS = 32;
const OCTET_MAX = 255;
const DIGITS = /^\d+$/u;

const BUILT_IN_BEFORE: readonly TestedRule[] = [
  // Mirrors buildRoutingRules (config-manager.ts); the anti-loop and
  // inbound-tag rules only see xray's own traffic, so they are left out.
  { conditions: { network: "udp", port: "53" }, name: "DNS (built in)", outboundTag: "dns-out" },
  { conditions: { ip: ["1.1.1.1"], network: "tcp", port: "443" }, name: "DNS upstream (built in)", outboundTag: "proxy" },
];
const BUILT_IN_AFTER: readonly TestedRule[] = [{ conditions: { ip: ["geoip:private"] }, name: "LAN (built in)", outboundTag: "direct" }];

const ipv4Number = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== IPV4_OCTETS) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!DIGITS.test(part) || Number(part) > OCTET_MAX) {
      return null;
    }
    value = value * (OCTET_MAX + 1) + Number(part);
  }
  return value;
};

export const isIpTarget = (target: string): boolean => ipv4Number(target) !== null || target.includes(":");

/** `ip` is `cidr` (`10.0.0.0/8`) or the plain address `cidr`. IPv6 ranges compare exactly. */
const inRange = (ip: string, cidr: string): boolean => {
  const [base = "", bitsText] = cidr.split("/");
  const address = ipv4Number(ip);
  const network = ipv4Number(base);
  if (address === null || network === null) {
    return ip.toLowerCase() === cidr.toLowerCase();
  }
  const size = 2 ** (IPV4_BITS - Number(bitsText ?? IPV4_BITS));
  return Math.floor(address / size) === Math.floor(network / size);
};

const geo = (kind: "geosite" | "geoip", code: string, value: string, entry: string): Check => {
  const found = geoMatches(kind, code, value);
  if (found === null) {
    return UNKNOWN(`couldn't read ${kind}.dat for ${entry}`);
  }
  return found ? YES(entry) : NO;
};

const regexpMatches = (pattern: string, domain: string): boolean => {
  try {
    return new RegExp(pattern, "u").test(domain);
  } catch {
    return false;
  }
};

const domainEntry = (domain: string, entry: string): Check => {
  const colon = entry.indexOf(":");
  const type = colon === -1 ? "" : entry.slice(0, colon);
  const value = colon === -1 ? entry : entry.slice(colon + 1);
  switch (type) {
    case "": {
      return domain.includes(value.toLowerCase()) ? YES(entry) : NO;
    }
    case "domain": {
      return domain === value || domain.endsWith(`.${value}`) ? YES(entry) : NO;
    }
    case "full": {
      return domain === value ? YES(entry) : NO;
    }
    case "keyword": {
      return domain.includes(value) ? YES(entry) : NO;
    }
    case "regexp": {
      return regexpMatches(value, domain) ? YES(entry) : NO;
    }
    case "dotless": {
      return !domain.includes(".") && domain.includes(value) ? YES(entry) : NO;
    }
    case "geosite": {
      return geo("geosite", value, domain, entry);
    }
    default: {
      return UNKNOWN(`${entry} isn't checked by this test`);
    }
  }
};

const ipEntry = (ip: string, entry: string): Check => {
  if (entry.startsWith("geoip:")) {
    return geo("geoip", entry.slice("geoip:".length), ip, entry);
  }
  if (entry.startsWith("ext:")) {
    return UNKNOWN(`${entry} isn't checked by this test`);
  }
  return inRange(ip, entry) ? YES(entry) : NO;
};

/** Any entry matching wins; otherwise the first "can't tell". */
const anyOf = (entries: readonly string[], check: (entry: string) => Check, label: string): Check => {
  let unknown: Check | undefined;
  for (const entry of entries) {
    const result = check(entry);
    if (result.state === "yes") {
      return YES(`${label}: ${result.why}`);
    }
    if (result.state === "unknown") {
      unknown ??= result;
    }
  }
  return unknown ?? NO;
};

const portIn = (port: number, list: string): boolean =>
  list.split(",").some((part) => {
    const [from = "", to] = part.trim().split("-");
    return port >= Number(from) && port <= Number(to ?? from);
  });

/** xray's process matching: a name, an absolute path, or a folder (ending in `/`). */
const processEntry = (program: string, entry: string): Check => {
  if (entry.endsWith("/")) {
    return program.startsWith(entry) ? YES(entry) : NO;
  }
  if (entry.includes("/")) {
    return program === entry ? YES(entry) : NO;
  }
  return basename(program) === entry ? YES(entry) : NO;
};

const listed = (values: readonly string[]): string => values.join(", ");

/** Conditions that depend on who connects: unknown unless the query says. */
const connectionChecks = (rule: Conditions, query: RouteQuery): Check[] => {
  const checks: Check[] = [];
  if (rule.process) {
    const { process: program } = query;
    checks.push(
      program === undefined
        ? UNKNOWN(`only for ${listed(rule.process)} (try --process)`)
        : anyOf(rule.process, (entry) => processEntry(program, entry), "process")
    );
  }
  if (rule.protocol) {
    const { protocol } = query;
    if (protocol === undefined) {
      checks.push(UNKNOWN(`only for ${listed(rule.protocol)} traffic (try --protocol)`));
    } else {
      checks.push(rule.protocol.some((value) => value === protocol) ? YES(`protocol: ${protocol}`) : NO);
    }
  }
  if (rule.source || rule.sourcePort || rule.user || rule.inboundTag || rule.attrs) {
    checks.push(UNKNOWN("depends on where the connection comes from (source, user, inbound or headers)"));
  }
  return checks;
};

const destinationChecks = (rule: Conditions, query: RouteQuery, isIp: boolean): Check[] => {
  const checks: Check[] = [];
  if (rule.domain) {
    const entries = rule.domain;
    checks.push(isIp ? NO : anyOf(entries, (entry) => domainEntry(query.target, entry), "domain"));
  }
  if (rule.ip) {
    const entries = rule.ip;
    checks.push(isIp ? anyOf(entries, (entry) => ipEntry(query.target, entry), "ip") : NO);
  }
  if (rule.port) {
    checks.push(portIn(query.port, rule.port) ? YES(`port: ${rule.port}`) : NO);
  }
  if (rule.network) {
    checks.push(rule.network.includes(query.network) ? YES(`network: ${rule.network}`) : NO);
  }
  return checks;
};

interface RuleVerdict {
  readonly state: CheckState;
  readonly because: string[];
  readonly unknown: string[];
}

const judge = (rule: Conditions, query: RouteQuery, isIp: boolean): RuleVerdict => {
  const because: string[] = [];
  const unknown: string[] = [];
  for (const check of [...destinationChecks(rule, query, isIp), ...connectionChecks(rule, query)]) {
    if (check.state === "no") {
      return { because, state: "no", unknown };
    }
    (check.state === "yes" ? because : unknown).push(check.why);
  }
  return { because, state: unknown.length > 0 ? "unknown" : "yes", unknown };
};

/** A rule's conditions (spelled out: scriptc can't rest-destructure these). */
const conditionsOf = (rule: XrayRuleJson): Conditions => ({
  attrs: rule.attrs,
  domain: rule.domain,
  inboundTag: rule.inboundTag,
  ip: rule.ip,
  network: rule.network,
  port: rule.port,
  process: rule.process,
  protocol: rule.protocol,
  source: rule.source,
  sourcePort: rule.sourcePort,
  user: rule.user,
});

/** The rules in xray's order: built-ins, the user's, the LAN bypass. */
export const rulesInOrder = (rules: readonly UserRule[]): TestedRule[] => {
  const ordered: TestedRule[] = [...BUILT_IN_BEFORE];
  for (const [index, rule] of rules.entries()) {
    ordered.push({ conditions: conditionsOf(rule.rule), name: rule.name, outboundTag: rule.rule.outboundTag, position: index + 1, rule });
  }
  for (const rule of BUILT_IN_AFTER) {
    ordered.push(rule);
  }
  return ordered;
};

/** `https://www.Google.com/x` -> `www.google.com`. */
export const normalizeTarget = (text: string): string => {
  const withoutScheme = text.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
  const [host = ""] = withoutScheme.split("/");
  return host.toLowerCase().replace(/\.$/u, "");
};

const ruleLabel = (rule: TestedRule): string => (rule.position === undefined ? rule.name : `${rule.position}. ${rule.name}`);

export const testRoute = (rules: readonly TestedRule[], query: RouteQuery): RouteResult => {
  const isIp = isIpTarget(query.target);
  const notes: string[] = [];
  for (const rule of rules) {
    const verdict = judge(rule.conditions, query, isIp);
    if (verdict.state === "yes") {
      return { because: verdict.because, matched: rule, notes };
    }
    if (verdict.state === "unknown") {
      notes.push(`${ruleLabel(rule)} → ${rule.outboundTag} could apply first: ${verdict.unknown.join("; ")}`);
    }
  }
  const ipRules = rules.filter((rule) => rule.position !== undefined && rule.conditions.ip !== undefined);
  if (!isIp && ipRules.length > 0) {
    notes.push(`xray also resolves ${query.target} and checks IP rules (${ipRules.map(ruleLabel).join(", ")}); test its IP to see those.`);
  }
  return { because: [], notes };
};
