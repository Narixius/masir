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
  /** Multi-select: starts ticked. */
  readonly checked?: boolean;
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
const LIVE_CUSTOM_PICKED = -10;
const LIVE_FLAG_MULTI = 1;
const LIVE_FLAG_CUSTOM = 2;
/** Room for a screenful of row indices ("3,4,5,..."). */
const VIEWPORT_BUFFER_BYTES = 1024;
const SELECTION_BUFFER_BYTES = 64 * 1024;

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

/** What the native prompt returns besides its status code. */
interface LiveSelection {
  readonly checked: number[];
  readonly custom: string[];
}

interface LiveOutcome {
  /** A row index (single-select), 0 (multi-select done) or `LIVE_CUSTOM_PICKED`. */
  readonly code: number;
  readonly selection: LiveSelection;
}

interface LiveSpec {
  readonly label: string;
  readonly header: boolean;
  readonly search: string | null;
  readonly checked: boolean;
}

const noStatuses = (): readonly LiveStatus[] => [];

const readSelection = (): LiveSelection => {
  const out = Buffer.alloc(SELECTION_BUFFER_BYTES);
  const len = nativePrompts.liveSelectSelection(out);
  return len > 0 ? (JSON.parse(out.subarray(0, len).toString("utf-8")) as LiveSelection) : { checked: [], custom: [] };
};

/**
 * Run the native live prompt to completion, feeding `refresh` statuses for
 * the rows on screen. `null` when it can't run interactively (no terminal).
 */
