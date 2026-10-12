// Dev-only TypeScript handler process.
//
// Listens on MASIR_DEV_HANDLER, receives requests forwarded by the persistent
// Rust broker (native/src/bin/masir-dev-broker.rs), runs the same
// `respond` boundary used by the native helper, and replies. Run it under a watcher
// (`tsx watch`) so TypeScript edits reload this process while the broker — and
// the public socket — stay up.

import { unlinkSync } from "node:fs";
import { createServer } from "node:net";

import { respond } from "./handlers.js";
import type { RequestContext } from "./handlers.js";
import { killProbeXrayNow } from "./services/latency/probe-xray.js";
import { installShutdownHooks, onShutdown } from "./services/shutdown.js";
import { xray } from "./services/xray.js";

onShutdown(xray.stopXray);
onShutdown(killProbeXrayNow);
installShutdownHooks();

const path = process.env.MASIR_DEV_HANDLER ?? "/tmp/masir-dev-handler.sock";

try {
  unlinkSync(path);
} catch {
  // no stale socket
}

const run = async (request: string, header: readonly number[]): Promise<string> => {
  const [peerUid = 0, helperEuid = 0, helperPid = 0] = header;
  const ctx: RequestContext = { conn: 0, helperEuid, helperPid, ownerUid: helperEuid, peerUid };
  return await respond(request, ctx);
};

const server = createServer((socket) => {
  let buffer = "";
  let header: readonly number[] | null = null;

  socket.setEncoding("utf-8");
  socket.on("error", (error) => {
    console.error(`handler client error: ${error.message}`);
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) {
      return;
    }

    if (header === null) {
      const firstLine = buffer.slice(0, newline);
      header = firstLine.split(" ").map(Number);
      buffer = buffer.slice(newline + 1);
    }

    const nextNewline = buffer.indexOf("\n");
    if (nextNewline === -1) {
      return;
    }

    const requestLine = buffer.slice(0, nextNewline);
    buffer = buffer.slice(nextNewline + 1);

    const activeHeader = header;
    void run(requestLine, activeHeader).then((res) => {
      socket.end(`${res}\n`);
    });
  });
});

server.listen(path, () => {
  console.error(`masir dev handler listening on ${path}`);
});
