// Apps for process rules (`masir rules add --app`). xray's `process` matcher
// takes an exact name, an executable path, or a folder ending in "/" that
// matches every executable inside it. So a macOS app is its `.app` bundle as a
// folder entry, which covers all of its helper processes, running or not.
// Programs an app starts from outside its bundle (updaters, language servers)
// are found by walking the live process tree.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { nativeSystem } from "../../native.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly ppid?: number;
  readonly name: string;
  readonly exe?: string;
}

export interface AppEntry {
  readonly name: string;
  /** The `.app` bundle on macOS, else the executable. */
  readonly path: string;
  /** A macOS bundle: its rule entry is the folder (`path/`), covering every helper inside. */
  readonly bundle: boolean;
  readonly running: boolean;
  /**
   * Other locations of the same app. macOS runs some system apps from a hidden
   * copy (Safari from /System/Volumes/Preboot/Cryptexes/...), and xray sees
   * the path the process really runs from.
   */
  readonly aliases: readonly string[];
}

export interface RelatedPath {
  /** A `process` rule value: an executable, or a folder ending in "/". */
  readonly path: string;
  readonly reason: string;
}

const INITIAL_BUFFER_BYTES = 1024 * 1024;
const BUFFER_GROWTH = 4;
const MAX_ATTEMPTS = 3;
const BUFFER_TOO_SMALL = -3;
const BUNDLE_SUFFIX = ".app";

const home = (): string => process.env["HOME"] ?? "";

/** Every running process, from the native `sysinfo` list. */
export const listProcesses = (): ProcessInfo[] => {
  let size = INITIAL_BUFFER_BYTES;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const out = Buffer.alloc(size);
    const written = nativeSystem.listProcesses(out);
    if (written > 0) {
      return JSON.parse(out.subarray(0, written).toString("utf-8")) as ProcessInfo[];
    }
    if (written !== BUFFER_TOO_SMALL) {
      break;
    }
    size *= BUFFER_GROWTH;
  }
  return [];
};

/** The outermost `.app` bundle an executable lives in (helpers sit in nested bundles inside it). */
export const bundleOf = (exe: string): string | undefined => {
  const at = exe.indexOf(`${BUNDLE_SUFFIX}/`);
  return at === -1 ? undefined : exe.slice(0, at + BUNDLE_SUFFIX.length);
};

/** The `process` rule values for an app: its bundle(s) as folders, or its executable. */
export const ruleValuesFor = (app: AppEntry): string[] => [app.path, ...app.aliases].map((path) => (app.bundle ? `${path}/` : path));

const listDir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** `.app` bundles in the usual folders, one level of subfolders deep (e.g. /Applications/Utilities). */
const installedBundles = (): string[] => {
  const roots = ["/Applications", "/System/Applications", join(home(), "Applications")];
  const bundles: string[] = [];
  for (const root of roots) {
    for (const entry of listDir(root)) {
      const path = join(root, entry);
      if (entry.endsWith(BUNDLE_SUFFIX)) {
        bundles.push(path);
      } else if (isDirectory(path)) {
        for (const nested of listDir(path)) {
          if (nested.endsWith(BUNDLE_SUFFIX)) {
            bundles.push(join(path, nested));
          }
        }
      }
    }
  }
  return bundles;
};

const appName = (path: string): string => basename(path).replace(/\.app$/u, "");

/** Executables that are part of the OS or a toolchain: never worth a rule of their own. */
const SHARED_PREFIXES = [
  "/usr/",
  "/bin/",
  "/sbin/",
  "/System/",
  "/Library/Apple/",
  "/opt/homebrew/",
  "/nix/",
  "/snap/",
  "/lib/",
  "/lib64/",
];
const SHARED_HOME_DIRS = [".cargo", ".rustup", ".nvm", ".bun", ".pyenv", ".volta", ".deno", ".local/share/mise", ".asdf"];

/** General-purpose runtimes and shells: a rule on one would catch every program using it. */
const SHARED_NAMES: ReadonlySet<string> = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "java",
  "perl",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "git",
]);
const VERSIONED_RUNTIME = /^python\d|^node\d/u;

const isSharedExecutable = (exe: string): boolean =>
  SHARED_NAMES.has(basename(exe)) ||
  VERSIONED_RUNTIME.test(basename(exe)) ||
  SHARED_PREFIXES.some((prefix) => exe.startsWith(prefix)) ||
  SHARED_HOME_DIRS.some((dir) => exe.startsWith(`${join(home(), dir)}/`)) ||
  exe.includes("/node_modules/");

/** This program and xray itself never get rules (masir already routes xray direct). */
const isOwnProcess = (exe: string): boolean => exe === process.execPath || basename(exe) === "xray";

/**
 * Apps to pick from: on macOS, installed bundles plus bundles of running
 * processes; elsewhere, running programs (there are no bundles).
 */
