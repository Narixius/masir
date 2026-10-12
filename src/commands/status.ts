import { defineCommand } from "citty";
import pc from "picocolors";

import p from "../../package.json";
import { loadSettings } from "../config/settings.js";
import type { Settings } from "../config/settings.js";
import type { ResponseOf, StatusResult } from "../protocol.js";
import { checkXrayVersion, MIN_XRAY_VERSION } from "../services/xray-updater.js";
import { checkHandlerInfo } from "../utils/handler.js";
import { callHelper } from "../utils/ipc.js";
import { runConnectivityChecks } from "./connectivity.js";

const pad = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

const formatTimestamp = (timestamp: number): string => {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const mins = pad(d.getMinutes());
  const secs = pad(d.getSeconds());
  return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
};

const formatDuration = (ms: number): string => {
  if (Number.isNaN(ms) || ms < 0) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const days = Math.floor(totalSeconds / 86_400);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};

const renderTree = (title: string, items: readonly string[]): string => {
  const lines: string[] = [title];
  const total = items.length;
  for (let i = 0; i < total; i += 1) {
    const isLast = i === total - 1;
    const branch = isLast ? pc.dim("└─") : pc.dim("├─");
    lines.push(`${branch} ${items[i]}`);
  }
  return lines.join("\n");
};

interface ResolvedDaemon {
  readonly running: boolean;
  readonly pid?: number;
  readonly euid?: number;
  readonly privileged: boolean;
  readonly startedAt?: number;
  readonly uptimeMs?: number;
}

interface ResolvedXray {
  readonly running: boolean;
  readonly state: "not-started" | "running" | "error" | "exit";
  readonly pid?: number;
  readonly mode?: "tun" | "proxy";
  readonly version?: string;
  readonly apiPort?: number;
  readonly logFile?: string;
  readonly assetsPath?: string;
  readonly lastError?: string;
  readonly startedAt?: number;
  readonly uptimeMs?: number;
}

interface ResolvedStatus {
  readonly daemon: ResolvedDaemon;
  readonly xray: ResolvedXray;
}

interface StatusJson {
  readonly masir: {
    readonly version: string;
  };
  readonly daemon: {
    readonly running: boolean;
    readonly pid?: number;
    readonly euid?: number;
    readonly privileged?: boolean;
    readonly startedAt?: number;
    readonly uptimeSeconds?: number;
  };
  readonly xray: {
    readonly running: boolean;
    readonly state?: "not-started" | "running" | "error" | "exit";
    readonly pid?: number;
    readonly mode?: "tun" | "proxy";
    readonly version?: string;
    readonly apiPort?: number;
    readonly assetsPath?: string;
    readonly logFile?: string;
    readonly lastError?: string;
    readonly startedAt?: number;
    readonly uptimeSeconds?: number;
  };
  readonly settings: {
    readonly routingMode: "proxy" | "direct";
    readonly mixedPort: number;
    readonly apiPort: number;
    readonly dnsServers: readonly string[];
  };
}

const formatRoutingMode = (settings: Settings): string => {
  const mode = settings.routingMode === "direct" ? pc.bold(pc.green("direct")) : pc.bold(pc.cyan("proxy"));
  return `${pc.bold("Routing Mode:")} ${mode} ${pc.dim("(default catch-all)")}`;
};

