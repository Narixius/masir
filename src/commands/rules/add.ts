import { defineCommand } from "citty";
import pc from "picocolors";

import { parseRule } from "../../services/rules/schema.js";
import type { RawRule, UserRule, XrayRuleJson } from "../../services/rules/schema.js";
import { insertRule, loadRules, withRuleInserted } from "../../services/rules/storage.js";
import { setExitCode } from "../../utils/exit-code.js";
import { textPrompt } from "../../utils/prompts.js";
import { coloredTarget, matcherTreeItems } from "./describe.js";
import {
  addProcesses,
  checkName,
  definedFields,
  fail,
  MATCHER_ARGS,
  parseJsonRule,
  reloadDaemon,
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

/** The non-matcher flags `buildRule` reads (matchers come from the raw argv). */
interface AddArgs {
  readonly name?: string;
  readonly json?: string;
  readonly outbound?: string;
  readonly via?: string;
}

/** Everything the flags describe, validated: the rule, its name, and where it goes. */
const buildRule = async (args: AddArgs, rawArgs: readonly string[], existing: readonly UserRule[]): Promise<Step<UserRule>> => {
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
  matchers.value["outboundTag"] = target.value.outbound;
  const parsed = parseRule(matchers.value);
  if (!parsed.ok) {
    return { error: `Invalid rule:\n${parsed.error}`, ok: false };
  }
  const rule: XrayRuleJson = parsed.value;
  return { ok: true, value: { createdAt: Date.now(), name: name.value, rule, via: target.value.via } };
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
  return { ok: true, value: { name, target } };
};

const reportRuleAdded = (rule: UserRule): void => {
  const reload = reloadDaemon();
  const reloadMsg = reload.ok ? pc.dim(`(${reload.message})`) : pc.yellow(`(${reload.message})`);
  const header = `${pc.green("✔")} Rule "${pc.bold(rule.name)}" ${pc.dim("→")} ${coloredTarget(rule)} added ${reloadMsg}`;
  const lines = [header];
  const items = matcherTreeItems(rule.rule);
  for (const [i, item] of items.entries()) {
    const isLast = i === items.length - 1;
    const branch = isLast ? pc.dim("└─") : pc.dim("├─");
    lines.push(`  ${branch} ${pc.gray(`${item.label}:`)} ${item.value}`);
  }
  console.log(lines.join("\n"));
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
    insertRule(result.rule);
  } catch (error: unknown) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  reportRuleAdded(result.rule);
};

export const rulesAddCommand = defineCommand({
  args: {
    ...MATCHER_ARGS,
    json: { description: 'a raw xray rule object instead of matcher flags, e.g. \'{"domain":["geosite:google"]}\'', type: "string" },
    name: { description: "unique rule name (letters, digits, - and _)", type: "string" },
    outbound: { alias: "o", description: "where matching traffic goes: proxy, direct or block", type: "string" },
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
    const rule = built.value;
    if (xrayRejection(withRuleInserted(existing, rule)) !== null) {
      setExitCode(1);
      return;
    }
    try {
      insertRule(rule);
    } catch (error: unknown) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    reportRuleAdded(rule);
  },
});
