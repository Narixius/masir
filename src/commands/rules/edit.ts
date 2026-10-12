import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import pc from "picocolors";

import { closestField, parseRule, RULE_FIELDS } from "../../services/rules/schema.js";
import type { RawRule, UserRule } from "../../services/rules/schema.js";
import { loadRules, replaceRule, withRuleReplaced } from "../../services/rules/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { getAppDirs, writeFileEnsured } from "../../utils/fs.js";
import { log, note } from "../../utils/log.js";
import { confirmPrompt, selectPrompt } from "../../utils/prompts.js";
import { collectFlag, splitList } from "../../utils/raw-flags.js";
import { describeRule, matcherLines, targetText } from "./describe.js";
import {
  applyToDaemon,
  checkName,
  definedFields,
  fail,
  MATCHER_ARGS,
  parseJsonRule,
  resolveAppProcesses,
  resolveTarget,
  ruleFromFlags,
  text,
  usesMatcherFlags,
  VIA_ARG,
  warnAboutBareAppNames,
  xrayRejection,
} from "./shared.js";
import type { RuleInput, Step } from "./shared.js";

/** Rule field for a flag spelling, for `--unset source-port`. */
const fieldForFlag = (name: string): string => {
  if (name === "source-port") {
    return "sourcePort";
  }
  return name === "inbound" || name === "inbound-tag" ? "inboundTag" : name;
};

interface EditArgs {
  readonly json?: string;
  readonly outbound?: string;
  readonly rename?: string;
  readonly append?: boolean;
  readonly via?: string;
}

/** `--unset via`: drop the rule's pin (it goes back to the active proxy). */
const unsetsVia = (rawArgs: readonly string[]): boolean => splitList(collectFlag(rawArgs, "unset")).includes("via");

/** An editable copy of a stored rule. */
const editable = (rule: UserRule): RuleInput => ({ ...rule.rule });

const unique = (values: readonly string[]): string[] => values.filter((value, i) => values.indexOf(value) === i);

/** New list values replace the old ones, or with `--append` are added to them. */
const mergeList = (current: string[] | undefined, added: string[] | undefined, append: boolean): string[] | undefined => {
  if (added === undefined) {
    return current;
  }
  return append ? unique([...(current ?? []), ...added]) : added;
};

/** Same for port lists (`53,443`). */
const mergePorts = (current: string | undefined, added: string | undefined, append: boolean): string | undefined => {
  if (added === undefined) {
    return current;
  }
  return append && current ? unique(splitList([current, added])).join(",") : added;
};

/** Drop one field from `rule`; false if `field` is not a removable rule field. */
const clearField = (rule: RuleInput, field: string): boolean => {
  switch (field) {
    case "domain": {
      rule.domain = undefined;
      return true;
    }
    case "ip": {
      rule.ip = undefined;
      return true;
    }
    case "port": {
      rule.port = undefined;
      return true;
    }
    case "sourcePort": {
      rule.sourcePort = undefined;
      return true;
    }
    case "network": {
      rule.network = undefined;
      return true;
    }
    case "process": {
      rule.process = undefined;
      return true;
    }
    case "protocol": {
      rule.protocol = undefined;
      return true;
    }
    case "source": {
      rule.source = undefined;
      return true;
    }
    case "user": {
      rule.user = undefined;
      return true;
    }
    case "inboundTag": {
      rule.inboundTag = undefined;
      return true;
    }
    case "attrs": {
      rule.attrs = undefined;
      return true;
    }
    default: {
      return false;
    }
  }
};

/** Field names from `--unset domain --unset source-port` (or `--unset domain,ip`). */
const unsetFields = (rawArgs: readonly string[]): Step<string[]> => {
  const fields: string[] = [];
  for (const given of splitList(collectFlag(rawArgs, "unset"))) {
    if (given === "via") {
      continue;
    }
    const field = fieldForFlag(given);
    if (field === "outboundTag" || !RULE_FIELDS.includes(field)) {
      const suggestion = field === "outboundTag" ? undefined : closestField(field);
      const hint = field === "outboundTag" ? " (a rule always has an outbound; change it with --outbound)" : "";
      return { error: `Cannot unset "${given}"${hint}${suggestion ? ` (did you mean "${suggestion}"?)` : ""}.`, ok: false };
    }
    fields.push(field);
  }
  return { ok: true, value: fields };
};

