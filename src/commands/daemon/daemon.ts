import { defineCommand } from "citty";

import { installCommand } from "./install.js";
import { restartDaemonCommand } from "./restart.js";
import { runDaemonCommand } from "./run.js";
import { stopDaemonCommand } from "./stop.js";
import { uninstallCommand } from "./uninstall.js";

export const daemonCommand = defineCommand({
  meta: {
    description: "Manage the background daemon (and its system service for TUN mode)",
    name: "daemon",
  },
  subCommands: {
    disable: uninstallCommand,
    enable: installCommand,
    reload: restartDaemonCommand,
    restart: restartDaemonCommand,
    run: runDaemonCommand,
    stop: stopDaemonCommand,
  },
});
