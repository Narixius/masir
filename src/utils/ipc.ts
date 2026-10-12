import { fromNativeCode, nativeErrorName } from "../errors.js";
import type { NativeError } from "../errors.js";
import { nativeTransport } from "../native.js";
import { decodeEnvelope } from "../protocol.js";
import type { Envelope, Request } from "../protocol.js";

const RESPONSE_CAP = 64 * 1024;

export type IpcCallResult<T> = Envelope<T>;

/** The daemon could not be reached or did not answer (no socket, timeout, ...). */
export class TransportError extends Error {
  readonly native: NativeError;

  constructor(native: NativeError) {
    super(`Transport error (${nativeErrorName(native)}): failed to send request to the daemon`);
    this.name = "TransportError";
    this.native = native;
  }
}

/**
 * Send one request to the daemon. Throws `TransportError` when the daemon is unreachable.
 *
 * Callers name the result as `callHelper<ResponseOf<"status">>({ type: "status" })`.
 * Deriving it from `request.type` would be nicer, but scriptc erases string literal
 * types when it monomorphizes generics, so `ResponseOf<K>` cannot compile here.
 */
export const callHelper = <T>(request: Request): IpcCallResult<T> => {
  const out = Buffer.alloc(RESPONSE_CAP);
  const written = nativeTransport.call(JSON.stringify(request), out);
  if (written < 0) {
    throw new TransportError(fromNativeCode(written));
  }
  return decodeEnvelope<T>(out.subarray(0, written).toString("utf-8"));
};

/** Like `callHelper`, but `null` when no daemon is reachable: one round trip instead of `info` + request. */
export const tryCallHelper = <T>(request: Request): IpcCallResult<T> | null => {
  try {
    return callHelper<T>(request);
  } catch (error: unknown) {
    if (error instanceof TransportError) {
      return null;
    }
    throw error;
  }
};
