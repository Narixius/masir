// The daemon side of the IPC protocol (see protocol.ts): decode, authorize,
// dispatch to one handler per request type, encode. `respond` is total.
import { statSync } from "node:fs";

import * as z from "zod/mini";

import { loadSettings } from "./config/settings.js";
import { getXrayGrpcClient } from "./contexts/grpc.js";
import { ipToProto, XrayType } from "./injectables/xray/types.js";
import { RequestSchema } from "./protocol.js";
import type { Request, ResponseOf, StatusResult } from "./protocol.js";
import { diagnose, probeNodes } from "./services/latency/latency-service.js";
import type { RunningXray } from "./services/latency/latency-service.js";
import { runXray } from "./services/run-xray.js";
import { resolveSyncTargets, syncSubscriptions } from "./services/subscription/daemon-sync.js";
import { setActiveNode } from "./services/subscription/storage.js";
import { xray } from "./services/xray.js";

const SHUTDOWN_DELAY_MS = 100;
const daemonStartedAt = Date.now();
const getBinaryMtime = (): number => {
  try {
    return statSync(process.execPath).mtimeMs;
  } catch {
    return 0;
  }
};
const daemonBinaryMtime = getBinaryMtime();

/* -------------------------------------------------------------------------- */
/* Request Context & Errors                                                   */
/* -------------------------------------------------------------------------- */

export interface RequestContext {
  readonly conn: number;
  readonly peerUid: number;
  readonly helperEuid: number;
  readonly helperPid: number;
  /** The one user this daemon serves: whoever started it, or whoever ran `sudo` for it. */
  readonly ownerUid: number;
}

export type HandlerError =
  | { readonly _tag: "MalformedRequest"; readonly message: string }
  | { readonly _tag: "Unauthorized"; readonly peerUid: number }
  | { readonly _tag: "ExecutionError"; readonly message: string };

export const describe = (error: HandlerError): string => (error._tag === "Unauthorized" ? "unauthorized" : error.message);

/* -------------------------------------------------------------------------- */
/* Decoding & Authorization                                                   */
/* -------------------------------------------------------------------------- */

type Decoded = { readonly ok: true; readonly request: Request } | { readonly ok: false; readonly error: HandlerError };

export const decode = (raw: string): Decoded => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { error: { _tag: "MalformedRequest", message: "invalid json" }, ok: false };
  }
  const parsed = z.safeParse(RequestSchema, value);
  if (!parsed.success) {
    return { error: { _tag: "MalformedRequest", message: `invalid request: ${z.prettifyError(parsed.error)}` }, ok: false };
  }
  return { ok: true, request: parsed.data };
};

/**
 * The socket is `0600`; this is the second lock. A daemon running as root still
 * serves only the user it was started for (`ownerUid`), plus root.
 */
export const authorize = (ctx: RequestContext): HandlerError | null =>
  ctx.peerUid === ctx.ownerUid || ctx.peerUid === 0 ? null : { _tag: "Unauthorized", peerUid: ctx.peerUid };

/* -------------------------------------------------------------------------- */
/* Handlers                                                                   */
/* -------------------------------------------------------------------------- */

/** The main xray, for testing the active proxy through the connection actually in use. */
const runningXray = (): RunningXray | null => (xray.isRunning() ? { mixedPort: loadSettings().mixedPort } : null);

/** Restart xray with the current active node, if it is running. */
const reloadIfRunning = async (): Promise<void> => {
  if (xray.isRunning()) {
    await runXray({ reload: true, tun: xray.getMode() === "tun" });
  }
};

const status = async (ctx: RequestContext): Promise<StatusResult> => {
  const running = xray.isRunning();
  const version = await xray.getVersion();
  return {
    daemon: {
      euid: ctx.helperEuid,
      pid: ctx.helperPid,
      privileged: ctx.helperEuid === 0,
      startedAt: daemonStartedAt,
    },
    xray: {
      apiPort: running ? xray.getApiPort() : undefined,
      assetsPath: xray.getAssetsPath(),
      lastError: xray.getLastError() ?? undefined,
      logFile: xray.getLogsPath().error,
      mode: running ? xray.getMode() : undefined,
      pid: xray.getXrayPid() ?? xray.getXray()?.pid,
      running,
      startedAt: xray.getStartedAt() ?? undefined,
      state: xray.getState(),
      version: version ?? undefined,
    },
  };
};

