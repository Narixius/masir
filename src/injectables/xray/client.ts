// Scriptc FFI declarations for Xray gRPC.
// Under tsx dev, these resolve to globals installed by src/shim.dev.ts.
import type {
  AddInboundRequest,
  AddOutboundRequest,
  AddRuleRequest,
  AlterInboundRequest,
  AlterOutboundRequest,
  BalancerInfoResponse,
  GetInboundUserRequest,
  GetInboundUserResponse,
  GetInboundUsersCountResponse,
  GetStatsRequest,
  GetStatsResponse,
  InboundHandlerConfig,
  ListInboundsRequest,
  ListInboundsResponse,
  ListOutboundsRequest,
  ListOutboundsResponse,
  ListRuleResponse,
  OnlineIpListResponse,
  OnlineUsersResponse,
  OutboundHandlerConfig,
  OutboundStatusResponse,
  QueryStatsRequest,
  QueryStatsResponse,
  RemoveInboundRequest,
  RemoveOutboundRequest,
  RemoveRuleRequest,
  RoutingRule,
  SysStatsResponse,
  TestRouteRequest,
  TypedMessage,
  XrayClient,
} from "./types.js";

declare function xrayGrpcCall(addr: string, method: string, reqJson: string, out: Buffer): number;

declare function xrayGrpcLastError(out: Buffer): number;

const getLastError = (): string => {
  const buf = Buffer.alloc(1024);
  const len = xrayGrpcLastError(buf);
  if (len <= 0) {
    return "unknown error";
  }
  return buf.toString("utf-8", 0, len);
};

export const xrayCallRaw = (addr: string, method: string, reqJson = "{}"): string => {
  // 64KB initial buffer
  let bufSize = 64 * 1024;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const buf = Buffer.alloc(bufSize);
    const code = xrayGrpcCall(addr, method, reqJson, buf);
    if (code >= 0) {
      return buf.toString("utf-8", 0, code);
    }
    // BUFFER_TOO_SMALL is -103
    if (code === -103) {
      bufSize *= 4;
      continue;
    }
    const errDetail = getLastError();
    throw new Error(`Xray gRPC error (${code}): ${errDetail}`);
  }
  throw new Error("Xray gRPC response exceeded maximum retry buffer size");
};

const callMethod = <TReq, TRes>(addr: string, method: string, req: TReq): TRes => {
  const reqJson = JSON.stringify(req);
  const resJson = xrayCallRaw(addr, method, reqJson);
  const text = resJson && resJson.trim().length > 0 ? resJson : "{}";
  return JSON.parse(text) as TRes;
};

