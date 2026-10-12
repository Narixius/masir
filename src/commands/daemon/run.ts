import { defineCommand } from "citty";

import { fromNativeCode, nativeErrorName } from "../../errors.js";
import { respond } from "../../handlers.js";
import { nativeTransport } from "../../native.js";
import { killProbeXrayNow } from "../../services/latency/probe-xray.js";
import { installShutdownHooks, onShutdown } from "../../services/shutdown.js";
import { startSubscriptionSyncDaemon } from "../../services/subscription/daemon-sync.js";
import { xray } from "../../services/xray.js";

/**
 * The user this daemon serves. A daemon started with `sudo` (or by the installed
 * service) runs as root but belongs to a normal user, passed via `SUDO_UID` or
 * `MASIR_ALLOWED_UID`; otherwise it belongs to whoever runs it.
 */
const daemonOwnerUid = (): number => {
  const fromEnv = Number(process.env.MASIR_ALLOWED_UID ?? process.env.SUDO_UID);
  return fromEnv > 0 ? fromEnv : nativeTransport.euid();
};

export const runDaemonCommand = defineCommand({
  meta: {
    description: "Run the masir daemon in the foreground (masir starts it for you)",
    hidden: true,
    name: "run",
  },
  run() {
    onShutdown(xray.stopXray);
    onShutdown(killProbeXrayNow);
    installShutdownHooks();
    const rc = nativeTransport.serve((conn, peerUid, request) => {
      void respond(request, {
        conn,
        helperEuid: nativeTransport.euid(),
        helperPid: process.pid,
        ownerUid: daemonOwnerUid(),
        peerUid,
      }).then((response) => {
        nativeTransport.reply(conn, response);
      });
    });

    if (rc < 0) {
      const err = fromNativeCode(rc);
      console.error(`Failed to bind daemon socket: ${nativeErrorName(err)} (${rc})`);
      process.exit(2);
    }

    startSubscriptionSyncDaemon();
  },
});
