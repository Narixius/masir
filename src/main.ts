import { join } from "node:path";

import tab from "@bomb.sh/tab/citty";
import { defineCommand, runMain } from "citty";
import { initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";

import "./native.js";
import { daemonCommand } from "./commands/daemon/daemon.js";
import { logsCommand } from "./commands/logs.js";
import { modeCommand } from "./commands/mode.js";
import { rulesCommand } from "./commands/rules/rules.js";
import { settingsCommand } from "./commands/settings.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { subCommand } from "./commands/sub/sub.js";
import { subUseCommand } from "./commands/sub/use.js";
import { updateCommand } from "./commands/update.js";
import { getExitCode } from "./utils/exit-code.js";
import { getAppDirs } from "./utils/fs.js";

// Under the app log dir, not cwd: the CLI runs from anywhere.
const fs = createFsDrain({ dir: join(getAppDirs().log, "evlog") });
initLogger({ env: { service: "masir-cli" }, drain: fs, silent: true });

const masirCli = defineCommand({
  meta: {
    description: "A command-line client for xray-core: subscriptions, proxies and routing rules",
    name: "masir",
    version: "0.1.0",
  },
  subCommands: {
    status: statusCommand,
    connect: startCommand,
    disconnect: stopCommand,
    use: subUseCommand,
    mode: modeCommand,
    sub: subCommand,
    logs: logsCommand,
    rules: rulesCommand,
    settings: settingsCommand,
    daemon: daemonCommand,
    update: updateCommand,
  },
});
await tab(masirCli);

await runMain(masirCli);
// Commands record failure with `setExitCode` (see utils/exit-code.ts). `daemon run`
// never sets it, so its event loop keeps the daemon alive.
if (getExitCode() !== 0) {
  process.exit(getExitCode());
}