const formatXrayVersionHint = (settings: Settings): string | null => {
  const check = checkXrayVersion(settings.xrayExecutable);
  if (check.status === "missing") {
    return `${pc.bold("Xray Binary:")} ${pc.yellow("not found")} ${pc.dim(`(install with \`masir update xray-core\`)`)}`;
  }
  if (check.status === "outdated") {
    return `${pc.bold("Xray Binary:")} ${pc.yellow(`v${check.version} is older than v${MIN_XRAY_VERSION}`)} ${pc.dim(`(run \`masir update xray-core\`)`)}`;
  }
  return null;
};

const resolveDaemon = (status: StatusResult | null, now: number): ResolvedDaemon => {
  const daemon = status?.daemon;
  if (daemon) {
    return {
      euid: daemon.euid,
      pid: daemon.pid,
      privileged: daemon.privileged,
      running: true,
      startedAt: daemon.startedAt,
      uptimeMs: Math.max(0, now - daemon.startedAt),
    };
  }

  const fallback = checkHandlerInfo();
  if (fallback) {
    return {
      euid: fallback.helperEuid,
      pid: fallback.helperPid,
      privileged: fallback.helperEuid === 0,
      running: true,
    };
  }

  return {
    privileged: false,
    running: false,
  };
};

const resolveXray = (status: StatusResult | null, now: number): ResolvedXray => {
  const xray = status?.xray;
  if (!xray) {
    return {
      running: false,
      state: "not-started",
    };
  }

  const { startedAt } = xray;
  return {
    apiPort: xray.apiPort,
    assetsPath: xray.assetsPath,
    lastError: xray.lastError,
    logFile: xray.logFile,
    mode: xray.mode,
    pid: xray.pid,
    running: Boolean(xray.running),
    startedAt,
    state: xray.state || "not-started",
    uptimeMs: startedAt ? Math.max(0, now - startedAt) : undefined,
    version: xray.version,
  };
};

const queryHelperStatus = (): StatusResult | null => {
  try {
    const res = callHelper<ResponseOf<"status">>({ type: "status" });
    return res.ok ? res.result : null;
  } catch {
    return null;
  }
};

const resolveStatus = (now: number): ResolvedStatus => {
  const status = queryHelperStatus();
  return {
    daemon: resolveDaemon(status, now),
    xray: resolveXray(status, now),
  };
};

const formatDaemonTree = (version: string, daemon: ResolvedDaemon): string => {
  let title = pc.bold(`Masir Daemon v${version}`);
  title += daemon.running
    ? ` ${pc.green("●")} ${pc.green("Active")} ${pc.dim(`(PID: ${String(daemon.pid)}, ${daemon.privileged ? pc.yellow("privileged") : pc.dim(`unprivileged`)})`)}`
    : ` ${pc.red("○")} ${pc.red("Inactive")} ${pc.dim("(not running)")}`;

  if (!daemon.running) {
    return renderTree(title, [`${pc.bold("Hint:")} Connect with \`masir connect\``]);
  }

  const items: string[] = [];

  if (daemon.startedAt && daemon.uptimeMs !== undefined) {
    items.push(
      `${pc.bold("Uptime:")} ${pc.bold(formatDuration(daemon.uptimeMs))} ${pc.dim(`(since ${formatTimestamp(daemon.startedAt)})`)}`
    );
  }

  return renderTree(title, items);
};

const formatXrayRunning = (xray: ResolvedXray, settings: Settings): string => {
  const modeLabel =
    xray.mode === "tun" ? `${pc.bold(pc.green("TUN"))} ${pc.dim("(system-wide routing)")}` : `${pc.bold(pc.blue("Mixed Proxy"))}`;

  const items: string[] = [
    `${pc.bold("Mode:")} ${modeLabel}`,
    formatRoutingMode(settings),
    `${pc.bold("Proxy Port:")} ${pc.bold(String(settings.mixedPort))} ${pc.dim("(Socks5/HTTP)")}`,
    `${pc.bold("API Port:")} ${pc.bold(String(xray.apiPort ?? settings.apiPort))} ${pc.dim("(xray-core gRPC)")}`,
    `${pc.bold("DNS:")} ${pc.bold(settings.dnsServers.join(", "))}`,
  ];

  if (xray.startedAt && xray.uptimeMs !== undefined) {
    items.push(`${pc.bold("Uptime:")} ${pc.bold(formatDuration(xray.uptimeMs))} ${pc.dim(`(since ${formatTimestamp(xray.startedAt)})`)}`);
  }
  if (xray.assetsPath) {
    items.push(`${pc.bold("GEO Assets:")} ${pc.dim(xray.assetsPath)}`);
  }
  if (xray.logFile) {
    items.push(`${pc.bold("Log File:")} ${pc.dim(xray.logFile)} ${pc.dim("(tail with `masir logs`)")}`);
  }
  return renderTree(
    `${pc.bold(`Xray Core v${xray.version}`)} ${pc.green("●")} ${pc.green("Active")} ${pc.dim(`(PID: ${String(xray.pid)})`)}`,
    items
  );
};

