import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createLogger } from "evlog";
import * as z from "zod/mini";

import { getAppDirs, writeFileEnsured } from "../utils/fs.js";

const hasGeoData = (dir: string): boolean => existsSync(join(dir, "geoip.dat"));

const findExeAssets = (exe: string): string | null => {
  if (exe.includes("/")) {
    const dir = dirname(exe);
    return hasGeoData(dir) ? dir : null;
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  const pathDirs = (process.env["PATH"] ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (existsSync(join(dir, exe)) && hasGeoData(dir)) {
      return dir;
    }
  }
  return null;
};

export const resolveAssetsPath = (configuredPath?: string, executablePath?: string): string => {
  if (configuredPath && hasGeoData(configuredPath)) {
    return configuredPath;
  }

  const envAsset = process.env["XRAY_LOCATION_ASSET"];
  if (envAsset && hasGeoData(envAsset)) {
    return envAsset;
  }

  const exe = executablePath ?? process.env["XRAY_EXECUTABLE"] ?? "xray";
  const exeAsset = findExeAssets(exe);
  if (exeAsset) {
    return exeAsset;
  }

  const home = process.env["HOME"] ?? "";
  const standardDirs: readonly string[] = [
    "/Applications/masir.app/Contents/Resources/resources",
    home.length > 0 ? join(home, "Library/Application Support/com.narixius.masir") : "",
    "/opt/homebrew/share/xray",
    "/usr/local/share/xray",
  ];

  for (const dir of standardDirs) {
    if (dir.length > 0 && hasGeoData(dir)) {
      return dir;
    }
  }

  return configuredPath ?? "/usr/local/share/xray";
};

/**
 * Fallbacks are functions so importing this module does no filesystem probing;
 * asset discovery only runs when a config actually lacks `xrayAssetsPath`.
 */
const defaults = {
  apiPort: () => 10_085,
  dnsServers: () => ["1.1.1.1", "8.8.8.8"],
  gateway: () => "10.10.20.1/24",
  mixedPort: () => 8083,
  subUpdateIntervalMinutes: () => 720,
  xrayAssetsPath: () => resolveAssetsPath(process.env["XRAY_LOCATION_ASSET"]),
  xrayExecutable: () => process.env["XRAY_EXECUTABLE"] ?? "xray",
};

const withDefault = <T extends z.ZodMiniType>(key: string, schema: T, fallback: () => z.output<T>) =>
  z.catch(schema, (ctx) => {
    const value = fallback();
    if (ctx.value !== undefined) {
      console.warn(`[config] invalid "${key}": ${ctx.issues[0]?.message}. Using default: ${String(value)}`);
    }
    return value;
  });

const port = z.int().check(z.gte(1), z.lte(65_535));
const nonEmpty = z.string().check(z.minLength(1));
const positiveInt = z.int().check(z.gte(1));
const SettingsSchema = z.object({
  apiPort: withDefault("apiPort", port, defaults.apiPort),
  dnsServers: withDefault("dnsServers", z.array(z.ipv4()).check(z.minLength(1)), defaults.dnsServers),
  gateway: withDefault("gateway", z.cidrv4(), defaults.gateway),
  mixedPort: withDefault("mixedPort", port, defaults.mixedPort),
  subUpdateIntervalMinutes: withDefault("subUpdateIntervalMinutes", positiveInt, defaults.subUpdateIntervalMinutes),
  xrayAssetsPath: withDefault("xrayAssetsPath", nonEmpty, defaults.xrayAssetsPath),
  xrayExecutable: withDefault("xrayExecutable", nonEmpty, defaults.xrayExecutable),
});

export type Settings = z.infer<typeof SettingsSchema>;

const configFilePath = (): string => join(getAppDirs().config, "config.json");

const readRawSettings = (): Record<string, unknown> => {
  const path = configFilePath();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    createLogger({ operation: "load-settings" }).warn(`[config] ${path} missing or unparsable, using defaults`);
  }
  return {};
};

export const loadSettings = (): Settings => z.parse(SettingsSchema, readRawSettings());

/** Merge `changes` over the current settings, validate, and persist. */
export const saveSettings = (changes: Partial<Settings>): Settings => {
  const current = loadSettings();
  // Field by field on purpose: scriptc cannot compile spreads of the zod-inferred type.
  const merged = z.parse(SettingsSchema, {
    apiPort: changes.apiPort ?? current.apiPort,
    dnsServers: changes.dnsServers ?? current.dnsServers,
    gateway: changes.gateway ?? current.gateway,
    mixedPort: changes.mixedPort ?? current.mixedPort,
    subUpdateIntervalMinutes: changes.subUpdateIntervalMinutes ?? current.subUpdateIntervalMinutes,
    xrayAssetsPath: changes.xrayAssetsPath ?? current.xrayAssetsPath,
    xrayExecutable: changes.xrayExecutable ?? current.xrayExecutable,
  });
  writeFileEnsured(configFilePath(), JSON.stringify(merged, null, 2));
  return merged;
};
