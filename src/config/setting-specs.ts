// What each setting in config.json means, how a typed value is read and
// checked, and whether changing it needs a running xray to reload.
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

import * as z from "zod/mini";

import { readRawSettings } from "./settings.js";
import type { Settings, SettingValue } from "./settings.js";

export type SettingKey =
  | "routingMode"
  | "dohDns"
  | "tunDns"
  | "mixedPort"
  | "apiPort"
  | "xrayExecutable"
  | "xrayAssetsPath"
  | "gateway"
  | "subUpdateIntervalMinutes";

export type ParsedSetting = { readonly ok: true; readonly value: SettingValue } | { readonly ok: false; readonly error: string };

export interface SettingSpec {
  readonly key: SettingKey;
  readonly label: string;
  readonly description: string;
  /** xray must restart to pick it up (everything but the refresh interval). */
  readonly reloadsXray: boolean;
  readonly parse: (text: string, settings: Settings) => ParsedSetting;
}

const PORT_MAX = 65_535;
const DIGITS = /^\d+$/u;
const LIST_SEPARATOR = /[\s,]+/u;

const fail = (error: string): ParsedSetting => ({ error, ok: false });

const expandHome = (path: string): string => (path.startsWith("~/") ? join(process.env["HOME"] ?? "", path.slice(2)) : path);

const parsePort = (text: string, other: number, otherName: string): ParsedSetting => {
  const port = Number(text);
  if (!DIGITS.test(text) || port < 1 || port > PORT_MAX) {
    return fail(`a port from 1 to ${PORT_MAX}`);
  }
  if (port === other) {
    return fail(`already used by ${otherName}`);
  }
  return { ok: true, value: port };
};

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const parseExecutable = (text: string): ParsedSetting => {
  const value = expandHome(text);
  if (value.includes("/")) {
    return isExecutable(value) ? { ok: true, value } : fail(`${value} is not an executable file`);
  }
  const onPath = (process.env["PATH"] ?? "").split(delimiter).some((dir) => isExecutable(join(dir, value)));
  return onPath ? { ok: true, value } : fail(`"${value}" is not on your PATH; give the full path to xray`);
};

const parseAssetsPath = (text: string): ParsedSetting => {
  const value = expandHome(text).replace(/\/+$/u, "");
  const missing = ["geoip.dat", "geosite.dat"].filter((file) => !existsSync(join(value, file)));
  if (!existsSync(value)) {
    return fail(`${value} does not exist`);
  }
  return missing.length === 0 ? { ok: true, value } : fail(`${value} has no ${missing.join(" or ")}`);
};

const parseDohDns = (text: string): ParsedSetting => {
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:") {
      return fail("must be an HTTPS URL, e.g. https://1.1.1.1/dns-query");
    }
    return { ok: true, value: text };
  } catch {
    return fail("must be a valid URL, e.g. https://1.1.1.1/dns-query");
  }
};

const parseDnsServers = (text: string): ParsedSetting => {
  const servers = text.split(LIST_SEPARATOR).filter((part) => part.length > 0);
  const invalid = servers.filter((server) => !z.safeParse(z.ipv4(), server).success);
  if (servers.length === 0 || invalid.length > 0) {
    return fail(invalid.length > 0 ? `not IPv4 addresses: ${invalid.join(", ")}` : "at least one IPv4 address, e.g. 1.1.1.1, 8.8.8.8");
  }
  return { ok: true, value: servers };
};

const parseRoutingMode = (text: string): ParsedSetting => {
  const mode = text.toLowerCase();
  if (mode === "proxy" || mode === "direct") {
    return { ok: true, value: mode };
  }
  return fail('must be "proxy" or "direct"');
};

export const SETTINGS: readonly SettingSpec[] = [
  {
    description: "Default catch-all route at the end of rules (proxy or direct)",
    key: "routingMode",
    label: "Routing mode",
    parse: parseRoutingMode,
    reloadsXray: true,
  },
  {
    description: "DNS-over-HTTPS server URL (default: https://1.1.1.1/dns-query)",
    key: "dohDns",
    label: "DoH DNS",
    parse: parseDohDns,
    reloadsXray: true,
  },
  {
    description: "DNS servers in TUN mode (IPv4, comma-separated)",
    key: "tunDns",
    label: "TUN DNS",
    parse: parseDnsServers,
    reloadsXray: true,
  },
  {
    description: "Local HTTP + SOCKS5 proxy port",
    key: "mixedPort",
    label: "Proxy port",
    parse: (text, settings) => parsePort(text, settings.apiPort, "the API port"),
    reloadsXray: true,
  },
  {
    description: "xray's gRPC API port (local only)",
    key: "apiPort",
    label: "API port",
    parse: (text, settings) => parsePort(text, settings.mixedPort, "the proxy port"),
    reloadsXray: true,
  },
  {
    description: "Path to the xray binary, or a name on your PATH",
    key: "xrayExecutable",
    label: "xray executable",
    parse: parseExecutable,
    reloadsXray: true,
  },
  {
    description: "Folder with geoip.dat and geosite.dat",
    key: "xrayAssetsPath",
    label: "xray assets",
    parse: parseAssetsPath,
    reloadsXray: true,
  },
  {
    description: "TUN interface address (IPv4 CIDR)",
    key: "gateway",
    label: "TUN gateway",
    parse: (text) => (z.safeParse(z.cidrv4(), text).success ? { ok: true, value: text } : fail("an IPv4 CIDR like 10.10.20.1/24")),
    reloadsXray: true,
  },
  {
    description: "How often subscriptions refresh in the background, in minutes",
    key: "subUpdateIntervalMinutes",
    label: "Subscription refresh",
    parse: (text) => {
      const minutes = Number(text);
      return DIGITS.test(text) && minutes >= 1 ? { ok: true, value: minutes } : fail("a whole number of minutes, at least 1");
    },
    reloadsXray: false,
  },
];

/** The spec for `key`, accepting either spelling (`mixedPort`, `mixed-port`, `dnsServers` -> `tunDns`). */
export const findSetting = (key: string): SettingSpec | undefined => {
  const wanted = key.replaceAll("-", "").toLowerCase();
  if (wanted === "dnsservers") {
    return SETTINGS.find((spec) => spec.key === "tunDns");
  }
  return SETTINGS.find((spec) => spec.key.toLowerCase() === wanted);
};

/** The effective value of a setting, as text. */
export const formatSetting = (spec: SettingSpec, settings: Settings): string => {
  switch (spec.key) {
    case "routingMode": {
      return settings.routingMode;
    }
    case "dohDns": {
      return settings.dohDns;
    }
    case "tunDns": {
      return settings.tunDns.join(", ");
    }
    case "mixedPort": {
      return String(settings.mixedPort);
    }
    case "apiPort": {
      return String(settings.apiPort);
    }
    case "xrayExecutable": {
      return settings.xrayExecutable;
    }
    case "xrayAssetsPath": {
      return settings.xrayAssetsPath;
    }
    case "gateway": {
      return settings.gateway;
    }
    default: {
      return String(settings.subUpdateIntervalMinutes);
    }
  }
};

/** Whether `config.json` sets this key (otherwise it follows its default). */
export const isCustomized = (spec: SettingSpec): boolean => Object.hasOwn(readRawSettings(), spec.key);
