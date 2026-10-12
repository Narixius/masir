/**
 * Native transport error codes matching `IpcError` in Rust.
 *
 * `fromNativeCode` maps a negative native return code to its typed tag;
 * `nativeErrorName` renders the canonical name used by CLI diagnostics.
 */

export type NativeErrorTag =
  | "BadArgumentError"
  | "IoError"
  | "BufferTooSmallError"
  | "NativePanicError"
  | "TimeoutError"
  | "UnknownConnectionError"
  | "AlreadyServingError"
  | "BindFailedError"
  | "UnknownNativeError";

export interface NativeError {
  readonly tag: NativeErrorTag;
  readonly code: number;
}

/** Map a native return code into its typed error value. */
export const fromNativeCode = (code: number): NativeError => {
  switch (code) {
    case -1: {
      return { code: -1, tag: "BadArgumentError" };
    }
    case -2: {
      return { code: -2, tag: "IoError" };
    }
    case -3: {
      return { code: -3, tag: "BufferTooSmallError" };
    }
    case -4: {
      return { code: -4, tag: "NativePanicError" };
    }
    case -5: {
      return { code: -5, tag: "TimeoutError" };
    }
    case -6: {
      return { code: -6, tag: "UnknownConnectionError" };
    }
    case -7: {
      return { code: -7, tag: "AlreadyServingError" };
    }
    case -8: {
      return { code: -8, tag: "BindFailedError" };
    }
    default: {
      return { code, tag: "UnknownNativeError" };
    }
  }
};

/** Canonical name for a native error. */
export const nativeErrorName = (error: NativeError): string => {
  switch (error.tag) {
    case "BadArgumentError": {
      return "BAD_ARGUMENT";
    }
    case "IoError": {
      return "IO";
    }
    case "BufferTooSmallError": {
      return "BUFFER_TOO_SMALL";
    }
    case "NativePanicError": {
      return "PANIC";
    }
    case "TimeoutError": {
      return "TIMEOUT";
    }
    case "UnknownConnectionError": {
      return "UNKNOWN_CONNECTION";
    }
    case "AlreadyServingError": {
      return "ALREADY_SERVING";
    }
    case "BindFailedError": {
      return "BIND_FAILED";
    }
    default: {
      return "UNKNOWN";
    }
  }
};
