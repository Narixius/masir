// One picker per kind of rule match, for the rule wizard. Each starts with the
// rule's current values ticked, lets the user filter by typing, and (where it
// makes sense) accepts typed values, validated like the flags are.
import pc from "picocolors";

import { attributeLabel, listGeo } from "../../services/geo/geo.js";
import type { GeoCategory } from "../../services/geo/geo.js";
import { isDomainValue, isIpValue, isPortList } from "../../services/rules/schema.js";
import { pickValues, selectPrompt } from "../../utils/prompts.js";
import type { LiveRow } from "../../utils/prompts.js";
import { chooseAppProcesses } from "./shared.js";

const DOMAIN_HINT = "a domain like google.com, or full:, domain:, keyword:, regexp:, geosite:";
const IP_HINT = "an IP, a CIDR like 10.0.0.0/8, or geoip:<code>";
const PORT_HINT = "ports like 443, 1000-2000 or 53,443";

const flagged = (category: GeoCategory): string => (category.flag ? `${category.flag} ${category.label}` : category.label);

/** Rows for `values`, ticking those in `current`; values in `current` but not listed come back as typed. */
/** `row`, ticked (spelled out: scriptc can't spread these rows). */
const tick = <T extends string>(row: LiveRow<T>): LiveRow<T> => ({
  checked: true,
  header: row.header,
  label: row.label,
  search: row.search,
  value: row.value,
});

interface WithCurrent<T extends string> {
  readonly rows: LiveRow<T>[];
  /** Current values that aren't rows: shown as typed values. */
  readonly custom: string[];
}

const withCurrent = <T extends string>(rows: LiveRow<T>[], current: readonly string[]): WithCurrent<T> => {
  const listed = new Set<string>(rows.map((row) => row.value));
  return {
    custom: current.filter((value) => !listed.has(value)),
    rows: rows.map((row) => (current.includes(row.value) ? tick(row) : row)),
  };
};

const byName = (a: GeoCategory, b: GeoCategory): number => a.label.localeCompare(b.label);

/** Categories split into "By country" (flagged) and the rest, each sorted by name. */
const grouped = (categories: readonly GeoCategory[], restTitle: string): { title: string; items: GeoCategory[] }[] => [
  { items: categories.filter((c) => c.flag !== undefined).toSorted(byName), title: "By country" },
  { items: categories.filter((c) => c.flag === undefined).toSorted(byName), title: restTitle },
];

/** geosite categories (and their `@attribute` variants) to pick from; typed domains allowed. */
export const pickDomains = async (current: readonly string[]): Promise<string[]> => {
  const rows: LiveRow<string>[] = [];
  for (const group of grouped(listGeo("geosite"), "Sites & services")) {
    if (group.items.length === 0) {
      continue;
    }
    rows.push({ header: true, label: pc.bold(group.title), value: "" });
    for (const category of group.items) {
      const value = `geosite:${category.code}`;
      rows.push({
        header: false,
        label: `${flagged(category)} ${pc.dim(`${value} · ${category.count} domains`)}`,
        search: `${category.code} ${category.label}`,
        value,
      });
      for (const attr of category.attrs ?? []) {
        const attrValue = `${value}@${attr.key}`;
        rows.push({
          header: false,
          label: `  ${category.label} ${attributeLabel(attr.key)} ${pc.dim(`${attrValue} · ${attr.count}`)}`,
          search: `${category.code}@${attr.key} ${category.label} ${attributeLabel(attr.key)}`,
          value: attrValue,
        });
      }
    }
  }
  const { rows: ticked, custom } = withCurrent(rows, current);
  const picked = await pickValues({
    allowCustom: true,
    custom,
    message: "Which websites? (type a domain to add it)",
    rows: ticked,
    validate: (value) => (isDomainValue(value) ? null : DOMAIN_HINT),
  });
  return [...picked.custom, ...picked.values];
};

/** geoip categories to pick from; typed IPs and CIDRs allowed. */
export const pickIps = async (
  current: readonly string[],
  message = "Which IP addresses? (type an IP or CIDR to add it)"
): Promise<string[]> => {
  const rows: LiveRow<string>[] = [];
  for (const group of grouped(listGeo("geoip"), "Other")) {
    if (group.items.length === 0) {
      continue;
    }
    rows.push({ header: true, label: pc.bold(group.title), value: "" });
    for (const category of group.items) {
      const value = `geoip:${category.code}`;
      rows.push({
        header: false,
        label: `${flagged(category)} ${pc.dim(`${value} · ${category.count} ranges`)}`,
        search: `${category.code} ${category.label}`,
        value,
      });
    }
  }
  const { rows: ticked, custom } = withCurrent(rows, current);
  const picked = await pickValues({
    allowCustom: true,
    custom,
    message,
    rows: ticked,
    validate: (value) => (isIpValue(value) ? null : IP_HINT),
  });
  return [...picked.custom, ...picked.values];
};

