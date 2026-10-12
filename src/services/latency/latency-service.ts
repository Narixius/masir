// Latency tests behind a poll-friendly API: `probeNodes` / `diagnose` start
// whatever is missing and immediately return a snapshot, so a UI can call them
// on every tick and render spinners until nothing is `pending`. Runs inside
// the daemon, or inside the CLI when no daemon is up (same code, same cache
// shape, the CLI just loses the cache when it exits).
import type { LatencyEntry, NetDiagnosis, ProbeVia } from "../../protocol.js";
import { getActiveNode, getAllOutbounds } from "../subscription/storage.js";
import type { NodeRef } from "../subscription/storage.js";
import { measureLatency } from "./http-probe.js";
import type { Measurement } from "./http-probe.js";
import { withProbeXray } from "./probe-xray.js";
import type { ProbeTarget } from "./probe-xray.js";

/** Results are keyed by node id, a hash of its connection settings, so they never go stale on edits. */
const OK_TTL_MS = 2 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const DIAGNOSIS_TTL_MS = 10 * 1000;
const MAX_PARALLEL = 8;
const DIRECT_ID = "direct";

/**
 * A queued test is dropped if nobody asked for it this recently: the CLI asks
 * for the rows on screen every tick, so a row scrolled away goes stale fast.
 */
const WANTED_WITHIN_MS = 1500;

const cache = new Map<string, LatencyEntry>();
/** When each id was last requested; lets queued batches skip rows no longer on screen. */
const wantedAt = new Map<string, number>();
/** Batches run one after another: each may restart the test xray with a different node set. */
let batchChain: Promise<unknown> = Promise.resolve();

const toEntry = (id: string, measurement: Measurement): LatencyEntry => {
  if (measurement.ok) {
    return { id, ms: measurement.ms, state: "ok", testedAt: Date.now() };
  }
  return { error: measurement.error, id, state: measurement.timedOut ? "timeout" : "error", testedAt: Date.now() };
};

const failed = (id: string, error: string): LatencyEntry => ({ error, id, state: "error", testedAt: Date.now() });
const pending = (id: string): LatencyEntry => ({ id, state: "pending" });

const isFresh = (entry: LatencyEntry | undefined, now: number): boolean => {
  if (!entry) {
    return false;
  }
  if (entry.state === "pending") {
    return true;
  }
  const ttl = entry.state === "ok" ? OK_TTL_MS : FAILURE_TTL_MS;
  return entry.testedAt !== undefined && now - entry.testedAt < ttl;
};

/** Run `task` over `items` with at most `limit` in flight. */
const forEachLimited = async <T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      // oxlint-disable-next-line eslint/no-await-in-loop
      await task(item);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
};

const toTarget = (node: NodeRef): ProbeTarget => ({ id: node.outbound.id, outbound: node.outbound });

/** Drop nodes nobody asked about lately; forget their pending state so a later request re-queues them. */
const stillWanted = (nodes: readonly NodeRef[]): NodeRef[] => {
  const now = Date.now();
  const wanted: NodeRef[] = [];
  for (const node of nodes) {
    const { id } = node.outbound;
    if (now - (wantedAt.get(id) ?? 0) <= WANTED_WITHIN_MS) {
      wanted.push(node);
    } else if (cache.get(id)?.state === "pending") {
      cache.delete(id);
    }
  }
  return wanted;
};

