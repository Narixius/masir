// oxlint-disable class-methods-use-this
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import type { XrayConfig } from "@gozargah/xray-schema";
import { createLogger } from "evlog";

import { loadSettings, resolveAssetsPath } from "../config/settings.js";
import { xrayCallRaw } from "../injectables/xray/client.js";
import type { XrayMode, XrayState } from "../protocol.js";
import { ensureDirExists, getAppDirs, writeFileEnsured } from "../utils/fs.js";
import { LogBuffer } from "../utils/log-buffer.js";
import { getFreePort } from "../utils/ports.js";
import { saveDaemonState } from "./daemon-state.js";
import { killProcessTree, makeLineReader, spawnGuardedXray, STOP_GRACE_MS, waitForExit, XRAY_PID_PREFIX } from "./xray-process.js";

const STARTUP_TIMEOUT_MS = 3000;
const STARTUP_POLL_MS = 100;

const readNewLogContent = (path: string, startPos: number): string => {
  if (!existsSync(path)) {
    return "";
  }
  try {
    // oxlint-disable-next-line eslint/prefer-destructuring
    const size = statSync(path).size;
    if (size <= startPos) {
      return "";
    }
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(size - startPos);
      const read = readSync(fd, buf, 0, buf.length, startPos);
      return buf.subarray(0, read).toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
};

const SYS_STATS_METHOD = "/xray.app.stats.command.StatsService/GetSysStats";

/** True once an xray gRPC API answers on `port`. */
const isApiResponding = (port: number): boolean => {
  try {
    xrayCallRaw(`127.0.0.1:${port}`, SYS_STATS_METHOD);
    return true;
  } catch {
    return false;
  }
};

const appDirs = getAppDirs();

export class Xray {
  private process: ChildProcess | null = null;
  private xrayPid: number | null = null;
  private version: string | null = null;
  /** Set once xray was started on a (possibly shifted) port; until then the configured one. */
  private apiPort: number | null = null;
  private logBuffer = new LogBuffer(50);
  private state: XrayState = "not-started";
  private startedAt: number | null = null;
  private mode: XrayMode = "proxy";
  private lastError: string | null = null;

  getApiPort = (): number => this.apiPort ?? loadSettings().apiPort;

  private getExecutablePath = () => loadSettings().xrayExecutable;
  getAssetsPath = () => resolveAssetsPath(loadSettings().xrayAssetsPath, this.getExecutablePath());

  getConfigPath = () => join(appDirs.data, "xray.config.json");
  getLogsPath = () => {
    const logsPath = join(appDirs.log, "xray.logs");
    // ensureDirExists creates the parent of the path it is given, so pass the file.
    ensureDirExists(logsPath);
    return {
      access: logsPath,
      error: logsPath,
    };
  };

  runWithConfig = async (config: XrayConfig): Promise<{ apiPort: number; pid: number }> => {
    const log = createLogger({ operation: "runWithConfig" });
    log.set({ currentState: this.state });
    if (this.process) {
      // The old xray must release its ports before the new one binds them.
      await this.stopXrayAndWait();
    }

    const settings = loadSettings();
    const apiPort = await getFreePort(settings.apiPort);
    if (apiPort !== settings.apiPort) {
      log.warn(`API port ${settings.apiPort} is busy; using ${apiPort}`);
    }
    this.apiPort = apiPort;
    log.set({ port: apiPort });

    const logsPath = this.getLogsPath();
    const fullConfig = {
      ...config,
      api: {
        listen: `127.0.0.1:${this.apiPort}`,
        services: ["HandlerService", "LoggerService", "ReflectionService", "RoutingService", "StatsService"],
        tag: "api",
      },
      log: {
        access: logsPath.access,
        dnsLog: true,
        error: logsPath.error,
        loglevel: "info",
      },
    };
    log.set({
      config: fullConfig,
    });
    const configPath = this.getConfigPath();
    await writeFileEnsured(configPath, JSON.stringify(fullConfig, null, 2));

    this.state = "not-started";
    this.lastError = null;
    this.xrayPid = null;
    this.version = null;

    const onData = makeLineReader((line) => {
      if (line.startsWith(XRAY_PID_PREFIX)) {
        const parsedPid = Number(line.slice(XRAY_PID_PREFIX.length).trim());
        if (parsedPid > 0) {
          this.xrayPid = parsedPid;
        }
        return;
      }
      this.logBuffer.push(line);
      if (line.includes("Failed to start:") || line.includes("failed to start proxy")) {
        this.lastError = line.trim();
      }
    });

    const startLogSize = existsSync(logsPath.error) ? statSync(logsPath.error).size : 0;

    return new Promise((resolve, reject) => {
      const assetsPath = this.getAssetsPath();
      const child = spawnGuardedXray(this.getExecutablePath(), configPath, assetsPath);

      this.process = child;
      let hasSettled = false;

      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      const checkStartupSuccess = (): boolean => {
        const hasLogStarted = this.logBuffer.toArray().some((l) => l.includes("core: Xray") && l.includes("started"));
        if (hasLogStarted) {
          return true;
        }
        if (existsSync(logsPath.error)) {
          const newLog = readNewLogContent(logsPath.error, startLogSize);
          if (newLog.includes("core: Xray") && newLog.includes("started")) {
            return true;
          }
        }
        // A busy port could belong to anything; only our xray answers its gRPC API.
        return isApiResponding(apiPort);
      };

      const settleSuccess = () => {
        hasSettled = true;
        this.state = "running";
        this.startedAt = Date.now();
        const hasTun = Boolean(config.inbounds?.some((ib) => ib?.protocol === "tun"));
        this.mode = hasTun ? "tun" : "proxy";
        saveDaemonState({ lastStartedAt: this.startedAt, mode: this.mode, running: true });
        const resolvedPid = this.xrayPid ?? this.process?.pid ?? 0;
        log.set({ pid: resolvedPid });
        log.emit();
        resolve({ apiPort, pid: resolvedPid });
      };

      const settleFailure = (err: Error) => {
        hasSettled = true;
        this.state = "error";
        if (this.process === child) {
          this.stopXray();
        }
        reject(err);
      };

      let checkTimer: NodeJS.Timeout | null = null;
      let timeoutTimer: NodeJS.Timeout | null = null;

      const clearAllTimers = () => {
        if (checkTimer) {
          clearInterval(checkTimer);
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
      };

      checkTimer = setInterval(() => {
        if (hasSettled) {
          clearAllTimers();
          return;
        }

        if (this.state === "error" || this.process !== child) {
          clearAllTimers();
          const msg = this.lastError ?? "xray process exited during startup";
          settleFailure(new Error(msg));
          return;
        }

        const isReady = checkStartupSuccess();
        if (isReady && !hasSettled) {
          clearAllTimers();
          settleSuccess();
        }
      }, STARTUP_POLL_MS);

      timeoutTimer = setTimeout(() => {
        clearAllTimers();
        if (!hasSettled) {
          const msg = this.lastError ?? "xray startup timed out after 3 seconds";
          settleFailure(new Error(msg));
        }
      }, STARTUP_TIMEOUT_MS);

      // Events of a replaced child (a reload already started a new one) must not touch current state.
      child.on("error", (error) => {
        if (this.process !== child) {
          return;
        }
        const errorMsg = String(error);
        this.logBuffer.push(`xray error: ${errorMsg}`);
        this.state = "error";
        this.process = null;
        this.xrayPid = null;
        this.lastError = errorMsg;
        if (!hasSettled) {
          clearAllTimers();
          settleFailure(error instanceof Error ? error : new Error(errorMsg));
        }
      });

      child.on("exit", (code, signal) => {
        if (this.process !== child) {
          return;
        }
        this.logBuffer.push(`xray exited: code=${code} signal=${signal}`);
        this.process = null;
        this.xrayPid = null;
        this.state = code !== 0 && signal !== "SIGTERM" ? "error" : "exit";

        if (!hasSettled) {
          clearAllTimers();
          const msg = this.lastError ?? `xray process exited immediately with code ${code}`;
          this.lastError = msg;
          settleFailure(new Error(msg));
        }
      });
    });
  };

  getXray = () => this.process;
  getXrayPid = () => this.xrayPid;
  isRunning = () => this.state === "running" && !!this.process;
  getState = () => this.state;
  getStartedAt = () => this.startedAt;
  getMode = () => this.mode;
  setMode = (mode: XrayMode) => {
    this.mode = mode;
    if (this.isRunning()) {
      saveDaemonState({ lastStartedAt: this.startedAt ?? Date.now(), mode: this.mode, running: true });
    }
  };
  getLastError = () => this.lastError;

  /** Stop xray and resolve once its processes are gone (SIGKILL after a grace period). */
  stopXrayAndWait = async (): Promise<void> => {
    const pids: number[] = [];
    for (const pid of [this.xrayPid, this.process?.pid]) {
      if (typeof pid === "number" && pid > 0) {
        pids.push(pid);
      }
    }
    this.stopXray();
    await waitForExit(pids, STOP_GRACE_MS);
  };

  stopXray = (options?: { readonly keepState?: boolean }) => {
    if (this.process) {
      killProcessTree(this.process, this.xrayPid);
      this.process = null;
    }
    this.xrayPid = null;
    this.state = "not-started";
    this.startedAt = null;
    if (!options?.keepState) {
      saveDaemonState({ mode: this.mode, running: false });
    }
  };

  getVersion = (): Promise<string | null> => {
    if (this.version) {
      return Promise.resolve(this.version);
    }
    return new Promise((resolve) => {
      let settled = false;
      let output = "";

      const done = (value: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        this.version = value;
        resolve(value);
      };

      const child = spawn(this.getExecutablePath(), ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      });

      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", () => done(null));
      child.on("close", () => {
        const match = output.match(/^Xray\s+(?<version>\S+)/mu);
        done(match && match[1] ? match[1] : null);
      });
    });
  };
}

export const xray = new Xray();
