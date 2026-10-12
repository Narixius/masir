import { parseLink } from "@gozargah/xray-schema/link";
import { createLogger } from "evlog";

import { generateOutboundId } from "./id.js";
import { isGenericTag } from "./label.js";
import type { ManagedOutbound, SubscriptionUserInfo } from "./types.js";

const USER_AGENT = "v2rayNG/2.0.15";
const ACCEPT_HEADER = "application/json";

const parseUserInfoHeader = (header: string | null): SubscriptionUserInfo | undefined => {
  if (!header) {
    return undefined;
  }
  const parts = header.split(";").map((part) => part.trim());
  const map = new Map<string, number>();
  for (const part of parts) {
    const [key, value] = part.split("=").map((item) => item?.trim());
    if (key && value) {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        map.set(key.toLowerCase(), num);
      }
    }
  }

  const upload = map.get("upload") ?? 0;
  const download = map.get("download") ?? 0;
  const total = map.get("total") ?? 0;
  const expire = map.get("expire") ?? 0;

  return { download, expire, total, upload };
};

const tryDecodeBase64 = (rawText: string): string => {
  const sanitized = rawText.trim().replaceAll(/\s+/gu, "");
  // Quick heuristic: must be base64-like characters and not already start with a protocol
  if (sanitized.includes("://")) {
    return rawText;
  }
  try {
    const decoded = Buffer.from(sanitized, "base64").toString("utf-8");
    if (decoded.includes("://") || decoded.startsWith("{") || decoded.startsWith("[")) {
      return decoded;
    }
  } catch {
    // Not valid base64
  }
  return rawText;
};

/** Outbounds in a full config that are not the proxy server itself. */
const NON_PROXY_PROTOCOLS: ReadonlySet<string> = new Set(["freedom", "blackhole", "dns", "loopback"]);

const nonEmpty = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
};

/** A trimmed, non-empty string field of a raw JSON record. */
const stringField = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? nonEmpty(value) : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const resolveRemarks = (raw: Record<string, unknown>, explicit?: string): string | undefined => {
  const fromConfig = nonEmpty(explicit) ?? stringField(raw, "remarks");
  if (fromConfig) {
    return fromConfig;
  }
  const tag = stringField(raw, "tag");
  return tag && !isGenericTag(tag) ? tag : undefined;
};

const normalizeOutbound = (raw: Record<string, unknown>, explicitRemarks?: string): ManagedOutbound => {
  const rawProtocol = raw["protocol"];
  const protocol = typeof rawProtocol === "string" ? rawProtocol : "unknown";
  const id = generateOutboundId(raw);
  const tag = stringField(raw, "tag") ?? `${protocol}-${id}`;
  const remarks = resolveRemarks(raw, explicitRemarks);
  const rawSettings = raw["settings"];
  const settings =
    typeof rawSettings === "object" && rawSettings !== null && !Array.isArray(rawSettings)
      ? (rawSettings as Record<string, unknown>)
      : undefined;
  const rawStream = raw["streamSettings"];
  const streamSettings =
    typeof rawStream === "object" && rawStream !== null && !Array.isArray(rawStream) ? (rawStream as Record<string, unknown>) : undefined;
  const rawProxy = raw["proxySettings"];
  const proxySettings =
    typeof rawProxy === "object" && rawProxy !== null && !Array.isArray(rawProxy) ? (rawProxy as Record<string, unknown>) : undefined;
  const rawMux = raw["mux"];
  const mux = typeof rawMux === "object" && rawMux !== null && !Array.isArray(rawMux) ? (rawMux as Record<string, unknown>) : undefined;

  return {
    id,
    mux,
    protocol,
    proxySettings,
    remarks,
    settings,
    streamSettings,
    tag,
  };
};

export type SubscriptionRawPayload = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;

/** The proxy server outbound of a full xray config: the one tagged `proxy`, else the first real proxy protocol. */
const pickProxyOutbound = (outbounds: readonly unknown[]): Record<string, unknown> | undefined => {
  const records = outbounds.filter(isRecord);
  return (
    records.find((ob) => ob["tag"] === "proxy") ??
    records.find((ob) => typeof ob["protocol"] === "string" && !NON_PROXY_PROTOCOLS.has(ob["protocol"]))
  );
};

/** A full xray config (`{ remarks, outbounds: [...] }`) as one subscription entry. */
const parseFullConfig = (config: Record<string, unknown>): ManagedOutbound | undefined => {
  const { outbounds } = config;
  if (!Array.isArray(outbounds)) {
    return undefined;
  }
  const proxy = pickProxyOutbound(outbounds);
  return proxy ? normalizeOutbound(proxy, stringField(config, "remarks")) : undefined;
};

const parseJsonOutbounds = (data: SubscriptionRawPayload): ManagedOutbound[] => {
  if (Array.isArray(data)) {
    const list: ManagedOutbound[] = [];
    for (const item of data) {
      if (!isRecord(item)) {
        continue;
      }
      if (item["protocol"] !== undefined) {
        list.push(normalizeOutbound(item));
        continue;
      }
      const fromConfig = parseFullConfig(item);
      if (fromConfig) {
        list.push(fromConfig);
      }
    }
    return list;
  }

  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const fromConfig = parseFullConfig(record);
    if (fromConfig) {
      return [fromConfig];
    }
    if (record["protocol"] !== undefined) {
      return [normalizeOutbound(record)];
    }
  }

  return [];
};

export interface FetchSubscriptionResult {
  readonly outbounds: readonly ManagedOutbound[];
  readonly userinfo?: SubscriptionUserInfo;
}

export const fetchAndParseSubscription = async (url: string): Promise<FetchSubscriptionResult> => {
  const log = createLogger({ operation: "fetch-subscription" });
  log.info(`Fetching subscription: ${url}`);

  const response = await fetch(url, {
    headers: {
      Accept: ACCEPT_HEADER,
      "User-Agent": USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch subscription from ${url}: HTTP ${response.status} ${response.statusText}`);
  }

  const userinfo = parseUserInfoHeader(response.headers.get("subscription-userinfo"));
  const rawText = await response.text();

  // Try parsing as JSON first
  try {
    const parsedJson = JSON.parse(rawText) as SubscriptionRawPayload;
    const jsonOutbounds = parseJsonOutbounds(parsedJson);
    if (jsonOutbounds.length > 0) {
      return { outbounds: jsonOutbounds, userinfo };
    }
  } catch {
    // Text is not JSON, proceed to text/link parsing
  }

  // Handle Base64 or plain links
  const decodedText = tryDecodeBase64(rawText);
  const lines = decodedText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const outbounds: ManagedOutbound[] = [];
  for (const line of lines) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop
      const parsed = await parseLink(line);
      const jsonText = JSON.stringify(parsed);
      const itemRecord: unknown = JSON.parse(jsonText);
      if (typeof itemRecord === "object" && itemRecord !== null && !Array.isArray(itemRecord)) {
        outbounds.push(normalizeOutbound(itemRecord as Record<string, unknown>));
      }
    } catch {
      // Gracefully ignore single malformed link
    }
  }

  if (outbounds.length === 0) {
    throw new Error(`No valid outbound configurations found in subscription response from ${url}`);
  }

  return { outbounds, userinfo };
};
