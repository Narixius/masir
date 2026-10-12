import { defineCommand } from "citty";

import { rulesAddCommand } from "./add.js";
import { rulesEditCommand } from "./edit.js";
import { rulesListCommand } from "./list.js";
import { rulesRmCommand } from "./rm.js";
import { rulesTestCommand } from "./test.js";

export const rulesCommand = defineCommand({
  meta: {
    description: "Manage routing rules: which traffic goes through the proxy, direct, or is blocked",
    name: "rules",
  },
  subCommands: {
    add: rulesAddCommand,
    edit: rulesEditCommand,
    list: rulesListCommand,
    remove: rulesRmCommand,
    test: rulesTestCommand,
  },
});
