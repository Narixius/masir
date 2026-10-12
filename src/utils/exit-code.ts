// `process.exitCode` has no scriptc lowering: writes are dropped in the native
// binary. Commands record failure here instead, and `main.ts` applies it.
let exitCode = 0;

/** Mark the command as failed without exiting yet (output still flushes). */
export const setExitCode = (code: number): void => {
  exitCode = code;
};

export const getExitCode = (): number => exitCode;
