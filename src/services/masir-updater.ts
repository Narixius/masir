import { spawnSync } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, rmSync, accessSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import pc from "picocolors";

import { loadSettings } from "../config/settings.js";
import type { ResponseOf } from "../protocol.js";
import { checkHandlerInfo, ensureHandlerIsReady } from "../utils/handler.js";
import { tryCallHelper } from "../utils/ipc.js";
import { log } from "../utils/log.js";
import { confirmPrompt } from "../utils/prompts.js";
import { createSpinner } from "../utils/spinner.js";
import { MASIR_VERSION } from "../version.js";
import { getDaemonServiceBinPath, isDaemonServiceInstalled } from "./daemon-service/daemon-service.js";
import { compareVersions } from "./xray-updater.js";

const RELEASES_API_URL = "https://api.github.com/repos/Narixius/masir/releases?per_page=10";
const SHUTDOWN_WAIT_TIMEOUT_MS = 3000;
const POLL_INTERVAL_MS = 100;

interface GithubReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
}

interface GithubRelease {
  readonly tag_name: string;
  readonly prerelease: boolean;
  readonly draft: boolean;
  readonly assets: readonly GithubReleaseAsset[];
}

export interface LatestMasirRelease {
  readonly version: string;
  readonly tag: string;
  readonly prerelease: boolean;
  readonly assetName: string;
  readonly downloadUrl: string;
}

export interface UpdateMasirOptions {
  readonly force?: boolean;
  readonly proxy?: boolean;
}

const stripLeadingV = (version: string): string => version.trim().replace(/^[vV]/u, "");

export const platformAssetName = (): string => {
  const isArm = process.arch === "arm64";
  if (process.platform === "darwin") {
    return isArm ? "masir-darwin-arm64.tar.gz" : "masir-darwin-x64.tar.gz";
  }
  if (process.platform === "linux") {
    return isArm ? "masir-linux-arm64-gnu.tar.gz" : "masir-linux-x64-gnu.tar.gz";
  }
  throw new Error(`Unsupported platform for automatic masir download: ${process.platform}/${process.arch}`);
};

/** Verify tar and gzip are installed and operational before attempting download. */
export const ensureTarCapability = (): void => {
  const tarRes = spawnSync("tar", ["--version"], { stdio: "ignore" });
  if (tarRes.status !== 0) {
    throw new Error("Missing or unusable `tar` executable. Please install tar to extract updates.");
  }
  const gzipRes = spawnSync("gzip", ["-V"], { stdio: "ignore" });
  if (gzipRes.status !== 0) {
    throw new Error("Missing or unusable `gzip` executable. Please install gzip to extract updates.");
  }
};

const curlProxyArgs = (proxyUrl?: string): string[] => (proxyUrl ? ["-x", proxyUrl] : []);

export const fetchLatestMasirRelease = (proxyUrl?: string): LatestMasirRelease => {
  const args = [
    "-fsSL",
    ...curlProxyArgs(proxyUrl),
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    "User-Agent: masir-cli",
    RELEASES_API_URL,
  ];
  const res = spawnSync("curl", args, { encoding: "utf-8", timeout: 20_000 });
  if (res.error || res.status !== 0) {
    throw new Error(`Failed to fetch masir releases from GitHub: ${res.stderr?.trim() || res.error?.message || "curl failed"}`);
  }
  const releases = JSON.parse(res.stdout) as GithubRelease[];
  const latest = releases.find((rel) => !rel.draft && Boolean(rel.tag_name));
  if (!latest) {
    throw new Error("No masir releases found on GitHub.");
  }
  const assetName = platformAssetName();
  const asset = latest.assets.find((item) => item.name === assetName);
  const downloadUrl = asset?.browser_download_url ?? `https://github.com/Narixius/masir/releases/download/${latest.tag_name}/${assetName}`;
  return {
    assetName,
    downloadUrl,
    prerelease: latest.prerelease,
    tag: latest.tag_name,
    version: stripLeadingV(latest.tag_name),
  };
};

const resolveProxyUrl = async (explicitProxy: boolean | undefined, xrayRunning: boolean): Promise<string | undefined> => {
  const { mixedPort } = loadSettings();
  const proxyUrl = `http://127.0.0.1:${mixedPort}`;
  if (explicitProxy === true) {
    return proxyUrl;
  }
  if (explicitProxy === false || !xrayRunning || !process.stdin.isTTY) {
    return undefined;
  }
  const useProxy = await confirmPrompt({
    default: true,
    message: `Do you want to download through the active proxy (127.0.0.1:${mixedPort})?`,
  });
  return useProxy ? proxyUrl : undefined;
};

const downloadAndExtractMasir = (downloadUrl: string, tmpDir: string, proxyUrl?: string): string => {
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, "masir-download.tar.gz");
  try {
    const dl = spawnSync("curl", ["-fL", "--progress-bar", ...curlProxyArgs(proxyUrl), "-o", archivePath, downloadUrl], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (dl.error || dl.status !== 0) {
      throw new Error(`curl download failed (exit code ${String(dl.status ?? "unknown")})`);
    }
    const extract = spawnSync("tar", ["-xzf", archivePath, "-C", tmpDir], { encoding: "utf-8" });
    if (extract.error || extract.status !== 0) {
      throw new Error(`Failed to extract archive: ${extract.stderr?.trim() || extract.error?.message || "tar failed"}`);
    }
    const extractedExe = join(tmpDir, "masir");
    if (!existsSync(extractedExe)) {
      throw new Error(`Archive extracted but masir executable not found at ${extractedExe}`);
    }
    chmodSync(extractedExe, 0o755);
    return extractedExe;
  } finally {
    try {
      rmSync(archivePath, { force: true });
    } catch {
      // ignore
    }
  }
};

