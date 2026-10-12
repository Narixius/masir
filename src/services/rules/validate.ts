// Check a candidate rule set with xray itself before it is saved: an unknown
// `geosite:` category or a broken `regexp:` makes xray refuse the whole config,
// which would take the running proxy down on the next reload.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { loadSettings, resolveAssetsPath } from "../../config/settings.js";
import { getAppDirs, writeFileEnsured } from "../../utils/fs.js";
import { configManager, toXrayOutbound } from "../config-manager.js";
import type { XrayOutbound } from "../config-manager.js";
import { getActiveNode } from "../subscription/storage.js";
import { routingForRules } from "./pins.js";
import type { UserRule } from "./schema.js";

const TEST_TIMEOUT_MS = 15_000;
const FAILURE_MARKER = "Failed to start:";
/** Stand-in when no proxy is selected yet: rules are checked the same way. */
const PLACEHOLDER_PROXY: XrayOutbound = { protocol: "freedom", tag: "proxy" };

export type XrayCheck =
  | { readonly status: "ok" }
  | { readonly status: "invalid"; readonly reason: string }
  /** xray could not be run (not installed?): the rule is not known to be bad. */
  | { readonly status: "unchecked"; readonly reason: string };

/**
 * xray's error is a `module: message > module: message > ...` chain, prefixed
 * by the config path. Keep the specific tail without module prefixes, e.g.
 * `illegal domain rule: geosite:foo > failed to check code FOO from geosite.dat`.
 */
const readableReason = (output: string): string => {
  const line = output.split("\n").find((l) => l.includes(FAILURE_MARKER)) ?? output.trim().split("\n").pop() ?? "";
  const chain = line.slice(line.indexOf(FAILURE_MARKER) + FAILURE_MARKER.length).split(" > ");
  const messages = chain
    .map((part) => part.replace(/^\s*[a-z/]+: /u, "").trim())
    .filter((part) => part.length > 0 && part !== "EOF" && !part.startsWith("main:") && !part.startsWith("failed to load config"));
  return messages.slice(-2).join(" > ") || line.trim();
};

export const checkRulesWithXray = (rules: readonly UserRule[]): XrayCheck => {
  const settings = loadSettings();
  const active = getActiveNode();
  const routing = routingForRules(rules, active?.outbound.id);
  const config = configManager.buildDesiredConfig({
    activeOutbound: active ? toXrayOutbound(active.outbound) : PLACEHOLDER_PROXY,
    extraOutbounds: routing.outbounds,
    settings,
    tun: false,
    userRules: routing.userRules,
  });
  const path = join(getAppDirs().data, `rules-check.${process.pid}.json`);
  writeFileEnsured(path, JSON.stringify({ ...config, log: { loglevel: "warning" } }, null, 2));
  try {
    // The asset dir goes through env(1): scriptc's spawnSync has no `env` option.
    const assets = `XRAY_LOCATION_ASSET=${resolveAssetsPath(settings.xrayAssetsPath, settings.xrayExecutable)}`;
    const result = spawnSync("/usr/bin/env", [assets, settings.xrayExecutable, "run", "-test", "-c", path], {
      encoding: "utf-8",
      timeout: TEST_TIMEOUT_MS,
    });
    if (result.error) {
      return { reason: `could not run ${settings.xrayExecutable}: ${result.error.message}`, status: "unchecked" };
    }
    if (result.status === 0) {
      return { status: "ok" };
    }
    return { reason: readableReason(`${result.stdout ?? ""}\n${result.stderr ?? ""}`), status: "invalid" };
  } finally {
    rmSync(path, { force: true });
  }
};
