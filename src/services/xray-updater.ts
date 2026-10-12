import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import pc from "picocolors";

import { loadSettings, masirXrayDir, writeSetting } from "../config/settings.js";
import type { ResponseOf } from "../protocol.js";
import { tryCallHelper } from "../utils/ipc.js";
import { log } from "../utils/log.js";
import { confirmPrompt } from "../utils/prompts.js";
import { isDaemonServiceInstalled } from "./daemon-service/daemon-service.js";

export const MIN_XRAY_VERSION = "26.7.28";

const RELEASES_API_URL = "https://api.github.com/repos/XTLS/Xray-core/releases?per_page=10";
const VERSION_REGEX = /^Xray\s+(?<version>\S+)/mu;

export interface XrayVersionCheck {
  readonly executable: string;
  readonly version: string | null;
  readonly status: "ok" | "missing" | "outdated";
}

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

export interface LatestXrayRelease {
  readonly version: string;
  readonly tag: string;
  readonly prerelease: boolean;
  readonly assetName: string;
  readonly downloadUrl: string;
}

export interface UpdateXrayOptions {
  readonly force?: boolean;
  readonly proxy?: boolean;
}

const stripLeadingV = (version: string): string => version.trim().replace(/^[vV]/u, "");

/** Compare two dotted version strings (`26.7.28` vs `26.10.10`). Returns <0, 0, or >0. */
export const compareVersions = (a: string, b: string): number => {
  const partsA = stripLeadingV(a)
    .split(".")
    .map((part) => Math.trunc(Number(part)) || 0);
  const partsB = stripLeadingV(b)
    .split(".")
    .map((part) => Math.trunc(Number(part)) || 0);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i += 1) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA !== segB) {
      return segA < segB ? -1 : 1;
    }
  }
  return 0;
};

/** Inspect the version of an installed xray binary (`26.10.10`), or `null` if not runnable. */
export const getInstalledXrayVersion = (executablePath?: string): string | null => {
  const exe = executablePath ?? loadSettings().xrayExecutable;
  try {
    const res = spawnSync(exe, ["version"], { encoding: "utf-8", timeout: 5000 });
    if (res.error || res.status !== 0) {
      return null;
    }
    const match = VERSION_REGEX.exec(res.stdout ?? "");
    return match?.[1] ? stripLeadingV(match[1]) : null;
  } catch {
    return null;
  }
};

/** Check whether the configured xray exists and meets `MIN_XRAY_VERSION`. */
export const checkXrayVersion = (executablePath?: string): XrayVersionCheck => {
  const executable = executablePath ?? loadSettings().xrayExecutable;
  const version = getInstalledXrayVersion(executable);
  if (!version) {
    return { executable, status: "missing", version: null };
  }
  if (compareVersions(version, MIN_XRAY_VERSION) < 0) {
    return { executable, status: "outdated", version };
  }
  return { executable, status: "ok", version };
};

/** Official XTLS/Xray-core archive filename for this OS and CPU architecture. */
const platformAssetName = (): string => {
  const isArm = process.arch === "arm64";
  if (process.platform === "darwin") {
    return isArm ? "Xray-macos-arm64-v8a.zip" : "Xray-macos-64.zip";
  }
  if (process.platform === "linux") {
    return isArm ? "Xray-linux-arm64-v8a.zip" : "Xray-linux-64.zip";
  }
  throw new Error(`Unsupported platform for automatic Xray download: ${process.platform}/${process.arch}`);
};

const curlProxyArgs = (proxyUrl?: string): string[] => (proxyUrl ? ["-x", proxyUrl] : []);

/** Fetch the newest release (including pre-releases) from XTLS/Xray-core on GitHub. */
export const fetchLatestXrayRelease = (proxyUrl?: string): LatestXrayRelease => {
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
    throw new Error(`Failed to fetch Xray releases from GitHub: ${res.stderr?.trim() || res.error?.message || "curl failed"}`);
  }
  const releases = JSON.parse(res.stdout) as GithubRelease[];
  const latest = releases.find((rel) => !rel.draft && Boolean(rel.tag_name));
  if (!latest) {
    throw new Error("No Xray-core releases found on GitHub.");
  }
  const assetName = platformAssetName();
  const asset = latest.assets.find((item) => item.name === assetName);
  const downloadUrl = asset?.browser_download_url ?? `https://github.com/XTLS/Xray-core/releases/download/${latest.tag_name}/${assetName}`;
  return {
    assetName,
    downloadUrl,
    prerelease: latest.prerelease,
    tag: latest.tag_name,
    version: stripLeadingV(latest.tag_name),
  };
};

