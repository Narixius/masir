// xray's geo data for the rule pickers and rule descriptions: categories in
// geosite.dat / geoip.dat with counts, and human-readable names
// (`geosite:category-ir` -> "🇮🇷 Iranian Websites"), decoded natively.
import { join } from "node:path";

import { loadSettings, resolveAssetsPath } from "../../config/settings.js";
import { nativeGeo } from "../../native.js";

export interface GeoAttribute {
  readonly key: string;
  readonly count: number;
}

export interface GeoCategory {
  /** Lowercase code as written in rules, without the `geosite:` / `geoip:` prefix. */
  readonly code: string;
  readonly label: string;
  readonly flag?: string;
  /** Domains (geosite) or IP ranges (geoip). */
  readonly count: number;
  /** geosite only: attributes usable as `geosite:<code>@<key>`. */
  readonly attrs?: GeoAttribute[];
}

export type GeoKind = "geosite" | "geoip";

const INITIAL_BUFFER_BYTES = 512 * 1024;
const BUFFER_GROWTH = 4;
const MAX_ATTEMPTS = 3;
const BUFFER_TOO_SMALL = -3;
const HUMANIZE_BUFFER_BYTES = 512;

const dataFile = (kind: GeoKind): string => {
  const settings = loadSettings();
  return join(resolveAssetsPath(settings.xrayAssetsPath, settings.xrayExecutable), `${kind}.dat`);
};

/** Every category in the geosite or geoip file xray uses; empty if it can't be read. */
export const listGeo = (kind: GeoKind): GeoCategory[] => {
  const path = dataFile(kind);
  let size = INITIAL_BUFFER_BYTES;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const out = Buffer.alloc(size);
    const written = nativeGeo.list(path, kind === "geosite" ? 0 : 1, out);
    if (written > 0) {
      return JSON.parse(out.subarray(0, written).toString("utf-8")) as GeoCategory[];
    }
    if (written !== BUFFER_TOO_SMALL) {
      break;
    }
    size *= BUFFER_GROWTH;
  }
  return [];
};

export interface HumanName {
  readonly label: string;
  readonly flag?: string;
}

const humanizeCode = (code: string): HumanName | null => {
  const out = Buffer.alloc(HUMANIZE_BUFFER_BYTES);
  const written = nativeGeo.humanize(code, out);
  return written > 0 ? (JSON.parse(out.subarray(0, written).toString("utf-8")) as HumanName) : null;
};

/** `cn` -> "(China)", `!cn` -> "(not China)", `ads` -> "(ads)". */
export const attributeLabel = (attr: string): string => {
  const negated = attr.startsWith("!");
  const key = negated ? attr.slice(1) : attr;
  const country = key.length === 2 ? humanizeCode(`geoip:${key}`) : null;
  if (country) {
    return negated ? `(not ${country.label})` : `(${country.label})`;
  }
  return `(${attr})`;
};

const humanCache = new Map<string, HumanName | null>();

/**
 * A readable name for a `geosite:` / `geoip:` value (attributes included:
 * `geosite:google@cn` -> "Google (China)"); `null` for anything else.
 */
export const humanizeGeoValue = (value: string): HumanName | null => {
  const cached = humanCache.get(value);
  if (cached !== undefined) {
    return cached;
  }
  let result: HumanName | null = null;
  if (value.startsWith("geosite:") || value.startsWith("geoip:")) {
    const [code = value, attr] = value.split("@");
    const name = humanizeCode(code);
    if (name) {
      result = attr ? { ...name, label: `${name.label} ${attributeLabel(attr)}` } : name;
    }
  }
  humanCache.set(value, result);
  return result;
};

/** "🇮🇷 Iranian Websites" / "Ads All". */
export const formatHumanName = (name: HumanName): string => (name.flag ? `${name.flag} ${name.label}` : name.label);