export const listApps = (processes: readonly ProcessInfo[]): AppEntry[] => {
  const running = new Set<string>();
  const apps = new Map<string, AppEntry>();
  if (process.platform === "darwin") {
    for (const proc of processes) {
      const bundle = proc.exe ? bundleOf(proc.exe) : undefined;
      if (bundle && !bundle.startsWith("/System/Library/")) {
        running.add(bundle);
      }
    }
    // One entry per app name: a running copy elsewhere (e.g. a cryptex) joins the installed one.
    for (const path of [...installedBundles(), ...running]) {
      const name = appName(path);
      const existing = apps.get(name);
      if (!existing) {
        apps.set(name, { aliases: [], bundle: true, name, path, running: running.has(path) });
      } else if (existing.path !== path && !existing.aliases.includes(path)) {
        apps.set(name, { ...existing, aliases: [...existing.aliases, path], running: existing.running || running.has(path) });
      }
    }
  } else {
    for (const proc of processes) {
      const { exe } = proc;
      if (exe && !isSharedExecutable(exe) && !isOwnProcess(exe)) {
        apps.set(exe, { aliases: [], bundle: false, name: basename(exe), path: exe, running: true });
      }
    }
  }
  return [...apps.values()].toSorted((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
};

/** `name` (case-insensitive) or a path; an exact name wins over a unique partial match. */
export const findApp = (apps: readonly AppEntry[], query: string): AppEntry | AppEntry[] | undefined => {
  const path = query.replace(/\/+$/u, "");
  const byPath = apps.find((app) => app.path === path || app.aliases.includes(path));
  if (byPath) {
    return byPath;
  }
  if (path.startsWith("/") && existsSync(path)) {
    const bundle = path.endsWith(BUNDLE_SUFFIX);
    return { aliases: [], bundle, name: bundle ? appName(path) : basename(path), path, running: false };
  }
  const needle = query.toLowerCase();
  const exact = apps.filter((app) => app.name.toLowerCase() === needle);
  if (exact.length === 1) {
    return exact[0];
  }
  const partial = apps.filter((app) => app.name.toLowerCase().includes(needle));
  if (partial.length === 0) {
    return undefined;
  }
  return partial.length === 1 ? partial[0] : partial;
};

// Unnamed group on purpose: scriptc has no lowering for `RegExpExecArray.groups`.
// oxlint-disable-next-line eslint/prefer-named-capture-group
const BUNDLE_ID_XML = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/u;

/** The bundle's identifier from Info.plist (XML directly; binary plists through plutil). */
const bundleIdentifier = (bundle: string): string | undefined => {
  const plist = join(bundle, "Contents", "Info.plist");
  let text = "";
  try {
    text = readFileSync(plist, "utf-8");
  } catch {
    return undefined;
  }
  if (text.startsWith("bplist")) {
    const result = spawnSync("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plist], { encoding: "utf-8" });
    const id = (result.stdout ?? "").trim();
    return result.status === 0 && id.length > 0 ? id : undefined;
  }
  return BUNDLE_ID_XML.exec(text)?.[1]?.trim();
};

/**
 * Folders where macOS apps keep data, updaters and downloaded helpers, when
 * they exist (as masir-v1 did). Electron apps update through `<id>.ShipIt`; a
 * folder that never runs anything costs nothing as a rule entry.
 */
const dataFolders = (app: AppEntry): RelatedPath[] => {
  const library = join(home(), "Library");
  const id = bundleIdentifier(app.path);
  const candidates: RelatedPath[] = [{ path: join(library, "Application Support", app.name), reason: "app data" }];
  if (id) {
    candidates.push(
      { path: join(library, "Application Support", id), reason: "app data" },
      { path: join(library, "Caches", id), reason: "cache" },
      { path: join(library, "Caches", `${id}.ShipIt`), reason: "updater" },
      { path: join(library, "Containers", id), reason: "sandbox data" }
    );
  }
  const found: RelatedPath[] = [];
  for (const candidate of candidates) {
    const value = `${candidate.path}/`;
    if (isDirectory(candidate.path) && !found.some((item) => item.path === value)) {
      found.push({ path: value, reason: candidate.reason });
    }
  }
  return found;
};

/** `~/Library/Application Support/<X>/...` collapses to `.../<X>/`: apps keep updaters and servers there. */
const supportFolderOf = (exe: string): string | undefined => {
  const support = `${join(home(), "Library", "Application Support")}/`;
  if (!exe.startsWith(support)) {
    return undefined;
  }
  const [vendor] = exe.slice(support.length).split("/");
  return vendor ? `${support}${vendor}/` : undefined;
};

/** Every process started (directly or not) by one of `roots`. */
const descendantsOf = (processes: readonly ProcessInfo[], roots: readonly number[]): ProcessInfo[] => {
  const children = new Map<number, ProcessInfo[]>();
  for (const proc of processes) {
    if (proc.ppid !== undefined) {
      const list = children.get(proc.ppid);
      if (list) {
        list.push(proc);
      } else {
        children.set(proc.ppid, [proc]);
      }
    }
  }
  const found: ProcessInfo[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        found.push(child);
        queue.push(child.pid);
      }
    }
  }
  return found;
};

const isInside = (path: string, app: AppEntry): boolean =>
  [app.path, ...app.aliases].some((location) => (app.bundle ? path.startsWith(`${location}/`) : path === location));

/**
 * Programs and folders that belong to `app` but sit outside its bundle:
 * executables its processes started (live), and its Application Support
 * folder when it holds programs. Shared system/toolchain binaries are left out:
 * a rule on /usr/bin/git would catch every git on the machine.
 */
export const findRelated = (app: AppEntry, processes: readonly ProcessInfo[]): RelatedPath[] => {
  const related = new Map<string, string>();
  const roots = processes.filter((proc) => proc.exe !== undefined && isInside(proc.exe, app)).map((proc) => proc.pid);
  for (const proc of descendantsOf(processes, roots)) {
    const { exe } = proc;
    if (!exe || isInside(exe, app) || isSharedExecutable(exe) || isOwnProcess(exe)) {
      continue;
    }
    const folder = supportFolderOf(exe);
    related.set(folder ?? exe, folder ? `runs ${proc.name} from here` : `started by ${app.name}`);
  }
  if (app.bundle) {
    for (const folder of dataFolders(app)) {
      if (!related.has(folder.path)) {
        related.set(folder.path, folder.reason);
      }
    }
  }
  return [...related.entries()].map(([path, reason]) => ({ path, reason }));
};
