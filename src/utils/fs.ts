import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import envPaths from "env-paths";

export const ensureDirExists = (filePath: string) => {
  mkdirSync(dirname(filePath), { recursive: true });
};

/**
 * Write via a temp file + rename, so readers (the CLI and the daemon share these
 * files) never see a half-written file.
 */
export const writeFileEnsured = (path: string, data: string | Uint8Array) => {
  ensureDirExists(path);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

/** A lock older than this is from a crashed process; critical sections take milliseconds. */
const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 3000;

const tryAcquire = (lockPath: string): boolean => {
  try {
    closeSync(openSync(lockPath, "wx"));
    return true;
  } catch (error) {
    if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST")) {
      throw error;
    }
  }
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      rmSync(lockPath, { force: true });
    }
  } catch {
    // released meanwhile
  }
  return false;
};

/**
 * Run `fn` holding an exclusive lock file. Synchronous on purpose: callers do
 * short read-modify-write cycles on local files, never network I/O, while the
 * lock is held, so a brief spin is cheaper than making every storage call async.
 */
export const withFileLock = <T>(lockPath: string, fn: () => T): T => {
  ensureDirExists(lockPath);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (!tryAcquire(lockPath)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for lock ${lockPath}`);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
};

const paths = envPaths("masir", { suffix: "" });

export const getAppDirs = () => paths;
