// Latency tests from the CLI: through the daemon when one runs (it owns the
// main xray, keeps a warm test xray and caches results), otherwise in this
// process (same service, its test xray stopped by `close`).
import pc from "picocolors";

import type { LatencyEntry, NetDiagnosis, ResponseOf } from "../protocol.js";
import { diagnose, probeNodes } from "../services/latency/latency-service.js";
import { stopProbeXray } from "../services/latency/probe-xray.js";
import { checkHandlerInfo } from "./handler.js";
import { callHelper } from "./ipc.js";
import type { LiveStatus } from "./prompts.js";

const FAST_MS = 300;
const SLOW_MS = 800;

export interface LatencyClient {
  readonly probe: (ids: readonly string[], refresh: boolean) => readonly LatencyEntry[];
  readonly diagnose: (refresh: boolean) => NetDiagnosis;
  /** Release in-process resources (the local test xray). */
  readonly close: () => Promise<void>;
}

const daemonClient: LatencyClient = {
  close: () => Promise.resolve(),
  diagnose: (refresh) => {
    const res = callHelper<ResponseOf<"net:diagnose">>({ refresh, type: "net:diagnose" });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.result;
  },
  probe: (ids, refresh) => {
    const res = callHelper<ResponseOf<"latency:probe">>({ ids: [...ids], refresh, type: "latency:probe" });
    if (!res.ok) {
      throw new Error(res.error);
    }
    return res.result;
  },
};

const localClient: LatencyClient = {
  close: () => stopProbeXray(),
  // No daemon means no main xray: the active proxy is tested with a test xray.
  diagnose: (refresh) => diagnose(null, refresh),
  probe: (ids, refresh) => probeNodes(ids, refresh),
};

export const createLatencyClient = (): LatencyClient => (checkHandlerInfo() ? daemonClient : localClient);

/** `212ms` colored by speed, `timeout` / `error` in red. */
export const formatLatency = (entry: LatencyEntry): string => {
  if (entry.state === "ok") {
    const ms = entry.ms ?? 0;
    const text = `${ms}ms`;
    if (ms < FAST_MS) {
      return pc.green(text);
    }
    return ms < SLOW_MS ? pc.yellow(text) : pc.red(text);
  }
  if (entry.state === "timeout") {
    return pc.red("timeout");
  }
  return entry.state === "error" ? pc.red("error") : "";
};

/**
 * A `refresh` callback for `liveSelectPrompt`. `rowIds[row]` is the node id of
 * each row ("" for headers). Only rows on screen are tested: the first time a
 * row appears it is tested fresh, afterwards cached results are reused, so
 * scrolling back is instant and scrolling past a row does not test it.
 */
export const latencyRefresher = (client: LatencyClient, rowIds: readonly string[]) => {
  const requested = new Set<string>();
  return (visibleRows: readonly number[]): LiveStatus[] => {
    const firstSeen: string[] = [];
    const seenBefore: string[] = [];
    const rowsById = new Map<string, number[]>();
    for (const row of visibleRows) {
      const id = row < rowIds.length ? (rowIds[row] as string) : "";
      if (id.length === 0) {
        continue;
      }
      const rows = rowsById.get(id);
      if (rows) {
        rows.push(row);
        continue;
      }
      rowsById.set(id, [row]);
      if (requested.has(id)) {
        seenBefore.push(id);
      } else {
        requested.add(id);
        firstSeen.push(id);
      }
    }

    const entries: LatencyEntry[] = [];
    for (const entry of firstSeen.length > 0 ? client.probe(firstSeen, true) : []) {
      entries.push(entry);
    }
    for (const entry of seenBefore.length > 0 ? client.probe(seenBefore, false) : []) {
      entries.push(entry);
    }

    const statuses: LiveStatus[] = [];
    for (const entry of entries) {
      for (const row of rowsById.get(entry.id) ?? []) {
        statuses.push({ loading: entry.state === "pending", row, text: formatLatency(entry) });
      }
    }
    return statuses;
  };
};
