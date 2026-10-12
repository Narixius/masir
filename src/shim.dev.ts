import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";

const callSocket = (path: string, request: string, response: Buffer): number => {
  const nodeScript = `
import { connect } from "node:net";
const [socketPath, requestText] = process.argv.slice(1);
const socket = connect(socketPath);
socket.setEncoding("utf-8");
socket.setTimeout(10000, () => {
  socket.destroy();
  process.exit(1);
});
socket.on("error", () => process.exit(1));
socket.write(requestText + "\\n");
let data = "";
socket.on("data", (chunk) => {
  data += chunk;
  if (data.includes("\\n")) {
    process.stdout.write(data);
    socket.destroy();
    process.exit(0);
  }
});
`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", nodeScript, path, request]);
  if (res.status !== 0) {
    // IO error
    return -2;
  }
  const text = res.stdout.toString("utf-8").trimEnd();
  if (text.length > response.length) {
    // BUFFER_TOO_SMALL
    return -3;
  }
  return response.write(text, "utf-8");
};

export const setupDevPolyfills = (): void => {
  // If running compiled under scriptc, global FFI symbols are already defined.
  if (typeof (globalThis as Record<string, unknown>).masirCall === "function") {
    return;
  }

  const socketPath = process.env.MASIR_SOCKET ?? "/tmp/masir-dev.sock";
  const devHandlerPath = process.env.MASIR_DEV_HANDLER ?? "/tmp/masir-dev-handler.sock";

  const target = globalThis as Record<string, unknown>;

  // 1. masirCall / masirCallAt: connect to a socket synchronously via a node child_process
  target.masirCall = (request: string, response: Buffer): number => callSocket(socketPath, request, response);

  // 2. masirEuid: returns current user euid
  target.masirEuid = (): number => (typeof process.geteuid === "function" ? process.geteuid() : 0);

  // 4. masirServe & masirReply: dev handler over Unix domain socket
  const activeConnections = new Map<number, Socket>();
  let nextConnId = 1;

  target.masirServe = (onRequest: (conn: number, peerUid: number, request: string) => void): number => {
    try {
      unlinkSync(devHandlerPath);
    } catch {
      // stale socket cleaned
    }

    const server = createServer((socket) => {
      let buffer = "";
      let header: readonly number[] | null = null;
      const connId = nextConnId;
      nextConnId += 1;
      activeConnections.set(connId, socket);

      socket.setEncoding("utf-8");
      socket.on("error", () => {
        activeConnections.delete(connId);
      });
      socket.on("close", () => {
        activeConnections.delete(connId);
      });

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) {
            return;
          }
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);

          if (header === null) {
            header = line.split(" ").map(Number);
            continue;
          }

          const [peerUid = 0] = header;
          void Promise.resolve(onRequest(connId, peerUid, line));
          return;
        }
      });
    });

    server.listen(devHandlerPath);
    return 0;
  };

  target.masirReply = (conn: number, response: string): number => {
    const socket = activeConnections.get(conn);
    if (!socket) {
      // UNKNOWN_CONNECTION
      return -6;
    }
    activeConnections.delete(conn);
    socket.end(`${response}\n`);
    return 0;
  };

  // 5. xrayGrpcCall & xrayGrpcLastError: dev polyfill using executeDevGrpcCall in a synchronous worker
  let lastXrayError = "";

  target.xrayGrpcCall = (addr: string, method: string, reqJson: string, out: Buffer): number => {
    const workerScript = `
import { executeDevGrpcCall } from "./src/injectables/xray/dev.ts";
const [addr, method, reqJson] = process.argv.slice(1);
executeDevGrpcCall(addr, method, reqJson)
  .then((res) => {
    process.stdout.write(res);
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(err?.message ?? String(err));
    process.exit(1);
  });
`;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", workerScript, addr, method, reqJson], {
      maxBuffer: 16 * 1024 * 1024,
    });

    if (res.status !== 0) {
      lastXrayError = res.stderr.toString("utf-8");
      // GRPC_STATUS or call failure
      return -106;
    }

    const outputText = res.stdout.toString("utf-8");
    const outputBytes = Buffer.from(outputText, "utf-8");
    if (outputBytes.length > out.length) {
      lastXrayError = `buffer too small: required ${outputBytes.length}`;
      // BUFFER_TOO_SMALL
      return -103;
    }

    outputBytes.copy(out);
    return outputBytes.length;
  };

  target.xrayGrpcLastError = (out: Buffer): number => {
    const errBytes = Buffer.from(lastXrayError, "utf-8");
    if (errBytes.length > out.length) {
      return -103;
    }
    errBytes.copy(out);
    return errBytes.length;
  };

  // 6. Native prompt polyfills for dev
  target.masirPromptConfirm = (_msg: string, defaultVal: number): number => defaultVal;
  target.masirPromptSelect = (_msg: string, _optionsJson: string, defaultIdx: number): number => Math.max(defaultIdx, 0);
  target.masirPromptMultiselect = (_msg: string, _optionsJson: string, defaultsJson: string, out: Buffer): number => {
    const bytes = Buffer.from(defaultsJson || "[]", "utf-8");
    bytes.copy(out);
    return bytes.length;
  };
  target.masirPromptText = (_msg: string, defaultVal: string, out: Buffer): number => {
    const bytes = Buffer.from(defaultVal || "", "utf-8");
    bytes.copy(out);
    return bytes.length;
  };
  // -3 = not interactive: callers fall back to their default choice.
  target.masirPromptLiveSelectStart = (_msg: string, _optionsJson: string, _defaultIdx: number, _flags: number): number => -3;
  target.masirPromptLiveSelectSelection = (_out: Buffer): number => -2;
  // Dev: no geo data decoding (the native build reads geosite.dat / geoip.dat).
  target.masirGeoList = (_path: string, _kind: number, _out: Buffer): number => -2;
  target.masirGeoHumanize = (_code: string, _out: Buffer): number => -2;
  target.masirPromptLiveSelectSet = (_idx: number, _text: string, _loading: number): number => -2;
  target.masirPromptLiveSelectPoll = (): number => -2;
  target.masirPromptLiveSelectViewport = (_out: Buffer): number => -2;
  // Dev: no reordering (returns an error, so callers keep the original text).
  target.masirTextVisual = (_text: string, _out: Buffer): number => -2;
  target.masirTerminalColumns = (): number => process.stdout.columns ?? 0;
  // Dev: process list from ps(1) (the native build uses sysinfo).
  target.masirListProcesses = (out: Buffer): number => {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf-8" });
    const processes = (result.stdout ?? "")
      .split("\n")
      .map((line) => /^(?<pid>\d+)\s+(?<ppid>\d+)\s+(?<comm>.+)$/u.exec(line.trim())?.groups)
      .filter((groups): groups is Record<string, string> => groups !== undefined)
      .map(({ pid, ppid, comm }) => ({
        exe: comm?.startsWith("/") ? comm : undefined,
        name: comm?.split("/").pop() ?? "",
        pid: Number(pid),
        ppid: Number(ppid),
      }));
    const bytes = Buffer.from(JSON.stringify(processes), "utf-8");
    if (bytes.length > out.length) {
      return -3;
    }
    bytes.copy(out);
    return bytes.length;
  };
};

setupDevPolyfills();
