import { defineCommand } from "citty";
import pc from "picocolors";

import { findSetting, formatSetting, isCustomized, SETTINGS } from "../config/setting-specs.js";
import type { SettingSpec } from "../config/setting-specs.js";
import { configFilePath, loadSettings, writeSetting } from "../config/settings.js";
import type { ResponseOf } from "../protocol.js";
import { setExitCode } from "../utils/exit-code.js";
import { tryCallHelper } from "../utils/ipc.js";
import { log, note } from "../utils/log.js";
import { selectPrompt, textPrompt } from "../utils/prompts.js";

const keyWidth = (): number => {
  let width = 0;
  for (const spec of SETTINGS) {
    width = Math.max(width, spec.key.length);
  }
  return width;
};
const KEY_WIDTH = keyWidth();

const fail = (message: string): void => {
  log.error(pc.red(message));
  setExitCode(1);
};

const unknownKey = (key: string): void => {
  fail(`Unknown setting "${key}". Settings: ${SETTINGS.map((spec) => spec.key).join(", ")}.`);
};

/** After a change: reload a running xray when the setting affects it. */
const apply = (spec: SettingSpec): void => {
  if (!spec.reloadsXray) {
    log.step(pc.dim("Takes effect at the next background refresh."));
    return;
  }
  const res = tryCallHelper<ResponseOf<"reload">>({ type: "reload" });
  if (!res) {
    log.step(pc.dim("Takes effect the next time xray starts (`masir start`)."));
  } else if (res.ok) {
    log.step(pc.cyan("Applied: a running xray was reloaded."));
  } else {
    log.warn(pc.yellow(`Saved, but reloading xray failed: ${res.error}`));
  }
};

/** Validate and store `text` for `spec`; false (with the reason shown) when it isn't valid. */
const setFromText = (spec: SettingSpec, text: string): boolean => {
  const parsed = spec.parse(text.trim(), loadSettings());
  if (!parsed.ok) {
    fail(`${spec.label}: ${parsed.error}.`);
    return false;
  }
  const settings = writeSetting(spec.key, parsed.value);
  log.success(pc.green(`${spec.label} set to ${formatSetting(spec, settings)}.`));
  apply(spec);
  return true;
};

const reset = (spec: SettingSpec): void => {
  const settings = writeSetting(spec.key);
  log.success(pc.green(`${spec.label} reset to its default: ${formatSetting(spec, settings)}.`));
  apply(spec);
};

const listSettings = (): void => {
  const settings = loadSettings();
  const lines = SETTINGS.map((spec) => {
    const value = formatSetting(spec, settings);
    const origin = isCustomized(spec) ? "" : pc.dim(" (default)");
    return `${spec.key.padEnd(KEY_WIDTH)}  ${value}${origin}\n${" ".repeat(KEY_WIDTH)}  ${pc.dim(spec.description)}`;
  });
  note([...lines, "", pc.dim(configFilePath())].join("\n"), "Settings");
};

const editSetting = async (spec: SettingSpec): Promise<void> => {
  if (isCustomized(spec)) {
    const action = await selectPrompt({
      message: spec.label,
      options: [
        { label: "Change it", value: "change" },
        { hint: "follow the default again", label: "Reset to default", value: "reset" },
        { label: "Back", value: "back" },
      ],
    });
    if (action === "reset") {
      reset(spec);
      return;
    }
    if (action === "back") {
      return;
    }
  }
  const current = formatSetting(spec, loadSettings());
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    const typed = await textPrompt({
      defaultValue: current,
      message: `${spec.label} ${pc.dim(`(${spec.description})`)}`,
      placeholder: current,
    });
    if (typed.trim() === current || typed.trim().length === 0) {
      return;
    }
    if (setFromText(spec, typed)) {
      return;
    }
  }
};

const DONE = "done";

/** Pick a setting, type its new value (or reset it); repeat until Done. */
const settingsMenu = async (): Promise<void> => {
  for (;;) {
    const settings = loadSettings();
    // oxlint-disable-next-line eslint/no-await-in-loop
    const key = await selectPrompt({
      message: "Which setting?",
      options: [
        ...SETTINGS.map((spec) => ({
          hint: `${formatSetting(spec, settings)}${isCustomized(spec) ? "" : " (default)"}`,
          label: spec.label,
          value: spec.key,
        })),
        { label: "Done", value: DONE },
      ],
    });
    const spec = key === DONE ? undefined : findSetting(key);
    if (!spec) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await editSetting(spec);
  }
};

const settingsListCommand = defineCommand({
  meta: { description: "Show every setting and its value", name: "list" },
  run() {
    listSettings();
  },
});

const settingsGetCommand = defineCommand({
  args: { key: { description: "the setting to show", required: true, type: "positional" } },
  meta: { description: "Print one setting's value", name: "get" },
  run({ args }) {
    const spec = findSetting(String(args.key));
    if (!spec) {
      unknownKey(String(args.key));
      return;
    }
    console.log(formatSetting(spec, loadSettings()));
  },
});

const settingsSetCommand = defineCommand({
  args: {
    key: { description: "the setting to change", required: true, type: "positional" },
    value: { description: "its new value (DNS servers: comma-separated)", required: true, type: "positional" },
  },
  meta: { description: "Change a setting", name: "set" },
  run({ args }) {
    const spec = findSetting(String(args.key));
    if (!spec) {
      unknownKey(String(args.key));
      return;
    }
    // Everything after the key is the value (e.g. `set dnsServers 1.1.1.1 8.8.8.8`).
    setFromText(spec, args._.slice(1).map(String).join(" ") || String(args.value));
  },
});

const settingsResetCommand = defineCommand({
  args: { key: { description: "the setting to reset", required: true, type: "positional" } },
  meta: { description: "Reset a setting to its default", name: "reset" },
  run({ args }) {
    const spec = findSetting(String(args.key));
    if (!spec) {
      unknownKey(String(args.key));
      return;
    }
    reset(spec);
  },
});

export const settingsCommand = defineCommand({
  meta: {
    description: "View and change settings (ports, xray paths, DNS, refresh interval)",
    name: "settings",
  },
  async run({ rawArgs }) {
    // citty also runs this after a subcommand; only act on a bare `masir settings`.
    if (rawArgs.length > 0) {
      return;
    }
    if (process.stdin.isTTY) {
      await settingsMenu();
    } else {
      listSettings();
    }
  },
  subCommands: {
    get: settingsGetCommand,
    list: settingsListCommand,
    ls: settingsListCommand,
    reset: settingsResetCommand,
    set: settingsSetCommand,
  },
});
