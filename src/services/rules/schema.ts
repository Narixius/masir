// User routing rules, in xray's own routing-rule JSON shape
// (https://xtls.github.io/config/routing.html#ruleobject), validated before
// they are stored or handed to xray. `ruleTag` is not part of it: masir sets
// it from the rule's name (`user:<name>`).
import * as z from "zod/mini";

/** Where a rule can send traffic: the outbounds every masir config has. */
export const RULE_OUTBOUNDS = ["proxy", "direct", "block"] as const;
export type RuleOutbound = (typeof RULE_OUTBOUNDS)[number];

/** xray's domain matcher types; a value with a `type:` prefix must use one of these. */
const DOMAIN_TYPES: ReadonlySet<string> = new Set(["geosite", "domain", "full", "regexp", "keyword", "dotless", "ext"]);
/** `geoip:cn`, `geoip:!cn`, `ext:file.dat:tag`. */
const IP_PREFIXES = ["geoip:", "ext:"];
const SNIFFED_PROTOCOLS = ["http", "tls", "quic", "bittorrent"] as const;
const PORT_MAX = 65_535;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/iu;
const WHITESPACE = /\s/u;

const ipLiteral = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);

const isDomainValue = (value: string): boolean => {
  if (value.length === 0 || WHITESPACE.test(value)) {
    return false;
  }
  const colon = value.indexOf(":");
  return colon === -1 || DOMAIN_TYPES.has(value.slice(0, colon));
};

const isIpValue = (value: string): boolean =>
  IP_PREFIXES.some((prefix) => value.startsWith(prefix) && value.length > prefix.length) || z.safeParse(ipLiteral, value).success;

const isPortNumber = (text: string): boolean => {
  const port = Number(text);
  return text.length > 0 && Number.isInteger(port) && port >= 1 && port <= PORT_MAX;
};

/** `53`, `1000-2000`, or a comma-separated list of those. */
export const isPortList = (value: string): boolean =>
  value.split(",").every((part) => {
    const [from = "", to, extra] = part.trim().split("-");
    if (extra !== undefined) {
      return false;
    }
    return to === undefined ? isPortNumber(from) : isPortNumber(from) && isPortNumber(to) && Number(from) <= Number(to);
  });

const domainValue = z
  .string("text")
  .check(z.refine(isDomainValue, "a domain like `google.com`, or `geosite:`, `domain:`, `full:`, `regexp:`, `keyword:`, `ext:`"));
const ipValue = z.string("text").check(z.refine(isIpValue, "an IP, a CIDR, `geoip:<code>` or `ext:<file>:<tag>`"));
const portValue = z.string('ports as text, e.g. "443"').check(z.refine(isPortList, "ports like `53`, `1000-2000` or `53,443,8000-9000`"));
const nonEmptyList = <T extends z.ZodMiniType>(item: T) =>
  z.array(item, 'a list, e.g. ["google.com"]').check(z.minLength(1, "a list with at least one value"));
const listOfText = nonEmptyList(z.string("text").check(z.minLength(1, "non-empty text")));

const RuleSchema = z.strictObject({
  attrs: z.optional(z.record(z.string(), z.string(), "an object of header name -> value")),
  domain: z.optional(nonEmptyList(domainValue)),
  inboundTag: z.optional(listOfText),
  ip: z.optional(nonEmptyList(ipValue)),
  network: z.optional(z.enum(["tcp", "udp", "tcp,udp"], "tcp, udp or tcp,udp")),
  outboundTag: z.enum(RULE_OUTBOUNDS, "proxy, direct or block"),
  port: z.optional(portValue),
  process: z.optional(listOfText),
  protocol: z.optional(nonEmptyList(z.enum(SNIFFED_PROTOCOLS, "http, tls, quic or bittorrent"))),
  source: z.optional(nonEmptyList(ipValue)),
  sourcePort: z.optional(portValue),
  user: z.optional(listOfText),
});

/** One routing rule as xray reads it (minus `ruleTag`, which masir sets). */
export interface XrayRuleJson {
  readonly domain?: string[];
  readonly ip?: string[];
  readonly port?: string;
  readonly sourcePort?: string;
  readonly network?: "tcp" | "udp" | "tcp,udp";
  readonly source?: string[];
  readonly user?: string[];
  readonly inboundTag?: string[];
  readonly protocol?: ("http" | "tls" | "quic" | "bittorrent")[];
  readonly attrs?: Record<string, string>;
  readonly process?: string[];
  readonly outboundTag: RuleOutbound;
}

