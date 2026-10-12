// The scriptc `--ffi` boundary: signature-only declarations bound to the Rust
// staticlib's C ABI symbols (see ffi/masir.ffi.json). Under `tsx` dev the
// same names resolve to the globals installed by src/shim.dev.ts.

/** The native transport surface exported by the Rust staticlib (FFI). */
export interface NativeTransport {
  readonly serve: (onRequest: (conn: number, peerUid: number, request: string) => void) => number;
  readonly reply: (conn: number, response: string) => number;
  readonly call: (request: string, response: Buffer) => number;
  readonly euid: () => number;
}

declare function masirServe(onRequest: (conn: number, peerUid: number, request: string) => void): number;
declare function masirReply(conn: number, response: string): number;
declare function masirCall(request: string, response: Buffer): number;
declare function masirEuid(): number;

declare function masirPromptConfirm(message: string, defaultVal: number): number;
declare function masirPromptSelect(message: string, optionsJson: string, defaultIdx: number): number;
declare function masirPromptMultiselect(message: string, optionsJson: string, defaultsJson: string, out: Buffer): number;
declare function masirPromptText(message: string, defaultVal: string, out: Buffer): number;
declare function masirPromptLiveSelectStart(message: string, optionsJson: string, defaultIdx: number): number;
declare function masirPromptLiveSelectSet(idx: number, text: string, loading: number): number;
declare function masirPromptLiveSelectPoll(): number;
declare function masirPromptLiveSelectViewport(out: Buffer): number;
declare function masirTextVisual(text: string, out: Buffer): number;
declare function masirListProcesses(out: Buffer): number;

export const nativeTransport: NativeTransport = {
  call: (request: string, response: Buffer): number => masirCall(request, response),
  euid: (): number => masirEuid(),
  reply: (conn: number, response: string): number => masirReply(conn, response),
  serve: (onRequest: (conn: number, peerUid: number, request: string) => void): number => masirServe(onRequest),
};

export const nativePrompts = {
  confirm: (message: string, defaultVal: number): number => masirPromptConfirm(message, defaultVal),
  select: (message: string, optionsJson: string, defaultIdx: number): number => masirPromptSelect(message, optionsJson, defaultIdx),
  multiselect: (message: string, optionsJson: string, defaultsJson: string, out: Buffer): number =>
    masirPromptMultiselect(message, optionsJson, defaultsJson, out),
  text: (message: string, defaultVal: string, out: Buffer): number => masirPromptText(message, defaultVal, out),
  liveSelectStart: (message: string, optionsJson: string, defaultIdx: number): number =>
    masirPromptLiveSelectStart(message, optionsJson, defaultIdx),
  liveSelectSet: (idx: number, text: string, loading: boolean): number => masirPromptLiveSelectSet(idx, text, loading ? 1 : 0),
  liveSelectPoll: (): number => masirPromptLiveSelectPoll(),
  liveSelectViewport: (out: Buffer): number => masirPromptLiveSelectViewport(out),
};

export const nativeText = {
  /** Logical-order text to visual order (shaped, BiDi-reordered); bytes written, or < 0. */
  visual: (text: string, out: Buffer): number => masirTextVisual(text, out),
};

export const nativeSystem = {
  /** Running processes as JSON (`[{pid, ppid, name, exe}]`); bytes written, -3 if `out` is too small. */
  listProcesses: (out: Buffer): number => masirListProcesses(out),
};
