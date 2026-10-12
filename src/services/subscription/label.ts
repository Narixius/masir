import type { ManagedOutbound } from "./types.js";

/** Tags panels give every proxy outbound in full JSON configs; they name nothing. */
const GENERIC_TAGS: ReadonlySet<string> = new Set(["proxy", "out", "outbound"]);

export const isGenericTag = (tag: string): boolean => GENERIC_TAGS.has(tag.trim().toLowerCase());

/** The server address part of the common outbound shapes (`vnext`, `servers`, flat `address`). */
interface ServerSettings {
  readonly address?: string;
  readonly port?: number;
  readonly vnext?: readonly { readonly address?: string; readonly port?: number }[];
  readonly servers?: readonly { readonly address?: string; readonly port?: number }[];
}

/** `host:port` of the server an outbound dials, when its settings say. */
export const serverAddress = (outbound: ManagedOutbound): string | undefined => {
  const settings = outbound.settings as ServerSettings | undefined;
  const server = settings?.vnext?.[0] ?? settings?.servers?.[0] ?? settings;
  if (!server || typeof server.address !== "string") {
    return undefined;
  }
  return typeof server.port === "number" ? `${server.address}:${server.port}` : server.address;
};

/**
 * Display name for an outbound: the provider's remarks, else a meaningful tag,
 * else `protocol · host:port` (better than a list of identical "proxy" rows).
 */
export const outboundLabel = (outbound: ManagedOutbound): string => {
  if (outbound.remarks) {
    return outbound.remarks;
  }
  if (!isGenericTag(outbound.tag)) {
    return outbound.tag;
  }
  const address = serverAddress(outbound);
  return address ? `${outbound.protocol} · ${address}` : outbound.tag;
};
