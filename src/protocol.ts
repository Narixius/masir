// The daemon IPC protocol: one JSON request line -> one JSON response line.
//
// Shared by the CLI and the daemon, so it must stay free of runtime imports
// from daemon code (xray process, gRPC client, ...): the CLI loads this module
// on every command.
import * as z from "zod/mini";

import type { InboundHandlerConfig } from "./injectables/xray/types.js";
import type { SubscriptionUpdateOutcome } from "./services/subscription/types.js";

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

const nonEmpty = z.string().check(z.minLength(1));
const port = z.int().check(z.gte(1), z.lte(65_535));

export const RequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ data: z.string(), type: z.literal("echo") }),
  z.object({ type: z.literal("info") }),
  z.object({ assetsPath: z.optional(nonEmpty), tun: z.optional(z.boolean()), type: z.literal("start") }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("shutdown") }),
  z.object({ type: z.literal("status") }),
  z.object({ onlyTags: z.optional(z.boolean()), type: z.literal("inbound:list") }),
  z.object({ port, tag: nonEmpty, type: z.literal("inbound:add") }),
  z.object({ tag: nonEmpty, type: z.literal("inbound:remove") }),
  z.object({ id: nonEmpty, subName: z.optional(nonEmpty), type: z.literal("sub:use") }),
  z.object({ type: z.literal("sub:reload") }),
  z.object({ type: z.literal("reload") }),
  z.object({ name: z.optional(nonEmpty), type: z.literal("sub:update") }),
  z.object({ ids: z.array(nonEmpty), refresh: z.optional(z.boolean()), type: z.literal("latency:probe") }),
  z.object({ refresh: z.optional(z.boolean()), type: z.literal("net:diagnose") }),
]);

export type Request = z.infer<typeof RequestSchema>;
export type RequestType = Request["type"];
export type RequestOf<K extends RequestType> = Extract<Request, { readonly type: K }>;

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

export type XrayMode = "tun" | "proxy";
export type XrayState = "not-started" | "running" | "error" | "exit";

export interface InfoResult {
  readonly peerUid: number;
  readonly helperEuid: number;
  readonly helperPid: number;
  readonly binaryMtime?: number;
  readonly startedAt?: number;
}

export interface StatusResult {
  readonly daemon: {
    readonly pid: number;
    readonly euid: number;
    readonly privileged: boolean;
    readonly startedAt: number;
  };
  readonly xray: {
    readonly running: boolean;
    readonly state: XrayState;
    readonly pid?: number;
    readonly mode?: XrayMode;
    readonly apiPort?: number;
    readonly startedAt?: number;
    readonly version?: string;
    readonly logFile?: string;
    readonly assetsPath?: string;
    readonly lastError?: string;
  };
}

export interface ReconcileResult {
  readonly apiPort: number;
  readonly pid: number;
  readonly mode: XrayMode;
  readonly status: "started" | "already-running" | "reloaded" | "tun-enabled" | "tun-disabled";
}

/** `pending` while a test runs; the CLI keeps polling until no entry is pending. */
export type LatencyState = "pending" | "ok" | "timeout" | "error";

/** One latency result. Flat (no nested unions) so it crosses the IPC boundary and compiles under scriptc. */
export interface LatencyEntry {
  readonly id: string;
  readonly state: LatencyState;
  readonly ms?: number;
  readonly error?: string;
  readonly testedAt?: number;
}

/** How the active proxy was tested: through the running xray's mixed port, or a throwaway test xray. */
export type ProbeVia = "running-xray" | "test-xray";

export interface NetDiagnosis {
  /** Direct internet: a request that bypasses every proxy. */
  readonly direct: LatencyEntry;
  /** The active proxy; absent when no proxy is selected. */
  readonly proxy?: LatencyEntry;
  readonly activeNodeId?: string;
  readonly via?: ProbeVia;
  /** True once neither check is pending. */
  readonly done: boolean;
}

/** The `result` type of a successful response, per request type. */
export interface ResponseMap {
  readonly ping: string;
  readonly echo: string;
  readonly info: InfoResult;
  readonly start: ReconcileResult;
  readonly stop: string;
  readonly shutdown: string;
  readonly status: StatusResult;
  readonly "inbound:list": { readonly inbounds: readonly InboundHandlerConfig[] };
  readonly "inbound:add": string;
  readonly "inbound:remove": string;
  readonly "sub:use": { readonly activeNodeId: string };
  readonly "sub:reload": string;
  /** Rebuild the config (active node, rules) and restart a running xray. */
  readonly reload: string;
  readonly "sub:update": readonly SubscriptionUpdateOutcome[];
  readonly "latency:probe": readonly LatencyEntry[];
  readonly "net:diagnose": NetDiagnosis;
}

export type ResponseOf<K extends RequestType> = ResponseMap[K];

/** The wire envelope of every response. */
export type Envelope<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Decode a response line into its envelope. The daemon is trusted to send the
 * result type that matches the request, so only the envelope shape is checked.
 */
export const decodeEnvelope = <T>(raw: string): Envelope<T> => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: raw.length > 0 ? raw : "empty response", ok: false };
  }
  if (!isRecord(value)) {
    return { error: "malformed response", ok: false };
  }
  if (value["ok"] === true) {
    return { ok: true, result: value["result"] as T };
  }
  return { error: typeof value["error"] === "string" ? value["error"] : "unknown error", ok: false };
};
