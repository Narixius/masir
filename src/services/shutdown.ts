// Process-exit cleanup for long-running entry points (the daemon). Nothing is
// installed at import time: `installShutdownHooks` is called explicitly, so
// the CLI never gets these handlers just by importing a service.
type Cleanup = () => void;

const cleanups: Cleanup[] = [];
let installed = false;

/** Register a synchronous cleanup to run on exit and on SIGINT/SIGTERM/SIGHUP. */
export const onShutdown = (cleanup: Cleanup): void => {
  cleanups.push(cleanup);
};

const runCleanups = (): void => {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // keep going: every child process deserves its stop signal
    }
  }
};

export const installShutdownHooks = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  process.on("exit", runCleanups);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      runCleanups();
      process.exit(0);
    });
  }
};
