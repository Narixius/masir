// Right-to-left text (Persian, Arabic, Hebrew) for the terminal. Most terminals
// draw characters in logical order, so RTL words come out mirrored; for those
// we hand over text already in visual order (see native/masir-ffi/src/bidi.rs).
// Terminals that implement BiDi themselves get the text untouched, or it
// would be flipped twice.
import { nativeText } from "../native.js";
import { outboundLabel } from "../services/subscription/label.js";
import type { ManagedOutbound } from "../services/subscription/types.js";

/** Hebrew, Arabic (incl. Persian), Syriac, Thaana, NKo, and their presentation forms. */
const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
/** Shaping swaps 2-byte letters for 3-byte presentation forms; leave plenty of room. */
const BYTES_PER_INPUT_BYTE = 2;
const BUFFER_SLACK = 64;

/** Terminals known to reorder RTL text on their own. */
const terminalHandlesBidi = (): boolean =>
  process.env["TERM_PROGRAM"] === "Apple_Terminal" ||
  Boolean(process.env["VTE_VERSION"]) ||
  Boolean(process.env["KONSOLE_VERSION"]) ||
  (process.env["TERM"] ?? "").startsWith("mlterm");

/** `MASIR_BIDI=on|off` overrides detection (e.g. for iTerm2 with its BiDi option enabled). */
const shouldReorder = (): boolean => {
  const forced = (process.env["MASIR_BIDI"] ?? "").toLowerCase();
  if (forced === "on") {
    return true;
  }
  if (forced === "off") {
    return false;
  }
  return !terminalHandlesBidi();
};

let reorder: boolean | null = null;

/** `text` ready to print: unchanged unless it has RTL characters and the terminal needs help. */
export const terminalText = (text: string): string => {
  if (!RTL_CHARS.test(text)) {
    return text;
  }
  if (reorder === null) {
    reorder = shouldReorder();
  }
  if (!reorder) {
    return text;
  }
  const out = Buffer.alloc(Buffer.byteLength(text, "utf-8") * BYTES_PER_INPUT_BYTE + BUFFER_SLACK);
  const written = nativeText.visual(text, out);
  return written > 0 ? out.subarray(0, written).toString("utf-8") : text;
};

/** An outbound's display name (remarks, tag or address), ready for the terminal. */
export const displayLabel = (outbound: ManagedOutbound): string => terminalText(outboundLabel(outbound));
