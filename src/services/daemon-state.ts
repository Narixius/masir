import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { XrayMode } from "../protocol.js";
import { getAppDirs, withFileLock, writeFileEnsured } from "../utils/fs.js";

export interface DaemonState {
  readonly running: boolean;
  readonly mode?: XrayMode;
  readonly lastStartedAt?: number;
}

const getStateFilePath = (): string => join(getAppDirs().data, "state.json");
const getStateLockPath = (): string => join(getAppDirs().data, "state.lock");

const DEFAULT_STATE: DaemonState = {
  running: false,
};

export const loadDaemonState = (): DaemonState => {
  const filePath = getStateFilePath();
  if (!existsSync(filePath)) {
    return DEFAULT_STATE;
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const state = parsed as Record<string, unknown>;
      const running = Boolean(state["running"]);
      const mode = state["mode"] === "tun" || state["mode"] === "proxy" ? (state["mode"] as XrayMode) : undefined;
      const lastStartedAt = typeof state["lastStartedAt"] === "number" ? state["lastStartedAt"] : undefined;
      return { lastStartedAt, mode, running };
    }
  } catch {
    // Return default on parse failure
  }
  return DEFAULT_STATE;
};

export const saveDaemonState = (state: DaemonState): void => {
  withFileLock(getStateLockPath(), () => {
    writeFileEnsured(getStateFilePath(), JSON.stringify(state, null, 2));
  });
};
