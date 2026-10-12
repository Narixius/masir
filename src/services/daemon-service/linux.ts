import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EnvVar } from "./daemon-service.js";

const UNIT_NAME = "masir.service";
const BIN_PATH = "/usr/local/lib/masir/masir";
const UNIT_PATH = "/etc/systemd/system/masir.service";
const SOCKET_PATH = "/var/run/masir.sock";
const EXECUTABLE_MODE = 0o755;

const quote = (text: string): string => {
  if (text.includes("\n") || text.includes('"')) {
    throw new Error(`unsupported character in service environment value: ${text}`);
  }
  return `"${text}"`;
};

export const renderSystemdUnit = (env: readonly EnvVar[]): string => {
  const envLines = env.map((entry) => `Environment=${quote(`${entry.name}=${entry.value}`)}`).join("\n");
  return `[Unit]
Description=masir daemon (runs as root so TUN mode needs no password)
After=network.target

[Service]
ExecStart=${BIN_PATH} daemon run
${envLines}
Restart=always
KillMode=control-group

[Install]
WantedBy=multi-user.target
`;
};

const systemctl = (args: readonly string[]) => {
  const result = spawnSync("systemctl", [...args], { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`systemctl ${args.join(" ")} failed (exit ${result.status ?? "unknown"})`);
  }
};

export const isSystemdServiceInstalled = (): boolean => existsSync(UNIT_PATH);

export const installSystemdService = (sourceBinary: string, env: readonly EnvVar[]): void => {
  mkdirSync(dirname(BIN_PATH), { recursive: true });
  rmSync(BIN_PATH, { force: true });
  copyFileSync(sourceBinary, BIN_PATH);
  chmodSync(BIN_PATH, EXECUTABLE_MODE);

  writeFileSync(UNIT_PATH, renderSystemdUnit(env));
  systemctl(["daemon-reload"]);
  systemctl(["enable", "--now", UNIT_NAME]);
  // `enable --now` does not restart a unit that is already running with old settings.
  systemctl(["restart", UNIT_NAME]);
};

export const uninstallSystemdService = (): void => {
  try {
    systemctl(["disable", "--now", UNIT_NAME]);
  } catch {
    // Not installed or already stopped: keep going and remove the files.
  }
  for (const path of [UNIT_PATH, BIN_PATH, SOCKET_PATH]) {
    rmSync(path, { force: true });
  }
  try {
    systemctl(["daemon-reload"]);
  } catch {
    // Nothing more to do.
  }
};
