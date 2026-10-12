// A throwaway xray used only for latency tests: one local HTTP inbound per
// proxy under test, each routed to that proxy, plus one routed to `freedom`
// for the direct-internet check. No TUN, no API, no mixed port, so it never
// touches the user's traffic. Reused while it covers the requested proxies,
// stopped after a short idle period.
//
// Types here are plain JSON-safe records on purpose: scriptc cannot type the
// xray-schema config types statically and would treat them (and anything
// stored next to them, like the child process) as dynamic values.
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";

import { loadSettings, resolveAssetsPath } from "../../config/settings.js";
import { getAppDirs, writeFileEnsured } from "../../utils/fs.js";
import { findFreePorts, waitForPort } from "../../utils/ports.js";
import type { ManagedOutbound } from "../subscription/types.js";
import { killProcessTree, makeLineReader, spawnGuardedXray, stopGuardedXray, XRAY_PID_PREFIX } from "../xray-process.js";

const LOCALHOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 4000;
const IDLE_SHUTDOWN_MS = 30_000;
const DIRECT_INBOUND = "probe-direct-in";
const DIRECT_OUTBOUND = "probe-direct";
const IN_TAG_PREFIX = "probe-in-";
const OUT_TAG_PREFIX = "probe-out-";
const MAX_ERROR_LINES = 5;

export interface ProbeTarget {
  readonly id: string;
  readonly outbound: ManagedOutbound;
}

/** Where to send test requests. A target missing from `ports` was rejected by xray (see `rejected`). */
export interface ProbePorts {
  readonly directPort: number;
  readonly ports: Map<string, number>;
  /** Targets dropped because xray rejected their outbound config, with xray's reason. */
  readonly rejected: Map<string, string>;
}

/** The real xray pid, reported by the guardian a moment after spawn. */
interface XrayPid {
  value: number | null;
}

interface Instance {
  readonly child: ChildProcess;
  readonly pid: XrayPid;
  readonly targets: readonly ProbeTarget[];
  readonly ports: ProbePorts;
}

interface InboundJson {
  readonly listen: string;
  readonly port: number;
  readonly protocol: string;
  readonly tag: string;
}

interface OutboundJson {
  readonly protocol: string;
  readonly tag: string;
  readonly settings?: Record<string, unknown>;
  readonly streamSettings?: Record<string, unknown>;
  readonly proxySettings?: Record<string, unknown>;
  readonly mux?: Record<string, unknown>;
}

interface RuleJson {
  readonly inboundTag: string[];
  readonly outboundTag: string;
}

interface ProbeConfigJson {
  readonly log: { readonly loglevel: string };
  readonly inbounds: InboundJson[];
  readonly outbounds: OutboundJson[];
  readonly routing: { readonly domainStrategy: string; readonly rules: RuleJson[] };
}

let current: Instance | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Starts, uses and stops are serialized: a restart must not pull ports from under running tests. */
let chain: Promise<unknown> = Promise.resolve();

const buildConfig = (targets: readonly ProbeTarget[], ports: readonly number[], directPort: number): ProbeConfigJson => {
  const inbounds: InboundJson[] = [{ listen: LOCALHOST, port: directPort, protocol: "http", tag: DIRECT_INBOUND }];
  const outbounds: OutboundJson[] = [{ protocol: "freedom", tag: DIRECT_OUTBOUND }];
  const rules: RuleJson[] = [{ inboundTag: [DIRECT_INBOUND], outboundTag: DIRECT_OUTBOUND }];
  let i = 0;
  for (const target of targets) {
    const node = target.outbound;
    inbounds.push({ listen: LOCALHOST, port: ports[i] ?? 0, protocol: "http", tag: `${IN_TAG_PREFIX}${i}` });
    outbounds.push({
      mux: node.mux,
      protocol: node.protocol,
      proxySettings: node.proxySettings,
      settings: node.settings,
      streamSettings: node.streamSettings,
      tag: `${OUT_TAG_PREFIX}${i}`,
    });
    rules.push({ inboundTag: [`${IN_TAG_PREFIX}${i}`], outboundTag: `${OUT_TAG_PREFIX}${i}` });
    i += 1;
  }
  return { inbounds, log: { loglevel: "warning" }, outbounds, routing: { domainStrategy: "AsIs", rules } };
};

/** The `n` of the first `probe-out-<n>` tag in xray's error, if it names one. */
const blamedIndex = (message: string): number | null => {
  const at = message.indexOf(OUT_TAG_PREFIX);
  if (at === -1) {
    return null;
  }
  let digits = "";
  for (const char of message.slice(at + OUT_TAG_PREFIX.length)) {
    if (char < "0" || char > "9") {
      break;
    }
    digits += char;
  }
  return digits.length > 0 ? Number(digits) : null;
};

interface StartAttempt {
  readonly instance: Instance | null;
  readonly error: string;
  /** Index of the outbound xray blamed, when its error names one. */
  readonly culprit: number | null;
}

interface Flag {
  value: boolean;
}

