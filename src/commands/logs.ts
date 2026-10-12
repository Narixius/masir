import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { defineCommand } from "citty";

import type { ResponseOf, StatusResult } from "../protocol.js";
import { callHelper } from "../utils/ipc.js";

const TAIL_LINES = 20;
/** How far back from the end of the log to look for the last TAIL_LINES lines. */
const TAIL_WINDOW_BYTES = 64 * 1024;
const POLL_MS = 250;
/** xray creates its log file a moment after it starts. */
const FILE_WAIT_ATTEMPTS = 20;

/** Read `[start, end)` of `path` as text. */
const readRange = (path: string, start: number, end: number): string => {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const read = readSync(fd, buffer, 0, buffer.length, start);
    return buffer.subarray(0, read).toString("utf-8");
  } finally {
    closeSync(fd);
  }
};

const fileSize = (path: string): number => {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
};

const waitForFile = async (path: string): Promise<boolean> => {
  for (let attempt = 0; attempt < FILE_WAIT_ATTEMPTS && !existsSync(path); attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(POLL_MS);
  }
  return existsSync(path);
};

const follow = async (logFile: string): Promise<void> => {
  if (!(await waitForFile(logFile))) {
    throw new Error("log file was not created");
  }
  let position = fileSize(logFile);
  const windowStart = Math.max(0, position - TAIL_WINDOW_BYTES);
  const lines = readRange(logFile, windowStart, position).split("\n");
  // The window may start mid-line; the first piece is only trustworthy when it begins at 0.
  const complete = windowStart === 0 ? lines : lines.slice(1);
  process.stdout.write(`${complete.slice(-TAIL_LINES - 1).join("\n")}`);

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(POLL_MS);
    const size = fileSize(logFile);
    if (size < position) {
      // Truncated or rotated: start over from the top.
      position = 0;
    }
    if (size > position) {
      process.stdout.write(readRange(logFile, position, size));
      position = size;
    }
  }
};

export const logsCommand = defineCommand({
  meta: {
    description: "tail the xray logs (xray must be running)",
    name: "logs",
  },
  async run() {
    let status: StatusResult | undefined;
    try {
      const res = callHelper<ResponseOf<"status">>({ type: "status" });
      status = res.ok ? res.result : undefined;
    } catch {
      status = undefined;
    }
    if (!status?.xray.running || !status.xray.logFile) {
      console.error("xray is not running. Start it with `masir start`.");
      process.exit(1);
    }

    try {
      await follow(status.xray.logFile);
    } catch (error) {
      console.error(`Cannot read ${status.xray.logFile}: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
