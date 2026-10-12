// User routing rules on disk: `rules.json` in the data dir, in match order
// (xray stops at the first rule that matches). Written by the CLI; the daemon
// reads it whenever it builds an xray config.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAppDirs, withFileLock, writeFileEnsured } from "../../utils/fs.js";
import { parseRule, userRuleTag } from "./schema.js";
import type { RawRule, RuleVia, UserRule, XrayRuleJson } from "./schema.js";

/** One entry of `rules.json` as read from disk, before validation. */
interface StoredEntry {
  readonly name?: unknown;
  readonly rule?: RawRule;
  readonly createdAt?: number;
  readonly via?: { readonly nodeId?: unknown; readonly subName?: unknown };
}

const storedVia = (entry: StoredEntry): RuleVia | undefined => {
  const nodeId = entry.via?.nodeId;
  if (typeof nodeId !== "string" || nodeId.length === 0) {
    return undefined;
  }
  const subName = entry.via?.subName;
  return typeof subName === "string" ? { nodeId, subName } : { nodeId };
};

interface StoredFile {
  readonly rules?: StoredEntry[];
}

const rulesPath = (): string => join(getAppDirs().data, "rules.json");
const withRulesLock = <T>(fn: () => T): T => withFileLock(join(getAppDirs().data, "rules.lock"), fn);

/** Stored rules in match order. Entries that no longer validate are skipped rather than fed to xray. */
export const loadRules = (): UserRule[] => {
  const path = rulesPath();
  if (!existsSync(path)) {
    return [];
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
  // Untrusted file contents: the shape is only assumed here, every entry is re-validated below.
  const entries = (raw as StoredFile | null)?.rules;
  if (!Array.isArray(entries)) {
    return [];
  }
  const rules: UserRule[] = [];
  for (const entry of entries) {
    const parsed = entry.rule ? parseRule(entry.rule) : null;
    if (typeof entry.name === "string" && parsed?.ok) {
      rules.push({ createdAt: entry.createdAt ?? 0, name: entry.name, rule: parsed.value, via: storedVia(entry) });
    }
  }
  return rules;
};

const saveRules = (rules: readonly UserRule[]): void => {
  writeFileEnsured(rulesPath(), JSON.stringify({ rules }, null, 2));
};

/** Where `rule` would land (1-based `position`, default last) among `rules`; does not save. */
export const withRuleInserted = (rules: readonly UserRule[], rule: UserRule, position?: number): UserRule[] => {
  const next = rules.filter((existing) => existing.name !== rule.name);
  const index = position === undefined ? next.length : Math.min(Math.max(position - 1, 0), next.length);
  next.splice(index, 0, rule);
  return next;
};

/** Store `rule` at `position` (1-based; default last). Fails if the name is taken. */
export const insertRule = (rule: UserRule, position?: number): void => {
  withRulesLock(() => {
    const rules = loadRules();
    if (rules.some((existing) => existing.name === rule.name)) {
      throw new Error(`A rule named "${rule.name}" already exists`);
    }
    saveRules(withRuleInserted(rules, rule, position));
  });
};

/** `rules` with the rule named `name` swapped for `rule`, keeping its place; does not save. */
export const withRuleReplaced = (rules: readonly UserRule[], name: string, rule: UserRule): UserRule[] =>
  rules.map((existing) => (existing.name === name ? rule : existing));

/** `rules` with the rule named `name` moved to 1-based `position` (last when undefined); does not save. */
export const withRuleMoved = (rules: readonly UserRule[], name: string, position: number | undefined): UserRule[] => {
  const rule = rules.find((existing) => existing.name === name);
  return rule ? withRuleInserted(rules, rule, position) : [...rules];
};

/**
 * Swap the rule named `name` for `rule` (which may carry a new name), keeping
 * its position, or moving it to `position` when given (`"last"` for the end).
 */
export const replaceRule = (name: string, rule: UserRule, position?: number | "last"): void => {
  withRulesLock(() => {
    const rules = loadRules();
    if (!rules.some((existing) => existing.name === name)) {
      throw new Error(`Rule "${name}" not found`);
    }
    if (rule.name !== name && rules.some((existing) => existing.name === rule.name)) {
      throw new Error(`A rule named "${rule.name}" already exists`);
    }
    const replaced = withRuleReplaced(rules, name, rule);
    saveRules(position === undefined ? replaced : withRuleMoved(replaced, rule.name, position === "last" ? undefined : position));
  });
};

/** Remove rules by name; returns the names that existed. */
export const removeRules = (names: readonly string[]): string[] =>
  withRulesLock(() => {
    const rules = loadRules();
    const removed = rules.filter((rule) => names.includes(rule.name)).map((rule) => rule.name);
    if (removed.length > 0) {
      saveRules(rules.filter((rule) => !names.includes(rule.name)));
    }
    return removed;
  });

/** A rule as it goes into xray's `routing.rules`: tagged with its name. */
export interface TaggedXrayRule extends Omit<XrayRuleJson, "outboundTag"> {
  readonly ruleTag: string;
  /** "proxy", "direct", "block", or a pinned node's `node-<id>`. */
  readonly outboundTag: string;
}

/**
 * The rules as xray gets them. `outboundFor` maps a pinned rule to its node's
 * outbound tag (see pins.ts); without one, or when it has no answer, the rule
 * keeps its own outbound ("proxy" for pinned rules: the active proxy).
 */
export const toXrayRules = (rules: readonly UserRule[], outboundFor?: (rule: UserRule) => string | undefined): TaggedXrayRule[] =>
  rules.map((rule) => ({ ...rule.rule, outboundTag: outboundFor?.(rule) ?? rule.rule.outboundTag, ruleTag: userRuleTag(rule.name) }));

/** Node ids rules are pinned to (to know when a subscription update must reload xray). */
export const pinnedNodeIds = (rules: readonly UserRule[]): string[] => {
  const ids: string[] = [];
  for (const rule of rules) {
    if (rule.via && !ids.includes(rule.via.nodeId)) {
      ids.push(rule.via.nodeId);
    }
  }
  return ids;
};
