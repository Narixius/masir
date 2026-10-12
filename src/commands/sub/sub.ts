import { defineCommand } from "citty";

import { subAddCommand } from "./add.js";
import { subListCommand } from "./list.js";
import { subRemoveCommand } from "./rm.js";
import { subUpdateCommand } from "./update.js";
import { subUseCommand } from "./use.js";

export const subCommand = defineCommand({
  meta: {
    description: "Manage proxy subscriptions (add, list, update, remove)",
    name: "sub",
    alias: ["subscription", "subs"],
  },
  subCommands: {
    add: subAddCommand,
    list: subListCommand,
    remove: subRemoveCommand,
    update: subUpdateCommand,
    use: subUseCommand,
  },
});