const runLivePrompt = async (
  message: string,
  specs: readonly LiveSpec[],
  defaultIdx: number,
  flags: number,
  refresh: (visibleRows: readonly number[]) => readonly LiveStatus[]
): Promise<LiveOutcome | null> => {
  const started = nativePrompts.liveSelectStart(message, JSON.stringify(specs), defaultIdx, flags);
  if (started !== 0) {
    return null;
  }
  // A Map, not a sparse array: scriptc arrays do not read past their end as `undefined`.
  const shown = new Map<number, string>();
  const viewport = Buffer.alloc(VIEWPORT_BUFFER_BYTES);
  let updating = true;
  for (;;) {
    if (updating) {
      try {
        for (const status of refresh(visibleRows(viewport))) {
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
    const code = nativePrompts.liveSelectPoll();
    if (code === LIVE_PENDING) {
      // oxlint-disable-next-line eslint/no-await-in-loop
      await sleep(LIVE_POLL_MS);
      continue;
    }
    if (code === LIVE_CANCELLED) {
      process.exit(130);
    }
    if (code < 0 && code !== LIVE_CUSTOM_PICKED) {
      throw new Error("The selection prompt failed");
    }
    return { code, selection: readSelection() };
  }
};

const toSpec = <T extends string>(row: LiveRow<T>): LiveSpec => ({
  checked: row.checked ?? false,
  header: row.header,
  label: row.label,
  search: row.search ?? null,
});

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
  const outcome = await runLivePrompt(options.message, options.rows.map(toSpec), options.rows.indexOf(fallback), 0, options.refresh);
  if (!outcome) {
    return fallback.value;
  }
  const chosen = options.rows[outcome.code];
  if (!chosen || chosen.header) {
    throw new Error(`Invalid selection index: ${outcome.code}`);
  }
  return chosen.value;
};

export interface PickValuesOptions<T extends string> {
  readonly message: string;
  /** Rows to pick from; `checked` ones start ticked. */
  readonly rows: readonly LiveRow<T>[];
  /** Offer "+ add <typed text>" for values that aren't in the list. */
  readonly allowCustom: boolean;
  /** Typed values already chosen (shown ticked at the top). */
  readonly custom?: readonly string[];
  /** Why a typed value is invalid, or `null` when it is fine. */
  readonly validate?: (value: string) => string | null;
}

export interface PickedValues<T extends string> {
  readonly values: T[];
  readonly custom: string[];
}

const TYPED_GROUP = "Your values";

interface PickSpecs {
  readonly specs: LiveSpec[];
  /** Where the caller's rows start (typed values come first). */
  readonly offset: number;
}

interface SplitSelection {
  readonly checked: Set<number>;
  readonly custom: string[];
}

interface TypedCheck {
  readonly valid: string[];
  readonly problems: string[];
}

const initiallyChecked = <T extends string>(rows: readonly LiveRow<T>[]): Set<number> => {
  const checked = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (row.checked) {
      checked.add(index);
    }
  }
  return checked;
};

/** Typed values go first, under their own header, ticked; `offset` is where `rows` start. */
const pickSpecs = <T extends string>(rows: readonly LiveRow<T>[], checked: ReadonlySet<number>, custom: readonly string[]): PickSpecs => {
  const specs: LiveSpec[] = [];
  if (custom.length > 0) {
    specs.push({ checked: false, header: true, label: TYPED_GROUP, search: null });
    for (const value of custom) {
      specs.push({ checked: true, header: false, label: value, search: null });
    }
  }
  const offset = specs.length;
  for (const [index, row] of rows.entries()) {
    specs.push({ ...toSpec(row), checked: checked.has(index) });
  }
  return { offset, specs };
};

/** The prompt's answer split back into ticked rows (indices into `rows`) and typed values. */
const splitSelection = (selection: LiveSelection, specs: readonly LiveSpec[], offset: number): SplitSelection => {
  const checked = new Set<number>();
  const custom: string[] = [];
  for (const index of selection.checked) {
    if (index >= offset) {
      checked.add(index - offset);
    } else if (specs[index] && !(specs[index] as LiveSpec).header) {
      custom.push((specs[index] as LiveSpec).label);
    }
  }
  for (const value of selection.custom) {
    custom.push(value.trim());
  }
  return { checked, custom };
};

/** Valid typed values (deduplicated) and the reasons the others were refused. */
const checkTyped = (values: readonly string[], validate?: (value: string) => string | null): TypedCheck => {
  const valid: string[] = [];
  const problems: string[] = [];
  for (const value of values) {
    const problem = validate?.(value) ?? null;
    if (problem) {
      problems.push(`"${value}": ${problem}`);
    } else if (!valid.includes(value)) {
      valid.push(value);
    }
  }
  return { problems, valid };
};

const picked = <T extends string>(rows: readonly LiveRow<T>[], checked: ReadonlySet<number>, custom: string[]): PickedValues<T> => {
  const values: T[] = [];
  for (const [index, row] of rows.entries()) {
    if (checked.has(index)) {
      values.push(row.value);
    }
  }
  return { custom, values };
};

/**
 * Multi-select with type-to-filter and typed values. Invalid typed values are
 * reported and the prompt reopens with the rest of the selection kept.
 * Outside a terminal, returns the rows that start checked.
 */
export const pickValues = async <T extends string>(options: PickValuesOptions<T>): Promise<PickedValues<T>> => {
  let custom = [...(options.custom ?? [])];
  let checked = initiallyChecked(options.rows);
  const flags = LIVE_FLAG_MULTI + (options.allowCustom ? LIVE_FLAG_CUSTOM : 0);
  for (;;) {
    const { specs, offset } = pickSpecs(options.rows, checked, custom);
    // oxlint-disable-next-line eslint/no-await-in-loop
    const outcome = await runLivePrompt(options.message, specs, -1, flags, noStatuses);
    if (!outcome) {
      return picked(options.rows, checked, custom);
    }
    const answer = splitSelection(outcome.selection, specs, offset);
    const typed = checkTyped(answer.custom, options.validate);
    ({ checked } = answer);
    custom = typed.valid;
    if (typed.problems.length === 0) {
      return picked(options.rows, checked, custom);
    }
    for (const problem of typed.problems) {
      console.log(`│\n■  ${problem}`);
    }
  }
};