/** Typed IPs only (no categories): for source addresses. */
export const pickSourceIps = async (current: readonly string[]): Promise<string[]> => {
  const picked = await pickValues({
    allowCustom: true,
    custom: current,
    message: "Which source addresses? (type an IP or CIDR, Enter when done)",
    rows: [],
    validate: (value) => (isIpValue(value) ? null : IP_HINT),
  });
  return picked.custom;
};

const PORT_PRESETS: readonly [string, string][] = [
  ["443", "HTTPS"],
  ["80", "HTTP"],
  ["53", "DNS"],
  ["22", "SSH"],
  ["25,465,587", "Mail (SMTP)"],
  ["993", "IMAP"],
  ["3478-3479", "Voice & video calls (STUN/TURN)"],
  ["6881-6889", "BitTorrent"],
  ["8080", "HTTP alternate"],
];

/** Common ports to pick from; typed ports and ranges allowed. Returns xray's comma-separated form. */
export const pickPorts = async (
  current: string | undefined,
  message = "Which ports? (type ports or ranges to add them)"
): Promise<string | undefined> => {
  const currentParts = current ? current.split(",").map((part) => part.trim()) : [];
  const rows: LiveRow<string>[] = PORT_PRESETS.map(([value, name]) => ({
    header: false,
    label: `${value} ${pc.dim(name)}`,
    search: `${value} ${name}`,
    value,
  }));
  const presetParts = new Set<string>(PORT_PRESETS.flatMap(([value]) => value.split(",")));
  const ticked = rows.map((row) => (row.value.split(",").every((part) => currentParts.includes(part)) ? tick(row) : row));
  const picked = await pickValues({
    allowCustom: true,
    custom: currentParts.filter((part) => !presetParts.has(part)),
    message,
    rows: ticked,
    validate: (value) => (isPortList(value) ? null : PORT_HINT),
  });
  const ports = [...picked.values, ...picked.custom].join(",");
  return ports.length > 0 ? ports : undefined;
};

export const pickNetwork = async (current: string | undefined): Promise<string | undefined> =>
  await selectPrompt({
    defaultValue: current ?? "tcp,udp",
    message: "Which network?",
    options: [
      { hint: "everything", label: "TCP and UDP", value: "tcp,udp" },
      { hint: "web, most apps", label: "TCP only", value: "tcp" },
      { hint: "calls, games, QUIC, DNS", label: "UDP only", value: "udp" },
    ],
  });

const PROTOCOLS: readonly [string, string][] = [
  ["http", "plain web traffic"],
  ["tls", "encrypted web traffic (HTTPS)"],
  ["quic", "HTTP/3, used by Chrome and YouTube"],
  ["bittorrent", "torrent clients"],
];

export const pickProtocols = async (current: readonly string[]): Promise<string[]> => {
  const picked = await pickValues({
    allowCustom: false,
    message: "Which protocols?",
    rows: PROTOCOLS.map(([value, hint]) => ({
      checked: current.includes(value),
      header: false,
      label: `${value} ${pc.dim(hint)}`,
      search: value,
      value,
    })),
  });
  return picked.values;
};

const ADD_APP = "+app";

/**
 * Apps and programs: the current entries (untick to drop, type a path or name
 * to add), plus "+ Add an app…" to pick an app with all its helpers.
 */
export const pickProcesses = async (current: readonly string[]): Promise<string[]> => {
  if (current.length === 0) {
    return (await chooseAppProcesses()) ?? [];
  }
  const picked = await pickValues({
    allowCustom: true,
    message: "Which apps and programs? (type a path or process name to add it)",
    rows: [
      { header: false, label: pc.cyan("+ Add an app…"), search: "add app", value: ADD_APP },
      ...current.map((value) => ({ checked: true, header: false, label: value, value })),
    ],
  });
  const kept = picked.values.filter((value) => value !== ADD_APP);
  const added = picked.values.includes(ADD_APP) ? ((await chooseAppProcesses()) ?? []) : [];
  const all: string[] = [];
  for (const value of [...kept, ...picked.custom, ...added]) {
    if (!all.includes(value)) {
      all.push(value);
    }
  }
  return all;
};
