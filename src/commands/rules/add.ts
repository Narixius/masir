import { defineCommand } from "citty";

import { parseRule } from "../../services/rules/schema.js";
import type { RawRule, UserRule, XrayRuleJson } from "../../services/rules/schema.js";
import { insertRule, loadRules, withRuleInserted } from "../../services/rules/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { note } from "../../utils/log.js";
import { textPrompt } from "../../utils/prompts.js";
import { describeRule } from "./describe.js";
import {
  addProcesses,
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
import type { RuleTarget, Step } from "./shared.js";
import { runAddWizard } from "./wizard.js";
import type { WizardPreset } from "./wizard.js";

/** Matchers from `--json` or the flags (not both). */
const readMatchers = (jsonText: string, rawArgs: readonly string[]): Step<RawRule> => {
  if (jsonText.length === 0) {
    return { ok: true, value: definedFields(ruleFromFlags(rawArgs)) };
  }
  if (usesMatcherFlags(rawArgs)) {
    return { error: "Use either --json or matcher flags (--domain, --ip, ...), not both.", ok: false };
  }
  return parseJsonRule(jsonText);
};

const resolveName = async (given: string, existing: readonly UserRule[]): Promise<Step<string>> => {
  let name = given.trim();
  if (name.length === 0 && process.stdin.isTTY) {
    const typed = await textPrompt({ message: "Rule name", placeholder: "e.g. iran-direct" });
    name = typed.trim();
  }
  const checked = checkName(name, existing);
  if (!checked.ok && existing.some((rule) => rule.name === name)) {
    return { error: `${checked.error} Change it with \`masir rules edit ${name}\` or remove it first.`, ok: false };
  }
  return checked;
};

const resolvePosition = (given: string): Step<number | undefined> => {
  const value = given.trim();
  if (value.length === 0) {
    return { ok: true, value: undefined };
  }
  const position = Number(value);
  return Number.isInteger(position) && position >= 1
    ? { ok: true, value: position }
    : { error: "--position must be a whole number from 1.", ok: false };
};

/** The non-matcher flags `buildRule` reads (matchers come from the raw argv). */
interface AddArgs {
  readonly name?: string;
  readonly json?: string;
  readonly outbound?: string;
  readonly position?: string;
  readonly via?: string;
}

/** Everything the flags describe, validated: the rule, its name, and where it goes. */
const buildRule = async (
  args: AddArgs,
  rawArgs: readonly string[],
  existing: readonly UserRule[]
): Promise<Step<{ readonly rule: UserRule; readonly position?: number }>> => {
  const name = await resolveName(text(args.name), existing);
  if (!name.ok) {
    return name;
  }
  const matchers = readMatchers(text(args.json), rawArgs);
  if (!matchers.ok) {
    return matchers;
  }
  const app = await resolveAppProcesses(rawArgs);
  if (!app.ok) {
    return app;
  }
  if (app.value) {
    addProcesses(matchers.value, app.value);
  }
  const fromJson = matchers.value["outboundTag"];
  const target = await resolveTarget(text(args.outbound) || (typeof fromJson === "string" ? fromJson : ""), text(args.via));
  if (!target.ok) {
    return target;
  }
  const position = resolvePosition(text(args.position));
  if (!position.ok) {
    return position;
  }
  matchers.value["outboundTag"] = target.value.outbound;
  const parsed = parseRule(matchers.value);
  if (!parsed.ok) {
    return { error: `Invalid rule:\n${parsed.error}`, ok: false };
  }
  const rule: XrayRuleJson = parsed.value;
  return { ok: true, value: { position: position.value, rule: { createdAt: Date.now(), name: name.value, rule, via: target.value.via } } };
};

/** Flags given alongside the wizard fill their steps; the wizard asks for the rest. */
const wizardPreset = async (args: AddArgs, existing: readonly UserRule[]): Promise<Step<WizardPreset>> => {
  let name: string | undefined;
  if (text(args.name).trim().length > 0) {
    const checked = checkName(text(args.name).trim(), existing);
    if (!checked.ok) {
      return checked;
    }
    name = checked.value;
  }
  let target: RuleTarget | undefined;
  if (text(args.outbound).length > 0 || text(args.via).length > 0) {
    const resolved = await resolveTarget(text(args.outbound), text(args.via));
    if (!resolved.ok) {
      return resolved;
    }
    target = resolved.value;
  }
  const position = resolvePosition(text(args.position));
  if (!position.ok) {
    return position;
  }
  return { ok: true, value: { name, position: position.value, target } };
};

const addWithWizard = async (args: AddArgs, existing: readonly UserRule[]): Promise<void> => {
  const preset = await wizardPreset(args, existing);
  if (!preset.ok) {
    fail(preset.error);
    return;
  }
  const result = await runAddWizard(existing, preset.value);
  if (!result) {
    return;
  }
  try {
    insertRule(result.rule, result.position);
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const placed = loadRules().findIndex((stored) => stored.name === result.rule.name) + 1;
  note(describeRule(result.rule, placed).join("\n"), "Rule added");
  applyToDaemon();
};

export const rulesAddCommand = defineCommand({
  args: {
    ...MATCHER_ARGS,
    json: { description: 'a raw xray rule object instead of matcher flags, e.g. \'{"domain":["geosite:google"]}\'', type: "string" },
    name: { description: "unique rule name (letters, digits, - and _)", type: "string" },
    outbound: { alias: "o", description: "where matching traffic goes: proxy, direct or block", type: "string" },
    position: { description: "1-based place in the list (rules match top to bottom; default: last)", type: "string" },
    via: VIA_ARG,
  },
  meta: {
    description: "Add a routing rule: step by step in a terminal, or with flags / --json",
    name: "add",
  },
  async run({ args, rawArgs }) {
    warnAboutBareAppNames(rawArgs);
    const existing = loadRules();
    if (process.stdin.isTTY && text(args.json).length === 0 && !usesMatcherFlags(rawArgs)) {
      await addWithWizard(args, existing);
      return;
    }
    const built = await buildRule(args, rawArgs, existing);
    if (!built.ok) {
      fail(built.error);
      return;
    }
    const { rule, position } = built.value;
    if (xrayRejection(withRuleInserted(existing, rule, position)) !== null) {
      setExitCode(1);
      return;
    }
    try {
      insertRule(rule, position);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    const placed = loadRules().findIndex((stored) => stored.name === rule.name) + 1;
    note(describeRule(rule, placed).join("\n"), "Rule added");
    applyToDaemon();
  },
});