const addSocksInbound = (port: number, tag: string): ResponseOf<"inbound:add"> => {
  getXrayGrpcClient().addInbound({
    proxySettings: {
      type: XrayType.SocksServer,
      value: {
        authType: "NO_AUTH",
        udpEnabled: true,
      },
    },
    receiverSettings: {
      type: XrayType.ReceiverConfig,
      value: {
        listen: ipToProto("127.0.0.1"),
        portList: {
          range: [{ From: port, To: port }],
        },
        sniffingSettings: {
          destinationOverride: ["http", "tls", "quic", "fakedns"],
          enabled: true,
          routeOnly: false,
        },
      },
    },
    tag,
  });
  return `inbound ${tag} added`;
};

const useNode = async (id: string, subName?: string): Promise<ResponseOf<"sub:use">> => {
  if (!setActiveNode(id, subName)) {
    throw new Error(`Node with id "${id}" not found`);
  }
  await reloadIfRunning();
  return { activeNodeId: id };
};

const shutdown = (): ResponseOf<"shutdown"> => {
  // Lets the CLI replace this daemon (e.g. with a root one for TUN mode).
  // The delay gives the reply time to reach the client first.
  xray.stopXray();
  setTimeout(() => process.exit(0), SHUTDOWN_DELAY_MS);
  return "daemon shutting down";
};

/* -------------------------------------------------------------------------- */
/* Boundary                                                                   */
/* -------------------------------------------------------------------------- */

/** `T` is pinned per call site to `ResponseOf<type>`, so each case is checked against the protocol. */
const okBody = <T>(result: T): string => JSON.stringify({ ok: true, result });
const errorBody = (error: string): string => JSON.stringify({ error, ok: false });

/** Run the request and encode its result. One `case` per request type; `never` keeps it exhaustive. */
const dispatch = async (request: Request, ctx: RequestContext): Promise<string> => {
  switch (request.type) {
    case "ping": {
      return okBody<ResponseOf<"ping">>("pong");
    }
    case "echo": {
      return okBody<ResponseOf<"echo">>(request.data);
    }
    case "info": {
      return okBody<ResponseOf<"info">>({
        binaryMtime: daemonBinaryMtime,
        helperEuid: ctx.helperEuid,
        helperPid: ctx.helperPid,
        peerUid: ctx.peerUid,
        startedAt: daemonStartedAt,
      });
    }
    case "start": {
      return okBody<ResponseOf<"start">>(await runXray({ assetsPath: request.assetsPath, tun: Boolean(request.tun) }));
    }
    case "stop": {
      xray.stopXray();
      return okBody<ResponseOf<"stop">>("xray stopped");
    }
    case "shutdown": {
      return okBody<ResponseOf<"shutdown">>(shutdown());
    }
    case "status": {
      return okBody<ResponseOf<"status">>(await status(ctx));
    }
    case "inbound:list": {
      const inbounds = getXrayGrpcClient().listInbounds(Boolean(request.onlyTags)).inbounds ?? [];
      return okBody<ResponseOf<"inbound:list">>({ inbounds });
    }
    case "inbound:add": {
      return okBody<ResponseOf<"inbound:add">>(addSocksInbound(request.port, request.tag));
    }
    case "inbound:remove": {
      getXrayGrpcClient().removeInbound(request.tag);
      return okBody<ResponseOf<"inbound:remove">>(`inbound ${request.tag} removed`);
    }
    case "sub:use": {
      return okBody<ResponseOf<"sub:use">>(await useNode(request.id, request.subName));
    }
    case "reload":
    case "sub:reload": {
      await reloadIfRunning();
      return okBody<ResponseOf<"sub:reload">>("reloaded");
    }
    case "sub:update": {
      return okBody<ResponseOf<"sub:update">>(await syncSubscriptions(resolveSyncTargets(request.name)));
    }
    case "latency:probe": {
      return okBody<ResponseOf<"latency:probe">>(probeNodes(request.ids, Boolean(request.refresh)));
    }
    case "net:diagnose": {
      return okBody<ResponseOf<"net:diagnose">>(diagnose(runningXray(), Boolean(request.refresh)));
    }
    default: {
      const unhandled: never = request;
      return errorBody(`unknown request type: ${String(unhandled)}`);
    }
  }
};

export const handle = async (raw: string, ctx: RequestContext): Promise<string> => {
  const denied = authorize(ctx);
  if (denied) {
    return errorBody(describe(denied));
  }
  const decoded = decode(raw);
  if (!decoded.ok) {
    return errorBody(describe(decoded.error));
  }
  try {
    return await dispatch(decoded.request, ctx);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return errorBody(describe({ _tag: "ExecutionError", message }));
  }
};

export const respond = async (raw: string, ctx: RequestContext): Promise<string> => {
  try {
    return await handle(raw, ctx);
  } catch {
    return errorBody("internal error");
  }
};