const startOnce = async (targets: readonly ProbeTarget[], rejected: Map<string, string>): Promise<StartAttempt> => {
  const settings = loadSettings();
  const allPorts = await findFreePorts(targets.length + 1);
  const directPort = allPorts[0] ?? 0;
  const ports = allPorts.slice(1);
  const configPath = join(getAppDirs().data, `probe-xray.${process.pid}.json`);
  writeFileEnsured(configPath, JSON.stringify(buildConfig(targets, ports, directPort), null, 2));

  const assetsPath = resolveAssetsPath(settings.xrayAssetsPath, settings.xrayExecutable);
  const child = spawnGuardedXray(settings.xrayExecutable, configPath, assetsPath);
  const pid: XrayPid = { value: null };
  const exited: Flag = { value: false };
  const lines: string[] = [];
  const onData = makeLineReader((line) => {
    if (line.startsWith(XRAY_PID_PREFIX)) {
      pid.value = Number(line.slice(XRAY_PID_PREFIX.length).trim()) || null;
      return;
    }
    lines.push(line);
    if (lines.length > MAX_ERROR_LINES * 4) {
      lines.shift();
    }
  });
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("exit", () => {
    exited.value = true;
  });
  child.on("error", (error: Error) => {
    exited.value = true;
    lines.push(error.message);
  });

  const ready = await waitForPort(directPort, STARTUP_TIMEOUT_MS);
  if (ready && !exited.value) {
    const portById = new Map<string, number>();
    let i = 0;
    for (const target of targets) {
      portById.set(target.id, ports[i] ?? 0);
      i += 1;
    }
    return { culprit: null, error: "", instance: { child, pid, ports: { directPort, ports: portById, rejected }, targets } };
  }

  await stopGuardedXray(child, pid.value);
  const error = lines.slice(-MAX_ERROR_LINES).join("\n") || "test xray did not start";
  return { culprit: blamedIndex(error), error, instance: null };
};

/**
 * Start a test xray for `targets`. xray refuses the whole config if any one
 * outbound is invalid; its error names the tag, so drop that target and retry.
 */
const start = async (targets: readonly ProbeTarget[]): Promise<Instance> => {
  const rejected = new Map<string, string>();
  let remaining = targets;
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const attempt = await startOnce(remaining, rejected);
    if (attempt.instance) {
      return attempt.instance;
    }
    const blamed = attempt.culprit === null ? undefined : remaining[attempt.culprit];
    if (!blamed) {
      throw new Error(attempt.error);
    }
    rejected.set(blamed.id, attempt.error);
    remaining = remaining.filter((target) => target.id !== blamed.id);
  }
};

const covers = (instance: Instance, targets: readonly ProbeTarget[]): boolean =>
  targets.every((target) => instance.ports.ports.has(target.id) || instance.ports.rejected.has(target.id));

const stopCurrent = async (): Promise<void> => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const instance = current;
  current = null;
  if (instance) {
    await stopGuardedXray(instance.child, instance.pid.value);
  }
};

const scheduleIdleStop = (): void => {
  if (idleTimer) {
    clearTimeout(idleTimer);
  }
  idleTimer = setTimeout(() => {
    chain = chain.then(stopCurrent).catch(() => null);
  }, IDLE_SHUTDOWN_MS);
};

/** Union of the running instance's targets and `targets`, so alternating lists don't thrash restarts. */
const mergeTargets = (targets: readonly ProbeTarget[]): ProbeTarget[] => {
  const byId = new Map<string, ProbeTarget>();
  for (const target of current?.targets ?? []) {
    byId.set(target.id, target);
  }
  for (const target of targets) {
    byId.set(target.id, target);
  }
  const merged: ProbeTarget[] = [];
  for (const target of byId.values()) {
    merged.push(target);
  }
  return merged;
};

const ensureInstance = async (targets: readonly ProbeTarget[]): Promise<Instance> => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (current && covers(current, targets)) {
    return current;
  }
  const wanted = mergeTargets(targets);
  await stopCurrent();
  const started = await start(wanted);
  current = started;
  return started;
};

/**
 * Run `use` against a test xray that covers `targets`, starting or restarting
 * one if needed. Calls are serialized; the instance stays warm for reuse.
 */
export const withProbeXray = (targets: readonly ProbeTarget[], use: (ports: ProbePorts) => Promise<void>): Promise<void> => {
  const run = async (): Promise<void> => {
    const instance = await ensureInstance(targets);
    try {
      await use(instance.ports);
    } finally {
      scheduleIdleStop();
    }
  };
  const result = chain.then(run);
  chain = result.catch(() => null);
  return result;
};

/** Stop the test xray now and wait for it (CLI exit, daemon shutdown). */
export const stopProbeXray = (): Promise<void> => {
  const stopped = chain.then(stopCurrent);
  chain = stopped.catch(() => null);
  return stopped;
};

/** Synchronous best-effort kill for process-exit handlers. */
export const killProbeXrayNow = (): void => {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (current) {
    killProcessTree(current.child, current.pid.value);
    current = null;
  }
};