/** The rule the flags describe: changed fields over the current ones (or `--json` as a whole). */
const editedFields = (current: UserRule, args: EditArgs, rawArgs: readonly string[], appValues: string[] | null): Step<RawRule> => {
  const json = text(args.json);
  if (json.length > 0) {
    if (usesMatcherFlags(rawArgs) || args.append) {
      return { error: "--json replaces the whole rule; don't combine it with matcher flags or --append.", ok: false };
    }
    const parsed = parseJsonRule(json);
    if (parsed.ok && parsed.value["outboundTag"] === undefined) {
      parsed.value["outboundTag"] = current.rule.outboundTag;
    }
    return parsed;
  }
  const append = Boolean(args.append);
  const flags = ruleFromFlags(rawArgs);
  const rule = editable(current);
  rule.domain = mergeList(rule.domain, flags.domain, append);
  rule.ip = mergeList(rule.ip, flags.ip, append);
  const processes = [...(flags.process ?? []), ...(appValues ?? [])];
  rule.process = mergeList(rule.process, processes.length > 0 ? processes : undefined, append);
  rule.protocol = mergeList(rule.protocol, flags.protocol, append);
  rule.source = mergeList(rule.source, flags.source, append);
  rule.port = mergePorts(rule.port, flags.port, append);
  rule.sourcePort = mergePorts(rule.sourcePort, flags.sourcePort, append);
  rule.network = flags.network ?? rule.network;
  const unset = unsetFields(rawArgs);
  if (!unset.ok) {
    return unset;
  }
  for (const field of unset.value) {
    clearField(rule, field);
  }
  const fields = definedFields(rule);
  return { ok: true, value: fields };
};

/** The updated rule from flags, validated; `null` value means nothing was asked to change. */
const ruleFromEditFlags = async (
  current: UserRule,
  rules: readonly UserRule[],
  args: EditArgs,
  rawArgs: readonly string[]
): Promise<Step<UserRule | null>> => {
  const wantsChange =
    text(args.json).length > 0 ||
    usesMatcherFlags(rawArgs) ||
    text(args.outbound).length > 0 ||
    text(args.rename).length > 0 ||
    text(args.via).length > 0 ||
    collectFlag(rawArgs, "unset").length > 0;
  if (!wantsChange) {
    return { ok: true, value: null };
  }
  const app = await resolveAppProcesses(rawArgs);
  if (!app.ok) {
    return app;
  }
  const fields = editedFields(current, args, rawArgs, app.value);
  if (!fields.ok) {
    return fields;
  }
  // A new outbound or pin replaces the old target; otherwise the pin stays.
  let { via } = current;
  if (text(args.outbound).length > 0 || text(args.via).length > 0) {
    const target = await resolveTarget(text(args.outbound), text(args.via));
    if (!target.ok) {
      return target;
    }
    fields.value["outboundTag"] = target.value.outbound;
    ({ via } = target.value);
  }
  if (unsetsVia(rawArgs)) {
    via = undefined;
  }
  const name = text(args.rename).trim() || current.name;
  const checkedName = checkName(name, rules, current.name);
  if (!checkedName.ok) {
    return checkedName;
  }
  const parsed = parseRule(fields.value);
  if (!parsed.ok) {
    return { error: `Invalid rule:\n${parsed.error}`, ok: false };
  }
  const rule = parsed.value;
  return {
    ok: true,
    value: { createdAt: current.createdAt, name: checkedName.value, rule, via: rule.outboundTag === "proxy" ? via : undefined },
  };
};

/** Display label -> value of everything that identifies a rule. */
const labelledValues = (rule: UserRule): Map<string, string> => {
  const map = new Map<string, string>([
    ["name", rule.name],
    ["outbound", targetText(rule)],
  ]);
  for (const [label, value] of matcherLines(rule.rule)) {
    map.set(label, value);
  }
  return map;
};

/** `- label: old` / `+ label: new` for every matcher (and the name/outbound) that changed. */
const changeLines = (before: UserRule, after: UserRule): string[] => {
  const old = labelledValues(before);
  const next = labelledValues(after);
  const labels = unique([...old.keys(), ...next.keys()]);
  const lines: string[] = [];
  for (const label of labels) {
    const was = old.get(label);
    const now = next.get(label);
    if (was !== now) {
      if (was !== undefined) {
        lines.push(`${pc.red("-")} ${label}: ${was}`);
      }
      if (now !== undefined) {
        lines.push(`${pc.green("+")} ${label}: ${now}`);
      }
    }
  }
  return lines;
};

/** Check with xray, save in place, show the change, reload. False when xray rejected it. */
const saveEdit = (current: UserRule, updated: UserRule, rules: readonly UserRule[]): boolean => {
  const candidate = withRuleReplaced(rules, current.name, updated);
  if (xrayRejection(candidate) !== null) {
    return false;
  }
  replaceRule(current.name, updated);
  const position = candidate.findIndex((rule) => rule.name === updated.name) + 1;
  const changes = changeLines(current, updated);
  note([...describeRule(updated, position), "", ...(changes.length > 0 ? changes : [pc.dim("no changes")])].join("\n"), "Rule updated");
  applyToDaemon();
  return true;
};

