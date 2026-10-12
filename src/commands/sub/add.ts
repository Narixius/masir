import { defineCommand } from "citty";
import pc from "picocolors";

import type { ResponseOf } from "../../protocol.js";
import { fetchAndParseSubscription } from "../../services/subscription/parser.js";
import {
  findNameConflict,
  getActiveNodeId,
  getSubscription,
  saveSubscription,
  setActiveNode,
} from "../../services/subscription/storage.js";
import { SUBSCRIPTION_FORMAT_VERSION } from "../../services/subscription/types.js";
import type { SubscriptionMeta } from "../../services/subscription/types.js";
import { setExitCode } from "../../utils/exit-code.js";
import { tryCallHelper } from "../../utils/ipc.js";
import { createLatencyClient, latencyRefresher } from "../../utils/latency-client.js";
import { log } from "../../utils/log.js";
import { confirmPrompt, liveSelectPrompt, textPrompt } from "../../utils/prompts.js";
import { createSpinner } from "../../utils/spinner.js";
import { displayLabel } from "../../utils/terminal-text.js";

export const subAddCommand = defineCommand({
  args: {
    name: {
      description: "Name identifier for the subscription",
      type: "string",
    },
    url: {
      description: "Subscription URL",
      required: false,
      type: "positional",
    },
  },
  meta: {
    description: "Add a new subscription by URL",
    name: "add",
  },
  async run({ args }) {
    let name = typeof args.name === "string" ? args.name.trim() : "";
    if (name.length === 0) {
      if (!process.stdin.isTTY) {
        log.error(pc.red("Missing required --name option."));
        setExitCode(1);
        return;
      }
      const nameInput = await textPrompt({
        message: "Enter subscription name",
        placeholder: "e.g. premium-vip",
      });
      if (nameInput.trim().length === 0) {
        return;
      }
      name = nameInput.trim();
    }

    let url = typeof args.url === "string" ? args.url.trim() : "";
    if (url.length === 0) {
      if (!process.stdin.isTTY) {
        log.error(pc.red("Missing required subscription URL."));
        setExitCode(1);
        return;
      }
      const urlInput = await textPrompt({
        message: "Enter subscription URL",
        placeholder: "https://...",
      });
      if (urlInput.trim().length === 0) {
        return;
      }
      url = urlInput.trim();
    }

    if (getSubscription(name)) {
      log.error(pc.red(`Subscription "${name}" already exists. Use "masir sub update --name ${name}" to refresh it.`));
      setExitCode(1);
      return;
    }
    const conflict = findNameConflict(name);
    if (conflict) {
      log.error(pc.red(`Subscription name "${name}" clashes with existing "${conflict}"; choose another name.`));
      setExitCode(1);
      return;
    }

    const s = createSpinner();
    s.start(`Fetching and parsing subscription "${name}"...`);

    try {
      const { outbounds, userinfo } = await fetchAndParseSubscription(url);
      const meta: SubscriptionMeta = {
        createdAt: Date.now(),
        formatVersion: SUBSCRIPTION_FORMAT_VERSION,
        name,
        nodeCount: outbounds.length,
        updatedAt: Date.now(),
        url,
        userinfo,
      };

      saveSubscription(meta, outbounds);
      s.stop(pc.green(`Subscription "${name}" added successfully (${outbounds.length} configs parsed).`));

      const hasActive = Boolean(getActiveNodeId());
      const promptMessage = hasActive ? "Change active outbound to one of the newly added configs?" : "Set active outbound now?";

      const pickNow = await confirmPrompt({
        default: !hasActive,
        message: promptMessage,
      });

      if (pickNow) {
        const rows = outbounds.map((ob) => ({ header: false, label: `${displayLabel(ob)} ${pc.dim(ob.protocol)}`, value: ob.id }));

        const latency = createLatencyClient();
        let selectedId: string;
        try {
          selectedId = await liveSelectPrompt({
            message: "Select active outbound config",
            refresh: latencyRefresher(
              latency,
              outbounds.map((ob) => ob.id)
            ),
            rows,
          });
        } finally {
          await latency.close();
        }

        // A running daemon owns the state: it records the choice and reloads xray.
        const res = tryCallHelper<ResponseOf<"sub:use">>({ id: selectedId, subName: name, type: "sub:use" });
        if (res && !res.ok) {
          throw new Error(`could not activate node: ${res.error}`);
        }
        if (!res) {
          setActiveNode(selectedId, name);
        }
        log.success(pc.green(`Active outbound configured to node [${selectedId}].`));
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      s.error(pc.red(`Failed to add subscription: ${msg}`));
      setExitCode(1);
    }
  },
});