const canWritePath = (filePath: string): boolean => {
  try {
    if (existsSync(filePath)) {
      accessSync(filePath, constants.W_OK);
      return true;
    }
    accessSync(join(filePath, ".."), constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const copyOrSudoCopy = (src: string, dest: string): void => {
  if (canWritePath(dest)) {
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    return;
  }
  const res = spawnSync("sudo", ["cp", src, dest], { stdio: "inherit" });
  if (res.status !== 0) {
    throw new Error(`Failed to copy new binary to ${dest} with sudo.`);
  }
  spawnSync("sudo", ["chmod", "755", dest], { stdio: "ignore" });
};

const waitForDaemonShutdown = async (oldPid: number): Promise<void> => {
  const deadline = Date.now() + SHUTDOWN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(POLL_INTERVAL_MS);
    const next = checkHandlerInfo();
    if (next === null || next.helperPid !== oldPid) {
      return;
    }
  }
};

const restartDaemonAfterUpdate = async (wasTun: boolean): Promise<void> => {
  const spinner = createSpinner();
  spinner.start("Restarting daemon with updated binary...");
  const info = checkHandlerInfo();
  if (info) {
    tryCallHelper<ResponseOf<"shutdown">>({ type: "shutdown" });
    await waitForDaemonShutdown(info.helperPid);
  }
  const isPrivileged = wasTun || info?.helperEuid === 0;
  const ready = await ensureHandlerIsReady({ privileged: isPrivileged, spinner });
  if (!ready) {
    spinner.error(pc.red("Daemon restart failed after update."));
    return;
  }
  const newInfo = checkHandlerInfo();
  spinner.stop(pc.green(`Daemon restarted successfully with updated binary (PID: ${newInfo?.helperPid ?? "unknown"}).`));
};

const installUpdatedBinaries = (newExePath: string, primaryTarget: string): void => {
  log.step(`Installing new binary to ${pc.cyan(primaryTarget)}...`);
  copyOrSudoCopy(newExePath, primaryTarget);

  if (!isDaemonServiceInstalled()) {
    return;
  }
  const serviceBin = getDaemonServiceBinPath();
  if (serviceBin && serviceBin !== primaryTarget && existsSync(serviceBin)) {
    log.step(`Updating system service binary at ${pc.cyan(serviceBin)}...`);
    try {
      copyOrSudoCopy(newExePath, serviceBin);
    } catch (error) {
      log.warn(pc.yellow(`Failed to update system service binary: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
};

const verifyExtractedBinary = (exePath: string): boolean => {
  const testRes = spawnSync(exePath, ["--version"], { encoding: "utf-8" });
  if (testRes.status !== 0) {
    log.error(pc.red(`Extracted masir binary verification failed: ${testRes.stderr?.trim() || "exit code nonzero"}`));
    return false;
  }
  return true;
};

export const updateMasir = async (options?: UpdateMasirOptions): Promise<boolean> => {
  ensureTarCapability();

  const prevStatus = tryCallHelper<ResponseOf<"status">>({ type: "status" });
  const isXrayRunning = Boolean(prevStatus?.ok && prevStatus.result.xray.running);
  const wasTun = Boolean(prevStatus?.ok && prevStatus.result.xray.mode === "tun");

  const proxyUrl = await resolveProxyUrl(options?.proxy, isXrayRunning);

  log.step(`Checking latest masir release on GitHub${proxyUrl ? pc.dim(` (via ${proxyUrl})`) : ""}...`);
  let release: LatestMasirRelease;
  try {
    release = fetchLatestMasirRelease(proxyUrl);
  } catch (error) {
    log.error(pc.red(error instanceof Error ? error.message : String(error)));
    return false;
  }

  const currentVersion = MASIR_VERSION;
  if (!options?.force && compareVersions(currentVersion, release.version) >= 0) {
    log.success(`${pc.green("masir is already up to date")} ${pc.dim(`(v${currentVersion} • ${process.execPath})`)}`);
    return true;
  }

  const fromLabel = currentVersion ? `v${currentVersion} → ` : "";
  log.info(`Downloading masir ${pc.bold(`${fromLabel}${release.tag}`)} (${release.assetName})...`);

  const tmpDir = join(loadSettings().xrayAssetsPath || "/tmp", `masir-update-${Date.now()}`);
  let newExePath: string;
  try {
    newExePath = downloadAndExtractMasir(release.downloadUrl, tmpDir, proxyUrl);
  } catch (error) {
    log.error(pc.red(error instanceof Error ? error.message : String(error)));
    return false;
  }

  if (!verifyExtractedBinary(newExePath)) {
    rmSync(tmpDir, { force: true, recursive: true });
    return false;
  }

  try {
    installUpdatedBinaries(newExePath, process.execPath);
  } catch (error) {
    log.error(pc.red(error instanceof Error ? error.message : String(error)));
    rmSync(tmpDir, { force: true, recursive: true });
    return false;
  }

  rmSync(tmpDir, { force: true, recursive: true });
  log.success(`${pc.green("✔")} masir updated to ${pc.bold(`v${release.version}`)}`);

  if (checkHandlerInfo()) {
    await restartDaemonAfterUpdate(wasTun);
  }

  return true;
};
