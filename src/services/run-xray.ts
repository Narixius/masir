import { loadSettings, saveAssetsPath } from "../config/settings.js";
import type { ReconcileResult } from "../protocol.js";
import { configManager, toXrayOutbound } from "./config-manager.js";
import { routingForRules } from "./rules/pins.js";
import { loadRules } from "./rules/storage.js";
import { getActiveNode } from "./subscription/storage.js";

export interface RunXrayOptions {
  readonly tun?: boolean;
  readonly assetsPath?: string;
  /** Restart a running xray so it picks up a changed active node or rules. */
  readonly reload?: boolean;
}

export const runXray = async (options?: RunXrayOptions): Promise<ReconcileResult> => {
  const activeNode = getActiveNode();
  if (!activeNode) {
    throw new Error("No active proxy. Run `masir sub use` first.");
  }
  const settings = options?.assetsPath ? saveAssetsPath(options.assetsPath) : loadSettings();
  const tun = Boolean(options?.tun);
  const routing = routingForRules(loadRules(), activeNode.outbound.id);
  const desiredConfig = configManager.buildDesiredConfig({
    activeOutbound: toXrayOutbound(activeNode.outbound),
    extraOutbounds: routing.outbounds,
    settings,
    tun,
    userRules: routing.userRules,
  });
  return await configManager.reconcile(desiredConfig, { reload: options?.reload, settings, tun });
};
