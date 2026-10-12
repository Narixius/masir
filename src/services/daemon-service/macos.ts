import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EnvVar } from "./daemon-service.js";

const LABEL = "com.masir.daemon";
const BIN_PATH = "/Library/PrivilegedHelperTools/masir";
const PLIST_PATH = "/Library/LaunchDaemons/com.masir.daemon.plist";
const SOCKET_PATH = "/var/run/masir.sock";
const LOG_PATH = "/var/log/masir-daemon.log";
const EXECUTABLE_MODE = 0o755;
const PLIST_MODE = 0o644;

const xmlEscape = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const renderLaunchdPlist = (env: readonly EnvVar[]): string => {
  const envEntries = env.map((entry) => `    <key>${xmlEscape(entry.name)}</key><string>${xmlEscape(entry.value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xmlEscape(BIN_PATH)}</string><string>daemon</string><string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${envEntries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>${LOG_PATH}</string>
</dict></plist>
`;
};

const launchctl = (args: readonly string[]) => spawnSync("launchctl", [...args], { stdio: "inherit" });

export const isLaunchdServiceInstalled = (): boolean => existsSync(PLIST_PATH);

export const installLaunchdService = (sourceBinary: string, env: readonly EnvVar[]): void => {
  mkdirSync(dirname(BIN_PATH), { recursive: true });
  // Remove first so a previous (possibly replaced) file is never written through.
  rmSync(BIN_PATH, { force: true });
  copyFileSync(sourceBinary, BIN_PATH);
  chmodSync(BIN_PATH, EXECUTABLE_MODE);

  writeFileSync(PLIST_PATH, renderLaunchdPlist(env));
  chmodSync(PLIST_PATH, PLIST_MODE);

  // Reinstall: drop any previous registration first; it is fine if there is none.
  launchctl(["bootout", `system/${LABEL}`]);
  const result = launchctl(["bootstrap", "system", PLIST_PATH]);
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed (exit ${result.status ?? "unknown"})`);
  }
};

export const uninstallLaunchdService = (): void => {
  launchctl(["bootout", `system/${LABEL}`]);
  for (const path of [PLIST_PATH, BIN_PATH, SOCKET_PATH]) {
    rmSync(path, { force: true });
  }
};