const downloadAndExtractXray = (downloadUrl: string, targetDir: string, proxyUrl?: string): string => {
  mkdirSync(targetDir, { recursive: true });
  const zipPath = join(targetDir, "xray-download.zip");
  try {
    const dl = spawnSync("curl", ["-fL", "--progress-bar", ...curlProxyArgs(proxyUrl), "-o", zipPath, downloadUrl], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (dl.error || dl.status !== 0) {
      throw new Error(`curl download failed (exit code ${String(dl.status ?? "unknown")})`);
    }
    const unzip = spawnSync("unzip", ["-o", "-q", zipPath, "-d", targetDir], { encoding: "utf-8" });
    if (unzip.error || unzip.status !== 0) {
      throw new Error(`Failed to extract archive: ${unzip.stderr?.trim() || unzip.error?.message || "unzip failed"}`);
    }
    const exePath = join(targetDir, "xray");
    if (!existsSync(exePath)) {
      throw new Error(`Archive extracted, but ${exePath} was not found.`);
    }
    chmodSync(exePath, 0o755);
    return exePath;
  } finally {
    rmSync(zipPath, { force: true });
  }
};

interface RunningXrayState {
  readonly running: boolean;
  readonly tun: boolean;
}

const getRunningXrayState = (): RunningXrayState => {
  const status = tryCallHelper<ResponseOf<"status">>({ type: "status" });
  if (!status?.ok || !status.result.xray.running) {
    return { running: false, tun: false };
  }
  return {
    running: true,
    tun: status.result.xray.mode === "tun",
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

const applyPostUpdateReload = (version: string, exePath: string, targetDir: string, before: RunningXrayState): void => {
  const serviceInstalled = isDaemonServiceInstalled();
  let reloadSuffix = "";
  if (serviceInstalled) {
    const reload = tryCallHelper<ResponseOf<"reload">>({ type: "reload" });
    if (reload?.ok) {
      reloadSuffix = " • daemon reloaded";
    }
  }

  log.success(
    [
      `${pc.green("✔")} Xray-core ${pc.bold(`v${version}`)} installed${pc.dim(reloadSuffix)}`,
      `  ${pc.dim("├─")} ${pc.gray("executable:")} ${exePath}`,
      `  ${pc.dim("└─")} ${pc.gray("assets:")}     ${targetDir}`,
    ].join("\n")
  );

  if (!serviceInstalled && before.running) {
    const startCmd = before.tun ? "masir start -t" : "masir start";
    log.info(`Restart Xray to apply the new version: ${pc.bold(`\`masir stop && ${startCmd}\``)}`);
  }
};

/** Download the latest Xray-core release (including pre-releases), save paths in settings, and reload daemon if installed. */
export const updateXrayCore = async (options?: UpdateXrayOptions): Promise<boolean> => {
  const current = checkXrayVersion();
  const before = getRunningXrayState();
  const proxyUrl = await resolveProxyUrl(options?.proxy, before.running);

  log.step(`Checking latest Xray-core release on GitHub${proxyUrl ? pc.dim(` (via ${proxyUrl})`) : ""}...`);
  let release: LatestXrayRelease;
  try {
    release = fetchLatestXrayRelease(proxyUrl);
  } catch (error) {
    log.error(pc.red(error instanceof Error ? error.message : String(error)));
    return false;
  }

  const tagLabel = `${release.tag}${release.prerelease ? " (pre-release)" : ""}`;
  if (!options?.force && current.version && compareVersions(current.version, release.version) >= 0) {
    log.success(`${pc.green("Xray-core is already up to date")} ${pc.dim(`(v${current.version} • ${current.executable})`)}`);
    return true;
  }

  const fromLabel = current.version ? `v${current.version} → ` : "";
  log.info(`Downloading Xray-core ${pc.bold(`${fromLabel}${tagLabel}`)} (${release.assetName})...`);

  const targetDir = masirXrayDir();
  try {
    const exePath = downloadAndExtractXray(release.downloadUrl, targetDir, proxyUrl);
    writeSetting("xrayExecutable", exePath);
    writeSetting("xrayAssetsPath", targetDir);
    applyPostUpdateReload(release.version, exePath, targetDir, before);
    return true;
  } catch (error) {
    log.error(pc.red(error instanceof Error ? error.message : String(error)));
    return false;
  }
};

/**
 * Verify Xray is installed and >= `MIN_XRAY_VERSION`. When missing or older,
 * suggest downloading the latest pre-release and run the installer if confirmed.
 */
export const ensureMinimumXray = async (): Promise<boolean> => {
  const check = checkXrayVersion();
  if (check.status === "ok") {
    return true;
  }

  if (check.status === "missing") {
    log.warn(pc.yellow(`Xray executable was not found (${check.executable}). Minimum required version is v${MIN_XRAY_VERSION}.`));
  } else {
    log.warn(pc.yellow(`Installed Xray (v${check.version}) is older than the minimum required version (v${MIN_XRAY_VERSION}).`));
  }

  if (!process.stdin.isTTY) {
    log.info(pc.dim("Run `masir update xray-core` to download the latest Xray-core release."));
    return false;
  }

  const shouldDownload = await confirmPrompt({
    default: true,
    message: `Download the latest Xray-core pre-release to ${masirXrayDir()} now?`,
  });
  if (!shouldDownload) {
    log.info(pc.dim("Skipped. You can update anytime with `masir update xray-core`."));
    return false;
  }

  return await updateXrayCore({ force: true });
};