const runBatch = async (queued: readonly NodeRef[]): Promise<void> => {
  const nodes = stillWanted(queued);
  if (nodes.length === 0) {
    return;
  }
  try {
    await withProbeXray(nodes.map(toTarget), async (ports) => {
      await forEachLimited(nodes, MAX_PARALLEL, async (node) => {
        const { id } = node.outbound;
        const port = ports.ports.get(id);
        if (port === undefined) {
          cache.set(id, failed(id, ports.rejected.get(id) ?? "xray rejected this config"));
          return;
        }
        cache.set(id, toEntry(id, await measureLatency(port)));
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const node of nodes) {
      cache.set(node.outbound.id, failed(node.outbound.id, message));
    }
  }
};

const enqueue = (task: () => Promise<void>): void => {
  // A failed batch already recorded its errors; it must not block the next one.
  batchChain = batchChain.then(task).catch(() => null);
};

/**
 * Snapshot of the latency of `ids`, starting tests for any that are missing or
 * stale (all of them with `refresh`). Never waits for a test to finish.
 * Callers poll with the ids they still care about (e.g. the rows on screen);
 * queued tests for ids not polled lately are skipped.
 */
export const probeNodes = (ids: readonly string[], refresh = false): LatencyEntry[] => {
  const now = Date.now();
  const nodesById = new Map<string, NodeRef>();
  for (const node of getAllOutbounds()) {
    nodesById.set(node.outbound.id, node);
  }

  const toTest: NodeRef[] = [];
  for (const id of ids) {
    wantedAt.set(id, now);
    const node = nodesById.get(id);
    const entry = cache.get(id);
    const shouldTest = refresh ? entry?.state !== "pending" : !isFresh(entry, now);
    if (node && shouldTest && !toTest.includes(node)) {
      cache.set(id, pending(id));
      toTest.push(node);
    }
  }
  if (toTest.length > 0) {
    enqueue(() => runBatch(toTest));
  }

  return ids.map((id) => cache.get(id) ?? (nodesById.has(id) ? pending(id) : failed(id, "unknown node")));
};

/* -------------------------------------------------------------------------- */
/* Network diagnosis                                                          */
/* -------------------------------------------------------------------------- */

/** The running main xray, if any: its mixed inbound already routes to the active proxy. */
export interface RunningXray {
  readonly mixedPort: number;
}

interface Diagnosis {
  direct: LatencyEntry;
  proxy?: LatencyEntry;
  activeNodeId?: string;
  via?: ProbeVia;
  startedAt: number;
}

let diagnosis: Diagnosis | null = null;

const snapshot = (current: Diagnosis): NetDiagnosis => ({
  activeNodeId: current.activeNodeId,
  direct: current.direct,
  done: current.direct.state !== "pending" && current.proxy?.state !== "pending",
  proxy: current.proxy,
  via: current.via,
});

const runDiagnosis = async (current: Diagnosis, active: NodeRef | null, running: RunningXray | null): Promise<void> => {
  const activeId = active?.outbound.id;
  // Through the running xray when there is one: that is the connection in use.
  const viaRunning = running && activeId ? measureLatency(running.mixedPort) : null;
  const targets = active && !running ? [toTarget(active)] : [];
  try {
    await withProbeXray(targets, async (ports) => {
      const proxyPort = activeId && !running ? ports.ports.get(activeId) : undefined;
      // Both run concurrently; awaited one by one (scriptc has no mixed-tuple Promise.all).
      const directCheck = measureLatency(ports.directPort);
      const proxyCheck = proxyPort === undefined ? null : measureLatency(proxyPort);
      const direct = await directCheck;
      const proxy = proxyCheck ? await proxyCheck : null;
      current.direct = toEntry(DIRECT_ID, direct);
      if (activeId && proxy) {
        current.proxy = toEntry(activeId, proxy);
      } else if (activeId && !running) {
        current.proxy = failed(activeId, ports.rejected.get(activeId) ?? "xray rejected this config");
      }
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    current.direct = failed(DIRECT_ID, message);
    if (activeId && !running) {
      current.proxy = failed(activeId, message);
    }
  }
  if (viaRunning && activeId) {
    current.proxy = toEntry(activeId, await viaRunning);
  }
};

/**
 * Direct internet + active proxy, as a snapshot. Starts a new check when the
 * last one is older than `DIAGNOSIS_TTL_MS` (or with `refresh`), never waits.
 */
export const diagnose = (running: RunningXray | null, refresh = false): NetDiagnosis => {
  const now = Date.now();
  const inFlight = diagnosis !== null && !snapshot(diagnosis).done;
  const fresh = diagnosis !== null && now - diagnosis.startedAt < DIAGNOSIS_TTL_MS;
  if (diagnosis && (inFlight || (fresh && !refresh))) {
    return snapshot(diagnosis);
  }

  const active = getActiveNode();
  const activeId = active?.outbound.id;
  const via: ProbeVia = running ? "running-xray" : "test-xray";
  const next: Diagnosis = {
    activeNodeId: activeId,
    direct: pending(DIRECT_ID),
    proxy: activeId ? pending(activeId) : undefined,
    startedAt: now,
    via: activeId ? via : undefined,
  };
  diagnosis = next;
  enqueue(() => runDiagnosis(next, active, running));
  return snapshot(next);
};
