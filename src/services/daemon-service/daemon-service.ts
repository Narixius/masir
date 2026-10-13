import { existsSync } from "node:fs";

import {
  installSystemdService,
  isSystemdServiceInstalled,
  SERVICE_BIN_PATH as LINUX_SERVICE_BIN,
  uninstallSystemdService,
} from "./linux.js";
import {
  installLaunchdService,
  isLaunchdServiceInstalled,
  SERVICE_BIN_PATH as MACOS_SERVICE_BIN,
  uninstallLaunchdService,
} from "./macos.js";

/**
 * The daemon as an OS service: runs `masir daemon run` as root at boot, so TUN
 * mode needs no password. Optional; without it `start --tun` asks for sudo.
 *
 * One file per OS next to this one; this file only dispatches. Windows is not
 * supported yet.
 */

export interface EnvVar {
  readonly name: string;
  readonly value: string;
}

export interface ServiceSpec {
  /** Absolute path of the root-owned copy of the masir binary the service runs. */
  readonly installedBinary: string;
  /** Environment the service runs with: HOME, MASIR_ALLOWED_UID, XRAY_EXECUTABLE... */
  readonly env: readonly EnvVar[];
}

/** Socket the root daemon listens on; removed on uninstall. Mirrors `SYSTEM_SOCKET` in native/masir-transport. */
export const SYSTEM_SOCKET = "/var/run/masir.sock";

export const isServiceSupported = (): boolean => process.platform === "darwin" || process.platform === "linux";

export const getDaemonServiceBinPath = (): string | null => {
  if (process.platform === "darwin") {
    return MACOS_SERVICE_BIN;
  }
  if (process.platform === "linux") {
    return LINUX_SERVICE_BIN;
  }
  return null;
};

export const isDaemonServiceInstalled = (): boolean => {
  if (process.platform === "darwin") {
    return isLaunchdServiceInstalled();
  }
  return process.platform === "linux" && isSystemdServiceInstalled();
};

/** Needs root. Copies `sourceBinary` into a root-owned place and registers the service. */
export const installDaemonService = (sourceBinary: string, env: readonly EnvVar[]): void => {
  if (!existsSync(sourceBinary)) {
    throw new Error(`binary not found: ${sourceBinary}`);
  }
  if (process.platform === "darwin") {
    installLaunchdService(sourceBinary, env);
  } else if (process.platform === "linux") {
    installSystemdService(sourceBinary, env);
  } else {
    throw new Error(`installing the daemon as a service is not supported on ${process.platform} yet`);
  }
};

/** Needs root. */
export const uninstallDaemonService = (): void => {
  if (process.platform === "darwin") {
    uninstallLaunchdService();
  } else if (process.platform === "linux") {
    uninstallSystemdService();
  } else {
    throw new Error(`uninstalling the daemon service is not supported on ${process.platform} yet`);
  }
};
