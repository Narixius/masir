import { setTimeout as sleep } from "node:timers/promises";

import { nativePrompts } from "../native.js";

export interface ConfirmPromptOptions {
  readonly message: string;
  readonly default?: boolean;
}

export interface SelectOption<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
}

export interface SelectPromptOptions<T extends string> {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly defaultValue?: T;
}

export interface MultiselectPromptOptions<T extends string> {
  readonly message: string;
  readonly options: readonly SelectOption<T>[];
  readonly initialValues?: readonly T[];
}

export interface TextPromptOptions {
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
}

export const confirmPrompt = (options: ConfirmPromptOptions): Promise<boolean> => {
  const isDefaultYes = options.default ?? true;
  const res = nativePrompts.confirm(options.message, isDefaultYes ? 1 : 0);
  if (res === -1) {
    process.exit(130);
  }
  return Promise.resolve(res === 1);
};

export const selectPrompt = <T extends string>(options: SelectPromptOptions<T>): Promise<T> => {
  if (options.options.length === 0) {
    throw new Error("No options provided to selectPrompt");
  }

  const displayLabels = options.options.map((opt) => (opt.hint ? `${opt.label} (${opt.hint})` : opt.label));
  let defaultIdx = -1;
  if (options.defaultValue) {
    defaultIdx = options.options.findIndex((opt) => opt.value === options.defaultValue);
  }

  const idx = nativePrompts.select(options.message, JSON.stringify(displayLabels), defaultIdx);
  if (idx === -1) {
    process.exit(130);
  }

  const chosen = options.options[idx];
  if (!chosen) {
    throw new Error(`Invalid selection index: ${idx}`);
  }
  return Promise.resolve(chosen.value);
};

export const multiselectPrompt = <T extends string>(options: MultiselectPromptOptions<T>): Promise<T[]> => {
  if (options.options.length === 0) {
    const emptyResult: T[] = [];
    return Promise.resolve(emptyResult);
  }

  const displayLabels = options.options.map((opt) => (opt.hint ? `${opt.label} (${opt.hint})` : opt.label));
  const defaultIndices: number[] = [];
  if (options.initialValues) {
    for (const val of options.initialValues) {
      const found = options.options.findIndex((opt) => opt.value === val);
      if (found !== -1) {
        defaultIndices.push(found);
      }
    }
  }

  const out = Buffer.alloc(8192);
  const len = nativePrompts.multiselect(options.message, JSON.stringify(displayLabels), JSON.stringify(defaultIndices), out);

  if (len === -1) {
    process.exit(130);
  }
  if (len <= 0) {
    const emptyResult: T[] = [];
    return Promise.resolve(emptyResult);
  }

  const jsonStr = out.subarray(0, len).toString("utf-8");
  const selectedIndices = JSON.parse(jsonStr) as number[];
  const result: T[] = [];
  for (const idx of selectedIndices) {
    const item = options.options[idx];
    if (item) {
      result.push(item.value);
    }
  }
  return Promise.resolve(result);
};

export const textPrompt = (options: TextPromptOptions): Promise<string> => {
  const out = Buffer.alloc(2048);
  const len = nativePrompts.text(options.message, options.defaultValue ?? "", out);
  if (len === -1) {
    process.exit(130);
  }
  if (len <= 0) {
    return Promise.resolve(options.defaultValue ?? "");
  }
  return Promise.resolve(out.subarray(0, len).toString("utf-8"));
};

/** What to show after a row's label: a spinner while `loading`, else `text`. */
export interface LiveStatus {
  /** Row index in `LiveSelectPromptOptions.rows`. */
  readonly row: number;
  readonly text: string;
  readonly loading: boolean;
}

/** A selectable row, or (with `header`) a group title the cursor skips. */
export interface LiveRow<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly header: boolean;
  /** What type-to-filter matches (default: the label without colors). Use logical-order text for RTL labels. */
  readonly search?: string;
}

export interface LiveSelectPromptOptions<T extends string> {
  readonly message: string;
  readonly rows: readonly LiveRow<T>[];
  readonly defaultValue?: T;
  /**
   * Called every tick with the rows currently on screen; returns statuses to
   * show. Must not block for long. Exactly `LiveStatus[]` (no optional
   * entries): scriptc cannot convert a narrower array type at a function slot.
   */
  readonly refresh: (visibleRows: readonly number[]) => readonly LiveStatus[];
}

const LIVE_POLL_MS = 100;
const LIVE_PENDING = -100;
const LIVE_CANCELLED = -1;
const LIVE_NOT_INTERACTIVE = -3;
/** Room for a screenful of row indices ("3,4,5,..."). */
const VIEWPORT_BUFFER_BYTES = 1024;

/** Rows on screen right now (indices into `rows`), from the native prompt. */
const visibleRows = (out: Buffer): number[] => {
  const len = nativePrompts.liveSelectViewport(out);
  if (len <= 0) {
    return [];
  }
  return out
    .subarray(0, len)
    .toString("utf-8")
    .split(",")
    .map(Number)
    .filter((row) => Number.isInteger(row));
};

const firstSelectable = <T extends string>(rows: readonly LiveRow<T>[], preferred?: T): LiveRow<T> => {
  const match = preferred === undefined ? undefined : rows.find((row) => !row.header && row.value === preferred);
  const first = match ?? rows.find((row) => !row.header);
  if (!first) {
    throw new Error("No selectable rows provided to liveSelectPrompt");
  }
  return first;
};

/**
 * A select prompt whose rows update while it is open (latency per proxy), with
 * optional group headers. The native prompt draws on its own thread; this loop
 * feeds it statuses for the rows on screen and polls for the answer, so the
 * event loop (and any in-process tests) keeps running.
 */
export const liveSelectPrompt = async <T extends string>(options: LiveSelectPromptOptions<T>): Promise<T> => {
  const fallback = firstSelectable(options.rows, options.defaultValue);
  const specs = options.rows.map((row) => ({ header: row.header, label: row.label, search: row.search ?? null }));
  const started = nativePrompts.liveSelectStart(options.message, JSON.stringify(specs), options.rows.indexOf(fallback));
  if (started === LIVE_NOT_INTERACTIVE) {
    return fallback.value;
  }
  if (started !== 0) {
    const items = options.rows.filter((row) => !row.header);
    return selectPrompt({ defaultValue: fallback.value, message: options.message, options: items });
  }

  // A Map, not a sparse array: scriptc arrays do not read past their end as `undefined`.
  const shown = new Map<number, string>();
  const viewport = Buffer.alloc(VIEWPORT_BUFFER_BYTES);
  let updating = true;
  for (;;) {
    if (updating) {
      try {
        for (const status of options.refresh(visibleRows(viewport))) {
          const key = `${status.loading ? "1" : "0"}${status.text}`;
          if (shown.get(status.row) !== key) {
            shown.set(status.row, key);
            nativePrompts.liveSelectSet(status.row, status.text, status.loading);
          }
        }
      } catch {
        // Updates are a nicety; the prompt itself keeps working.
        updating = false;
      }
    }

    const result = nativePrompts.liveSelectPoll();
    if (result === LIVE_PENDING) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await sleep(LIVE_POLL_MS);
      continue;
    }
    if (result === LIVE_CANCELLED) {
      process.exit(130);
    }
    const chosen = options.rows[result];
    if (!chosen || chosen.header) {
      throw new Error(`Invalid selection index: ${result}`);
    }
    return chosen.value;
  }
};
