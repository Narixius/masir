import { defineCommand } from "citty";

import { installCommand } from "./install.js";
import { restartDaemonCommand } from "./restart.js";
import { runDaemonCommand } from "./run.js";
import { stopDaemonCommand } from "./stop.js";
import { uninstallCommand } from "./uninstall.js";

export const daemonCommand = defineCommand({
  meta: {
    description: "Run, install or remove the masir daemon",
    name: "daemon",
  },
  subCommands: {
    install: installCommand,
    restart: restartDaemonCommand,
    run: runDaemonCommand,
    stop: stopDaemonCommand,
    uninstall: uninstallCommand,
  },
});
