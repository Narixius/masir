import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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

/** masir's own xray folder (binary and geo data), where a future installer will put xray. */
export const masirXrayDir = (): string => join(getAppDirs().data, "xray");

interface XrayLocation {
  /** Folder holding the `xray` binary. */
  readonly bin: string;
  /** Folder holding geoip.dat / geosite.dat. */
  readonly share: string;
}

/** Where xray is normally installed on this OS, masir's own folder first. */
const standardLocations = (): XrayLocation[] => {
  const own = masirXrayDir();
  const locations: XrayLocation[] = [{ bin: own, share: own }];
  if (process.platform === "darwin") {
    // Homebrew on Apple Silicon, then Homebrew on Intel / manual installs.
    locations.push(
      { bin: "/opt/homebrew/bin", share: "/opt/homebrew/share/xray" },
      { bin: "/usr/local/bin", share: "/usr/local/share/xray" }
    );
  } else {
    // xray's official install script, then distribution packages.
    locations.push({ bin: "/usr/local/bin", share: "/usr/local/share/xray" }, { bin: "/usr/bin", share: "/usr/share/xray" });
  }
  return locations;
};

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** `XRAY_EXECUTABLE`, else xray in PATH or a standard location. */
export const resolveXrayExecutable = (configured?: string): string => {
  if (configured?.includes("/")) {
    return configured;
  }
  const fromEnv = process.env["XRAY_EXECUTABLE"];
  if (fromEnv && (!configured || configured === "xray")) {
    return fromEnv;
  }
  const exeName = configured || "xray";
  const delimiter = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (dir) {
      const candidate = join(dir, exeName);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  for (const location of standardLocations()) {
    const candidate = join(location.bin, exeName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return exeName;
};

/**
 * The geo data folder: the configured one if it has the files, else
 * `XRAY_LOCATION_ASSET`, else a standard location, else next to the xray that
 * is used (xray's own default). Without any, masir's own folder.
 */
export const resolveAssetsPath = (configuredPath?: string, executablePath?: string): string => {
  if (configuredPath && hasGeoData(configuredPath)) {
    return configuredPath;
  }
  const envAsset = process.env["XRAY_LOCATION_ASSET"];
  if (envAsset && hasGeoData(envAsset)) {
    return envAsset;
  }
  for (const location of standardLocations()) {
    if (hasGeoData(location.share)) {
      return location.share;
    }
  }
  return findExeAssets(executablePath ?? resolveXrayExecutable()) ?? configuredPath ?? masirXrayDir();
};

const routingModeSchema = z.enum(["proxy", "direct"]);
export type RoutingMode = z.infer<typeof routingModeSchema>;

/**
 * Fallbacks are functions so importing this module does no filesystem probing;
 * asset discovery only runs when a config actually lacks `xrayAssetsPath`.
 */
const defaults = {
  apiPort: () => 10_085,
  dnsServers: () => ["1.1.1.1", "8.8.8.8"],
  gateway: () => "10.10.20.1/24",
  mixedPort: () => 8083,
  routingMode: (): RoutingMode => "proxy",
  subUpdateIntervalMinutes: () => 60,
  xrayAssetsPath: () => resolveAssetsPath(process.env["XRAY_LOCATION_ASSET"]),
  xrayExecutable: () => resolveXrayExecutable(),
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
  routingMode: withDefault("routingMode", routingModeSchema, defaults.routingMode),
  subUpdateIntervalMinutes: withDefault("subUpdateIntervalMinutes", positiveInt, defaults.subUpdateIntervalMinutes),
  xrayAssetsPath: withDefault("xrayAssetsPath", nonEmpty, defaults.xrayAssetsPath),
  xrayExecutable: withDefault("xrayExecutable", nonEmpty, defaults.xrayExecutable),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const configFilePath = (): string => join(getAppDirs().config, "config.json");

/** What `config.json` holds, as written (keys you set; anything missing uses its default). */
export const readRawSettings = (): Record<string, unknown> => {
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

export const loadSettings = (): Settings => {
  const parsed = z.parse(SettingsSchema, readRawSettings());
  return {
    ...parsed,
    xrayExecutable: resolveXrayExecutable(parsed.xrayExecutable),
  };
};

/** A value `config.json` can hold. */
export type SettingValue = number | string | string[];

/**
 * Set (or without a value, remove) one key in `config.json`. Only keys the
 * user set are written, so unset ones keep following their live default
 * (e.g. the auto-detected assets path).
 */
export const writeSetting = (key: string, value?: SettingValue): Settings => {
  const next: Record<string, unknown> = {};
  for (const [existing, existingValue] of Object.entries(readRawSettings())) {
    if (existing !== key) {
      next[existing] = existingValue;
    }
  }
  if (value !== undefined) {
    next[key] = value;
  }
  writeFileEnsured(configFilePath(), JSON.stringify(next, null, 2));
  return loadSettings();
};

/** Persist the assets folder (`masir connect --assets`). */
export const saveAssetsPath = (path: string): Settings => writeSetting("xrayAssetsPath", path);

/** Persist the default catch-all routing mode (`masir mode`). */
export const saveRoutingMode = (mode: RoutingMode): Settings => writeSetting("routingMode", mode);