/** Run `$VISUAL` / `$EDITOR` (default `vi`) on `path`; the variable may carry arguments, e.g. `code --wait`. */
const openEditor = (path: string): number => {
  const editor = process.env["VISUAL"] || process.env["EDITOR"] || "vi";
  const result = spawnSync("/bin/sh", ["-c", `${editor} "$1"`, "masir-edit", path], { stdio: "inherit" });
  return result.status ?? 1;
};

/** Edit the rule as JSON in the user's editor; on a bad edit, show why and offer to edit again. */
const editInEditor = async (current: UserRule, rules: readonly UserRule[]): Promise<void> => {
  const path = join(getAppDirs().data, `rule-edit.${process.pid}.json`);
  const original = `${JSON.stringify(current.rule, null, 2)}\n`;
  let buffer = original;
  try {
    for (;;) {
      writeFileEnsured(path, buffer);
      if (openEditor(path) !== 0) {
        fail("The editor exited with an error; the rule was not changed.");
        return;
      }
      buffer = readFileSync(path, "utf-8");
      if (buffer.trim() === original.trim()) {
        log.info("No changes.");
        return;
      }
      const fields = parseJsonRule(buffer, "The edited rule");
      const parsed = fields.ok ? parseRule(fields.value) : null;
      // The pin survives an editor edit, unless the rule no longer goes to the proxy.
      const via = parsed?.ok && parsed.value.outboundTag === "proxy" ? current.via : undefined;
      if (parsed?.ok && saveEdit(current, { createdAt: current.createdAt, name: current.name, rule: parsed.value, via }, rules)) {
        return;
      }
      if (!fields.ok) {
        log.error(pc.red(fields.error));
      } else if (parsed && !parsed.ok) {
        log.error(pc.red(`Invalid rule:\n${parsed.error}`));
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      const again = await confirmPrompt({ default: true, message: "Edit again?" });
      if (!again) {
        setExitCode(1);
        return;
      }
    }
  } finally {
    rmSync(path, { force: true });
  }
};

const pickRule = async (rules: readonly UserRule[], given: string): Promise<UserRule | undefined> => {
  if (given.length > 0) {
    return rules.find((rule) => rule.name === given);
  }
  if (!process.stdin.isTTY) {
    return undefined;
  }
  const chosen = await selectPrompt({
    message: "Edit which rule?",
    options: rules.map((rule) => ({ hint: `→ ${rule.rule.outboundTag}`, label: rule.name, value: rule.name })),
  });
  return rules.find((rule) => rule.name === chosen);
};

export const rulesEditCommand = defineCommand({
  args: {
    ...MATCHER_ARGS,
    append: { description: "add the matcher flags' values to the rule's lists instead of replacing them", type: "boolean" },
    json: { description: "replace the whole rule with this xray rule object (keeps name and position)", type: "string" },
    name: { description: "the rule to edit", required: false, type: "positional" },
    outbound: { alias: "o", description: "where matching traffic goes: proxy, direct or block", type: "string" },
    rename: { description: "give the rule a new name", type: "string" },
    unset: {
      description: "remove a field from the rule, repeatable: domain, ip, port, network, process, ..., or via (unpin)",
      type: "string",
    },
    via: VIA_ARG,
  },
  meta: {
    description: "Edit a routing rule (flags change fields; no flags opens it in $EDITOR)",
    name: "edit",
  },
  async run({ args, rawArgs }) {
    warnAboutBareAppNames(rawArgs);
    const rules = loadRules();
    if (rules.length === 0) {
      log.info("No routing rules to edit. Add one with `masir rules add`.");
      return;
    }
    const given = typeof args.name === "string" ? args.name.trim() : "";
    const current = await pickRule(rules, given);
    if (!current) {
      fail(given.length > 0 ? `Rule "${given}" not found.` : "Name the rule to edit: `masir rules edit <name>`.");
      return;
    }

    const fromFlags = await ruleFromEditFlags(current, rules, args, rawArgs);
    if (!fromFlags.ok) {
      fail(fromFlags.error);
      return;
    }
    if (fromFlags.value) {
      if (!saveEdit(current, fromFlags.value, rules)) {
        setExitCode(1);
      }
      return;
    }
    if (!process.stdin.isTTY) {
      fail("Nothing to change: pass matcher flags, --unset, --outbound, --rename or --json (or run in a terminal to use $EDITOR).");
      return;
    }
    await editInEditor(current, rules);
  },
});