const formatXrayInactive = (xray: ResolvedXray, settings: Settings, daemonRunning: boolean): string => {
  const title = pc.bold(`Xray Core`);
  const versionHint = formatXrayVersionHint(settings);
  if (xray.state === "error") {
    const items: string[] = [];
    if (xray.lastError) {
      items.push(`${pc.bold("Last Error:")} ${pc.red(xray.lastError)}`);
    }
    if (versionHint) {
      items.push(versionHint);
    }
    if (xray.logFile) {
      items.push(`${pc.bold("Log File:")} ${pc.dim(xray.logFile)} ${pc.dim("(tail with `masir logs`)")}`);
    }
    items.push(`${pc.bold("Hint:")} Fix the configuration or conflict, then connect with \`masir connect\``);
    return renderTree(`${title} ${pc.red("●")} ${pc.red("Error")} ${pc.dim("(process crashed or exited with error)")}`, items);
  }

  if (daemonRunning) {
    const items = [
      formatRoutingMode(settings),
      `${pc.bold("Ports:")} Mixed ${pc.bold(String(settings.mixedPort))}, API ${pc.bold(String(settings.apiPort))}`,
      `${pc.bold("DNS:")} ${pc.bold(settings.dnsServers.join(", "))}`,
    ];
    if (versionHint) {
      items.push(versionHint);
    }
    items.push(`${pc.bold("Hint:")} Connect with \`masir connect\` (or \`masir connect --tun\` for the whole system)`);
    return renderTree(`${title} ${pc.yellow("○")} ${pc.yellow("Inactive")} ${pc.dim("(stopped)")}`, items);
  }
  return renderTree(`${title} ${pc.dim(`○ Inactive (daemon inactive)`)}`, versionHint ? [versionHint] : []);
};

const formatXrayTree = (xray: ResolvedXray, settings: Settings, daemonRunning: boolean): string =>
  xray.running ? formatXrayRunning(xray, settings) : formatXrayInactive(xray, settings, daemonRunning);

const buildStatusJson = (version: string, daemon: ResolvedDaemon, xray: ResolvedXray, settings: Settings): StatusJson => ({
  daemon: daemon.running
    ? {
        euid: daemon.euid,
        pid: daemon.pid,
        privileged: daemon.privileged,
        running: true,
        startedAt: daemon.startedAt,
        uptimeSeconds: daemon.uptimeMs === undefined ? undefined : Math.floor(daemon.uptimeMs / 1000),
      }
    : { running: false },
  masir: {
    version,
  },
  settings: {
    apiPort: settings.apiPort,
    dnsServers: settings.dnsServers,
    mixedPort: settings.mixedPort,
    routingMode: settings.routingMode,
  },
  xray: xray.running
    ? {
        apiPort: xray.apiPort,
        assetsPath: xray.assetsPath,
        logFile: xray.logFile,
        mode: xray.mode,
        pid: xray.pid,
        running: true,
        startedAt: xray.startedAt,
        state: xray.state,
        uptimeSeconds: xray.uptimeMs === undefined ? undefined : Math.floor(xray.uptimeMs / 1000),
        version: xray.version,
      }
    : {
        lastError: xray.lastError,
        logFile: xray.logFile,
        running: false,
        state: xray.state,
      },
});

export const renderStatusTree = (now = Date.now()): string => {
  const settings = loadSettings();
  const { daemon, xray } = resolveStatus(now);
  return [formatDaemonTree(p.version, daemon), "", formatXrayTree(xray, settings, daemon.running)].join("\n");
};

export const statusCommand = defineCommand({
  args: {
    check: {
      default: true,
      description: "test internet and proxy connectivity (--no-check to skip)",
      type: "boolean",
    },
    json: {
      default: false,
      description: "output status as JSON",
      type: "boolean",
    },
  },
  meta: {
    description: "Show the daemon, xray and connectivity status",
    name: "status",
  },
  async run({ args }) {
    const settings = loadSettings();
    const now = Date.now();
    const { daemon, xray } = resolveStatus(now);
    const check = args.check !== false;

    if (args.json) {
      const connectivity = check ? await runConnectivityChecks(false) : undefined;
      console.log(JSON.stringify({ ...buildStatusJson(p.version, daemon, xray, settings), connectivity }, null, 2));
      return;
    }

    console.log(renderStatusTree(now));
    if (check) {
      console.log("");
      await runConnectivityChecks(true);
    }
  },
});
