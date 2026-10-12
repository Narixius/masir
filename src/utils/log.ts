import pc from "picocolors";

import { nativeSystem } from "../native.js";

const bar = pc.gray("│");

export const log = {
  message: (msg = ""): void => {
    console.log(`${bar}  ${msg}`);
  },
  info: (msg = ""): void => {
    console.log(`${bar}\n${pc.blue("●")}  ${msg}`);
  },
  success: (msg = ""): void => {
    console.log(`${bar}\n${pc.green("◆")}  ${msg}`);
  },
  step: (msg = ""): void => {
    console.log(`${bar}\n${pc.green("◇")}  ${msg}`);
  },
  warn: (msg = ""): void => {
    console.log(`${bar}\n${pc.yellow("▲")}  ${msg}`);
  },
  error: (msg = ""): void => {
    console.log(`${bar}\n${pc.red("■")}  ${msg}`);
  },
};

// Escape sequences (colors) take no columns; matching ESC is the point here.
// oxlint-disable-next-line eslint/no-control-regex
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/gu;
/** Leaves room for the box edges and padding. */
const BOX_CHROME = 6;
const DEFAULT_COLUMNS = 100;

/** Combining marks, joiners and variation selectors: drawn on the previous character. */
const ZERO_WIDTH: readonly (readonly [number, number])[] = [
  [0x3_00, 0x3_6f],
  [0x6_4b, 0x6_5f],
  [0x20_0d, 0x20_0d],
  [0xfe_00, 0xfe_0f],
];

/** Emoji, flags (regional indicators) and East Asian wide characters: two columns. */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1_f3_00, 0x1_fa_ff],
  [0x1_f1_e6, 0x1_f1_ff],
  [0x26_00, 0x27_a0],
  [0x27_a2, 0x27_bf],
  [0x11_00, 0x11_5f],
  [0x2e_80, 0xa4_cf],
  [0xac_00, 0xd7_a3],
  [0xf9_00, 0xfa_ff],
  [0xff_00, 0xff_60],
];

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([from, to]) => cp >= from && cp <= to);

const charWidth = (cp: number): number => {
  if (inRanges(cp, ZERO_WIDTH)) {
    return 0;
  }
  return inRanges(cp, WIDE) ? 2 : 1;
};

const edge = (text: string): string => pc.gray(text);

/** Terminal columns `text` occupies (colors ignored). */
export const displayWidth = (text: string): number => {
  let width = 0;
  for (const char of text.replaceAll(ANSI, "")) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
};

/**
 * A titled box around `message`, sized to its widest line. When that doesn't
 * fit the terminal, only the left rail is drawn (a right edge would break).
 */
export const note = (message = "", title = ""): void => {
  const lines = message.split("\n");
  let contentWidth = displayWidth(title) + 1;
  for (const line of lines) {
    contentWidth = Math.max(contentWidth, displayWidth(line));
  }
  const columns = nativeSystem.terminalColumns() || DEFAULT_COLUMNS;
  console.log(bar);
  if (contentWidth + BOX_CHROME > columns) {
    console.log(`${pc.green("◇")}  ${title}`);
    console.log(bar);
    for (const line of lines) {
      console.log(`${bar}  ${line}`);
    }
    console.log(bar);
    return;
  }
  const blank = `${bar}${" ".repeat(contentWidth + 4)}${edge("│")}`;
  console.log(`${pc.green("◇")}  ${title} ${edge(`${"─".repeat(contentWidth - displayWidth(title) + 1)}╮`)}`);
  console.log(blank);
  for (const line of lines) {
    console.log(`${bar}  ${line}${" ".repeat(contentWidth - displayWidth(line))}  ${edge("│")}`);
  }
  console.log(blank);
  console.log(edge(`├${"─".repeat(contentWidth + 4)}╯`));
};
