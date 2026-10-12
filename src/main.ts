import { join } from "node:path";

import tab from "@bomb.sh/tab/citty";
import { defineCommand, runCommand, runMain } from "citty";
import { initLogger } from "evlog";
import { createFsDrain } from "evlog/fs";

import "./native.js";
import { daemonCommand } from "./commands/daemon/daemon.js";
import { logsCommand } from "./commands/logs.js";
import { rulesCommand } from "./commands/rules/rules.js";
import { settingsCommand } from "./commands/settings.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { stopCommand } from "./commands/stop.js";
import { subCommand } from "./commands/sub/sub.js";
import { subUseCommand } from "./commands/sub/use.js";
import { getExitCode } from "./utils/exit-code.js";
import { getAppDirs } from "./utils/fs.js";

// Under the app log dir, not cwd: the CLI runs from anywhere.
const fs = createFsDrain({ dir: join(getAppDirs().log, "evlog") });
initLogger({ env: { service: "masir-cli" }, drain: fs, silent: true });

/** Arguments for tab's `complete` command, which generates the scripts. */
const completeArgs = (rawArgs: readonly string[]): string[] => {
  const args = ["complete"];
  for (const arg of rawArgs) {
    args.push(arg);
  }
  return args;
};

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
    sub: subCommand,
    logs: logsCommand,
    rules: rulesCommand,
    settings: settingsCommand,
    daemon: daemonCommand,
    completion: defineCommand({
      args: { shell: { description: "zsh, bash, fish or powershell", required: false, type: "positional" } },
      meta: { description: "Print a shell completion script, e.g. `masir completion zsh`", name: "completion" },
      // tab's own `complete` command generates it (its scripts call `masir complete`, so that name stays).
      run: ({ rawArgs }) => runCommand(masirCli, { rawArgs: completeArgs(rawArgs) }),
    }),
  },
});
await tab(masirCli);

await runMain(masirCli);
// Commands record failure with `setExitCode` (see utils/exit-code.ts). `daemon run`
// never sets it, so its event loop keeps the daemon alive.
if (getExitCode() !== 0) {
  process.exit(getExitCode());
}
