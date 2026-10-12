export * from "./schemas.js";

export interface SysStatsResponse {
  readonly NumGoroutine: number;
  readonly NumGC: number;
  readonly Alloc: string;
  readonly TotalAlloc: string;
  readonly Sys: string;
  readonly Mallocs: string;
  readonly Frees: string;
  readonly LiveObjects: string;
  readonly PauseTotalNs: string;
  readonly Uptime: number;
}

export interface QueryStatsRequest {
  readonly pattern?: string;
  readonly reset?: boolean;
}

export interface StatItem {
  readonly name: string;
  readonly value: string;
}

export interface QueryStatsResponse {
  readonly stat?: readonly StatItem[];
}

export interface GetStatsRequest {
  readonly name: string;
  readonly reset?: boolean;
}

export interface GetStatsResponse {
  readonly stat?: StatItem;
}

/** Protobuf TypedMessage container with Phase-2 JSON expansion */
export interface TypedMessage<T = Record<string, unknown>> {
  readonly type: string;
  readonly value: T;
}

/** xray.common.net.IPOrDomain */
export interface IPOrDomain {
  readonly ip?: string;
  readonly domain?: string;
}

/** Converts an IPv4 or IPv6 string into base64 bytes for IPOrDomain.ip */
export const ipToProto = (ipStr: string): IPOrDomain => {
  const parts = ipStr.split(".");
  if (parts.length === 4) {
    const bytes = parts.map((p) => Math.trunc(Number(p)));
    return {
      ip: Buffer.from(bytes).toString("base64"),
    };
  }
  // If not IPv4, fallback to domain or omitted
  return { domain: ipStr };
};

/** xray.common.net.PortRange */
export interface PortRange {
  readonly From: number;
  readonly To: number;
}

/** xray.common.net.PortList */
export interface PortList {
  readonly range: readonly PortRange[];
}

/** xray.app.proxyman.SniffingConfig */
export interface SniffingConfig {
  readonly enabled?: boolean;
  readonly destinationOverride?: readonly string[];
  readonly domainsExcluded?: readonly unknown[];
  readonly ipsExcluded?: readonly unknown[];
  readonly metadataOnly?: boolean;
  readonly routeOnly?: boolean;
}

/**
 * Xray core InboundHandlerConfig (used in AddInboundRequest)
 */
export interface InboundHandlerConfig<TProxy = TypedMessage, TReceiver = TypedMessage> {
  readonly tag: string;
  readonly receiverSettings?: TReceiver;
  readonly proxySettings?: TProxy;
  readonly [key: string]: unknown;
}

/**
 * Xray core OutboundHandlerConfig (used in AddOutboundRequest)
 */
export interface OutboundHandlerConfig<TProxy = TypedMessage, TSender = TypedMessage> {
  readonly tag: string;
  readonly senderSettings?: TSender;
  readonly proxySettings?: TProxy;
  readonly expire?: string | number;
  readonly comment?: string;
  readonly [key: string]: unknown;
}

export interface AddInboundRequest {
  readonly inbound: InboundHandlerConfig;
}

export interface RemoveInboundRequest {
  readonly tag: string;
}

export interface AlterInboundRequest {
  readonly tag: string;
  readonly operation: TypedMessage;
}

export interface ListInboundsRequest {
  readonly isOnlyTags?: boolean;
}

export interface ListInboundsResponse {
  readonly inbounds?: readonly InboundHandlerConfig[];
}

export interface GetInboundUserRequest {
  readonly tag: string;
  readonly email: string;
}

export interface InboundUser {
  readonly email?: string;
  readonly level?: number;
  readonly account?: TypedMessage;
}

export interface GetInboundUserResponse {
  readonly users?: readonly InboundUser[];
}

export interface GetInboundUsersCountResponse {
  readonly count?: number | string;
}

export interface AddOutboundRequest {
  readonly outbound: OutboundHandlerConfig;
}

export interface RemoveOutboundRequest {
  readonly tag: string;
}

export interface AlterOutboundRequest {
  readonly tag: string;
  readonly outbound: OutboundHandlerConfig;
}

export interface ListOutboundsRequest {
  readonly [key: string]: unknown;
}

export interface ListOutboundsResponse {
  readonly outbounds?: readonly OutboundHandlerConfig[];
}

export interface RoutingRule {
  readonly tag?: string;
  readonly ruleTag?: string;
  readonly [key: string]: unknown;
}

export interface AddRuleRequest {
  readonly rule: RoutingRule;
  readonly shouldRulePrepend?: boolean;
}

export interface RemoveRuleRequest {
  readonly ruleTag: string;
}

export interface ListRuleItem {
  readonly tag: string;
  readonly ruleTag: string;
}

export interface ListRuleResponse {
  readonly rules?: readonly ListRuleItem[];
}

export interface TestRouteRequest {
  readonly RoutingContext?: Record<string, unknown>;
  readonly FieldSelectors?: readonly string[];
  readonly PublishResult?: boolean;
}

export interface BalancerInfoResponse {
  readonly balancer?: {
    readonly override?: { readonly target?: string };
    readonly principleTarget?: { readonly tag?: readonly string[] };
  };
}

export interface OnlineUsersResponse {
  readonly users?: readonly string[];
}

export interface OnlineIpListResponse {
  readonly name?: string;
  readonly ips?: Record<string, number>;
}

export interface OutboundStatusResponse {
  readonly status?: Record<string, unknown>;
}

export interface XrayClient {
  // Proxyman / HandlerService
  readonly addInbound: (inbound: InboundHandlerConfig) => void;
  readonly removeInbound: (tag: string) => void;
  readonly alterInbound: (tag: string, operation: TypedMessage) => void;
  readonly listInbounds: (isOnlyTags?: boolean) => ListInboundsResponse;
  readonly getInboundUsers: (tag: string, email: string) => GetInboundUserResponse;
  readonly getInboundUsersCount: (tag: string, email: string) => GetInboundUsersCountResponse;
  readonly addOutbound: (outbound: OutboundHandlerConfig) => void;
  readonly removeOutbound: (tag: string) => void;
  readonly alterOutbound: (tag: string, outbound: OutboundHandlerConfig) => void;
  readonly listOutbounds: () => ListOutboundsResponse;

  // StatsService
  readonly getSysStats: () => SysStatsResponse;
  readonly queryStats: (pattern?: string, reset?: boolean) => QueryStatsResponse;
  readonly getStats: (name: string, reset?: boolean) => GetStatsResponse;
  readonly getStatsOnline: (name: string, reset?: boolean) => GetStatsResponse;
  readonly getStatsOnlineIpList: (name: string, reset?: boolean) => OnlineIpListResponse;
  readonly getAllOnlineUsers: () => OnlineUsersResponse;

  // RoutingService
  readonly addRule: (rule: RoutingRule, shouldRulePrepend?: boolean) => void;
  readonly removeRule: (ruleTag: string) => void;
  readonly listRules: () => ListRuleResponse;
  readonly testRoute: (req: TestRouteRequest) => Record<string, unknown>;
  readonly getBalancerInfo: (tag: string) => BalancerInfoResponse;
  readonly overrideBalancerTarget: (balancerTag: string, target: string) => void;

  // ObservatoryService
  readonly getOutboundStatus: () => OutboundStatusResponse;

  // LoggerService
  readonly restartLogger: () => void;
}