export const createXrayClient = (addr = "127.0.0.1:10085"): XrayClient => ({
  // Proxyman / HandlerService
  addInbound: (inbound: InboundHandlerConfig): void => {
    callMethod<AddInboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/AddInbound", { inbound });
  },
  alterInbound: (tag: string, operation: TypedMessage): void => {
    callMethod<AlterInboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/AlterInbound", {
      operation,
      tag,
    });
  },
  getInboundUsers: (tag: string, email: string): GetInboundUserResponse =>
    callMethod<GetInboundUserRequest, GetInboundUserResponse>(addr, "/xray.app.proxyman.command.HandlerService/GetInboundUsers", {
      email,
      tag,
    }),
  getInboundUsersCount: (tag: string, email: string): GetInboundUsersCountResponse =>
    callMethod<GetInboundUserRequest, GetInboundUsersCountResponse>(
      addr,
      "/xray.app.proxyman.command.HandlerService/GetInboundUsersCount",
      { email, tag }
    ),
  listInbounds: (isOnlyTags = false): ListInboundsResponse =>
    callMethod<ListInboundsRequest, ListInboundsResponse>(addr, "/xray.app.proxyman.command.HandlerService/ListInbounds", {
      isOnlyTags,
    }),
  removeInbound: (tag: string): void => {
    callMethod<RemoveInboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/RemoveInbound", { tag });
  },
  addOutbound: (outbound: OutboundHandlerConfig): void => {
    callMethod<AddOutboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/AddOutbound", { outbound });
  },
  alterOutbound: (tag: string, outbound: OutboundHandlerConfig): void => {
    callMethod<AlterOutboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/AlterOutbound", {
      outbound,
      tag,
    });
  },
  listOutbounds: (): ListOutboundsResponse =>
    callMethod<ListOutboundsRequest, ListOutboundsResponse>(addr, "/xray.app.proxyman.command.HandlerService/ListOutbounds", {}),
  removeOutbound: (tag: string): void => {
    callMethod<RemoveOutboundRequest, Record<string, unknown>>(addr, "/xray.app.proxyman.command.HandlerService/RemoveOutbound", { tag });
  },

  // StatsService
  getAllOnlineUsers: (): OnlineUsersResponse =>
    callMethod<Record<string, unknown>, OnlineUsersResponse>(addr, "/xray.app.stats.command.StatsService/GetAllOnlineUsers", {}),
  getStats: (name: string, reset = false): GetStatsResponse =>
    callMethod<GetStatsRequest, GetStatsResponse>(addr, "/xray.app.stats.command.StatsService/GetStats", { name, reset }),
  getStatsOnline: (name: string, reset = false): GetStatsResponse =>
    callMethod<GetStatsRequest, GetStatsResponse>(addr, "/xray.app.stats.command.StatsService/GetStatsOnline", { name, reset }),
  getStatsOnlineIpList: (name: string, reset = false): OnlineIpListResponse =>
    callMethod<GetStatsRequest, OnlineIpListResponse>(addr, "/xray.app.stats.command.StatsService/GetStatsOnlineIpList", { name, reset }),
  getSysStats: (): SysStatsResponse =>
    callMethod<Record<string, unknown>, SysStatsResponse>(addr, "/xray.app.stats.command.StatsService/GetSysStats", {}),
  queryStats: (pattern = "", reset = false): QueryStatsResponse =>
    callMethod<QueryStatsRequest, QueryStatsResponse>(addr, "/xray.app.stats.command.StatsService/QueryStats", { pattern, reset }),

  // RoutingService
  addRule: (rule: RoutingRule, shouldRulePrepend = false): void => {
    callMethod<AddRuleRequest, Record<string, unknown>>(addr, "/xray.app.router.command.RoutingService/AddRule", {
      rule,
      shouldRulePrepend,
    });
  },
  getBalancerInfo: (tag: string): BalancerInfoResponse =>
    callMethod<{ tag: string }, BalancerInfoResponse>(addr, "/xray.app.router.command.RoutingService/GetBalancerInfo", { tag }),
  listRules: (): ListRuleResponse =>
    callMethod<Record<string, unknown>, ListRuleResponse>(addr, "/xray.app.router.command.RoutingService/ListRule", {}),
  overrideBalancerTarget: (balancerTag: string, target: string): void => {
    callMethod<{ balancerTag: string; target: string }, Record<string, unknown>>(
      addr,
      "/xray.app.router.command.RoutingService/OverrideBalancerTarget",
      { balancerTag, target }
    );
  },
  removeRule: (ruleTag: string): void => {
    callMethod<RemoveRuleRequest, Record<string, unknown>>(addr, "/xray.app.router.command.RoutingService/RemoveRule", { ruleTag });
  },
  testRoute: (req: TestRouteRequest): Record<string, unknown> =>
    callMethod<TestRouteRequest, Record<string, unknown>>(addr, "/xray.app.router.command.RoutingService/TestRoute", req),

  // ObservatoryService
  getOutboundStatus: (): OutboundStatusResponse =>
    callMethod<Record<string, unknown>, OutboundStatusResponse>(
      addr,
      "/xray.core.app.observatory.command.ObservatoryService/GetOutboundStatus",
      {}
    ),

  // LoggerService
  restartLogger: (): void => {
    callMethod<Record<string, unknown>, Record<string, unknown>>(addr, "/xray.app.log.command.LoggerService/RestartLogger", {});
  },
});
