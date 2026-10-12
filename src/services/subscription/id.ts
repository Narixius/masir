import { createHash } from "node:crypto";

export type HashableValue = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>;

export const stableStringify = (val: HashableValue): string => {
  if (val === undefined) {
    return "null";
  }
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean" || val === null) {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    const items: string[] = [];
    for (const item of val) {
      items.push(stableStringify(item as HashableValue));
    }
    return `[${items.join(",")}]`;
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj);
    keys.sort();
    const pairs: string[] = [];
    for (const k of keys) {
      pairs.push(`${JSON.stringify(k)}:${stableStringify(obj[k] as HashableValue)}`);
    }
    return `{${pairs.join(",")}}`;
  }
  return "null";
};

export interface OutboundIdentityParams {
  readonly protocol?: string;
  readonly settings?: unknown;
  readonly streamSettings?: unknown;
}

/** Generates a deterministic 8-character hex hash based on core outbound connection parameters. */
export const generateOutboundId = (outbound: OutboundIdentityParams): string => {
  const identity = {
    protocol: outbound.protocol ?? "",
    settings: outbound.settings ?? {},
    streamSettings: outbound.streamSettings ?? {},
  };
  return createHash("sha256").update(stableStringify(identity)).digest("hex").slice(0, 8);
};
