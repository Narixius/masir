import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";

import { loadSettings } from "../config/settings.js";
import type { ResponseOf } from "../protocol.js";
import { configManager, toXrayOutbound } from "../services/config-manager.js";
import type { XrayOutbound } from "../services/config-manager.js";
import { routingForRules } from "../services/rules/pins.js";
import { loadRules } from "../services/rules/storage.js";
import { getActiveNode } from "../services/subscription/storage.js";
import { getAppDirs } from "../utils/fs.js";
import { tryCallHelper } from "../utils/ipc.js";

const PLACEHOLDER_PROXY: XrayOutbound = { protocol: "freedom", tag: "proxy" };

const readRunningConfig = (): string | null => {
  const statusRes = tryCallHelper<ResponseOf<"status">>({ type: "status" });
  if (!statusRes?.ok || !statusRes.result.xray.running) {
    return null;
  }
  const configPath = join(getAppDirs().data, "xray.config.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return null;
  }
};

const buildFallbackConfig = (): string => {
  const settings = loadSettings();
  const activeNode = getActiveNode();
  const rules = loadRules();
  const routing = routingForRules(rules, activeNode?.outbound.id);
  const desiredConfig = configManager.buildDesiredConfig({
    activeOutbound: activeNode ? toXrayOutbound(activeNode.outbound) : PLACEHOLDER_PROXY,
    extraOutbounds: routing.outbounds,
    settings,
    tun: false,
    userRules: routing.userRules,
  });
  return JSON.stringify(desiredConfig, null, 2);
};

export const getConfigCommand = defineCommand({
  meta: {
    alias: ["config"],
    description: "Print the current Xray JSON configuration",
    name: "get-config",
  },
  run() {
    const runningConfig = readRunningConfig();
    console.log(runningConfig ?? buildFallbackConfig());
  },
});