/** Fields xray accepts in a rule (and masir lets users set). */
export const RULE_FIELDS: readonly string[] = [
  "attrs",
  "domain",
  "inboundTag",
  "ip",
  "network",
  "outboundTag",
  "port",
  "process",
  "protocol",
  "source",
  "sourcePort",
  "user",
];
const MAX_SUGGESTION_DISTANCE = 2;

/** Edit distance, for "did you mean" on misspelled `--json` fields. */
const editDistance = (a: string, b: string): number => {
  let previous: number[] = [];
  for (let j = 0; j <= b.length; j += 1) {
    previous.push(j);
  }
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
};

/** The known rule field closest to a misspelled `key`, if any is close. */
export const closestField = (key: string): string | undefined => {
  let best: string | undefined;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;
  for (const field of RULE_FIELDS) {
    const distance = editDistance(key.toLowerCase(), field.toLowerCase());
    if (distance < bestDistance) {
      best = field;
      bestDistance = distance;
    }
  }
  return best;
};

const hasMatcher = (rule: XrayRuleJson): boolean =>
  rule.domain !== undefined ||
  rule.ip !== undefined ||
  rule.port !== undefined ||
  rule.sourcePort !== undefined ||
  rule.network !== undefined ||
  rule.source !== undefined ||
  rule.user !== undefined ||
  rule.inboundTag !== undefined ||
  rule.protocol !== undefined ||
  rule.attrs !== undefined ||
  rule.process !== undefined;

/** `RULE_OUTBOUNDS` as a plain list, for lookups (scriptc cannot call methods on `as const` tuples). */
const OUTBOUND_LIST: readonly RuleOutbound[] = ["proxy", "direct", "block"];

/** `value` as a rule outbound, if it is one. */
export const asRuleOutbound = (value: string): RuleOutbound | undefined => {
  for (const outbound of OUTBOUND_LIST) {
    if (outbound === value) {
      return outbound;
    }
  }
  return undefined;
};

/**
 * A rule pinned to one proxy node instead of the active one. masir metadata,
 * not part of the xray rule: resolved to an outbound when the config is built,
 * and back to the active proxy if the node is gone.
 */
export interface RuleVia {
  readonly nodeId: string;
  /** The subscription it came from, to tell apart the same node in two subscriptions. */
  readonly subName?: string;
}

/** A named, stored user rule. */
export interface UserRule {
  readonly name: string;
  readonly rule: XrayRuleJson;
  readonly createdAt: number;
  readonly via?: RuleVia;
}

/** An xray rule object before validation: from `--json`, the flags, or `rules.json`. */
export interface RawRule {
  [key: string]: unknown;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/**
 * Validate an xray rule object (from flags or `--json`). Old-style
 * `"type": "field"` is accepted and dropped; `ruleTag` is rejected because the
 * rule's name sets it.
 */
export const parseRule = (input: RawRule): Parsed<XrayRuleJson> => {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "ruleTag") {
      return { error: "`ruleTag` is set by masir from the rule's --name; leave it out", ok: false };
    }
    if (key !== "type" && !RULE_FIELDS.includes(key)) {
      const suggestion = closestField(key);
      return { error: `Unknown rule field "${key}"${suggestion ? ` (did you mean "${suggestion}"?)` : ""}`, ok: false };
    }
    if (!(key === "type" && value === "field")) {
      fields[key] = value;
    }
  }
  const parsed = z.safeParse(RuleSchema, fields);
  if (!parsed.success) {
    return { error: z.prettifyError(parsed.error), ok: false };
  }
  const rule: XrayRuleJson = parsed.data;
  return hasMatcher(rule)
    ? { ok: true, value: rule }
    : { error: "a rule needs at least one matcher (domain, ip, port, network, process, ...)", ok: false };
};

export const isValidRuleName = (name: string): boolean => NAME_PATTERN.test(name);

/** `udp/tcp`, `TCP,UDP`, `tcp+udp` ... -> xray's `tcp`, `udp` or `tcp,udp`. */
export const normalizeNetwork = (value: string): string => {
  const parts = new Set(
    value
      .toLowerCase()
      .split(/[\s,/+|]+/u)
      .filter((part) => part.length > 0)
  );
  if (parts.has("tcp") && parts.has("udp") && parts.size === 2) {
    return "tcp,udp";
  }
  return [...parts].join(",");
};

/** The xray `ruleTag` of a user rule, so it can be told apart from masir's built-in rules. */
export const userRuleTag = (name: string): string => `user:${name}`;
