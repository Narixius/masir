import type { IPOrDomain, PortList, SniffingConfig } from "./types.js";

/** Receiver settings proto message name for inbounds */
export const RECEIVER_CONFIG_TYPE = "xray.app.proxyman.ReceiverConfig" as const;

export interface ReceiverConfig {
  readonly portList?: PortList;
  readonly listen?: IPOrDomain;
  readonly streamSettings?: Record<string, unknown>;
  readonly receiveOriginalDestination?: boolean;
  readonly sniffingSettings?: SniffingConfig;
}

export interface ReceiverTypedMessage {
  readonly type: typeof RECEIVER_CONFIG_TYPE;
  readonly value: ReceiverConfig;
}

// --- Inbound Proxy Configs ---

/** SOCKS server config */
export const SOCKS_SERVER_CONFIG_TYPE = "xray.proxy.socks.ServerConfig" as const;
export interface SocksServerConfig {
  readonly authType?: "NO_AUTH" | "PASSWORD" | number;
  readonly accounts?: Record<string, string>;
  readonly address?: IPOrDomain;
  readonly udpEnabled?: boolean;
  readonly userLevel?: number;
}

/** HTTP server config */
export const HTTP_SERVER_CONFIG_TYPE = "xray.proxy.http.ServerConfig" as const;
export interface HttpServerConfig {
  readonly timeout?: number;
  readonly accounts?: Record<string, string>;
  readonly allowTransparent?: boolean;
  readonly userLevel?: number;
}

/** VLESS inbound config */
export const VLESS_INBOUND_CONFIG_TYPE = "xray.proxy.vless.inbound.Config" as const;
export interface VlessFallback {
  readonly name?: string;
  readonly alpn?: string;
  readonly path?: string;
  readonly type?: string;
  readonly dest?: string;
  readonly xver?: number | string;
}
export interface VlessAccount {
  readonly id: string;
  readonly flow?: string;
  readonly encryption?: string;
}
export interface ProtocolUser<TAccount = Record<string, unknown>> {
  readonly level?: number;
  readonly email?: string;
  readonly account: {
    readonly type: string;
    readonly value: TAccount;
  };
}
export interface VlessInboundConfig {
  readonly users?: readonly ProtocolUser<VlessAccount>[];
  readonly fallbacks?: readonly VlessFallback[];
  readonly decryption?: string;
}

/** VMess inbound config */
export const VMESS_INBOUND_CONFIG_TYPE = "xray.proxy.vmess.inbound.Config" as const;
export interface VmessAccount {
  readonly id: string;
  readonly testsEnabled?: string;
}
export interface VmessInboundConfig {
  readonly user?: readonly ProtocolUser<VmessAccount>[];
  readonly default?: {
    readonly level?: number;
  };
}

/** Trojan server config */
export const TROJAN_SERVER_CONFIG_TYPE = "xray.proxy.trojan.ServerConfig" as const;
export interface TrojanAccount {
  readonly password: string;
}
export interface TrojanServerConfig {
  readonly users?: readonly ProtocolUser<TrojanAccount>[];
  readonly fallbacks?: readonly VlessFallback[];
}

/** Shadowsocks server config */
export const SHADOWSOCKS_SERVER_CONFIG_TYPE = "xray.proxy.shadowsocks.ServerConfig" as const;
export interface ShadowsocksServerConfig {
  readonly method?: string;
  readonly password?: string;
  readonly network?: readonly string[];
  readonly udpEnabled?: boolean;
}

/** Dokodemo-door (port forwarding) config */
export const DOKODEMO_CONFIG_TYPE = "xray.proxy.dokodemo.Config" as const;
export interface DokodemoConfig {
  readonly address?: IPOrDomain;
  readonly port?: number;
  readonly networkList?: readonly string[];
  readonly timeout?: number;
  readonly followRedirect?: boolean;
  readonly userLevel?: number;
}

// --- Outbound Proxy Configs ---

/** Freedom (direct) outbound config */
export const FREEDOM_CONFIG_TYPE = "xray.proxy.freedom.Config" as const;
export interface FreedomConfig {
  readonly domainStrategy?: "AS_IS" | "USE_IP" | "USE_IP4" | "USE_IP6" | number;
  readonly userLevel?: number;
  readonly proxyProtocol?: number;
}

/** Blackhole (block) outbound config */
export const BLACKHOLE_CONFIG_TYPE = "xray.proxy.blackhole.Config" as const;
export interface BlackholeConfig {
  readonly response?: {
    readonly type: "None" | "HTTP";
  };
}

/** SOCKS client config */
export const SOCKS_CLIENT_CONFIG_TYPE = "xray.proxy.socks.ClientConfig" as const;
export interface SocksClientConfig {
  readonly server: readonly {
    readonly address: IPOrDomain;
    readonly port: number;
    readonly user?: readonly ProtocolUser[];
  }[];
}

/** VLESS outbound config */
export const VLESS_OUTBOUND_CONFIG_TYPE = "xray.proxy.vless.outbound.Config" as const;
export interface VlessOutboundConfig {
  readonly vnext: readonly {
    readonly address: IPOrDomain;
    readonly port: number;
    readonly users: readonly ProtocolUser<VlessAccount>[];
  }[];
}

/** VMess outbound config */
export const VMESS_OUTBOUND_CONFIG_TYPE = "xray.proxy.vmess.outbound.Config" as const;
export interface VmessOutboundConfig {
  readonly receiver: readonly {
    readonly address: IPOrDomain;
    readonly port: number;
    readonly users: readonly ProtocolUser<VmessAccount>[];
  }[];
}

/** Trojan client config */
export const TROJAN_CLIENT_CONFIG_TYPE = "xray.proxy.trojan.ClientConfig" as const;
export interface TrojanClientConfig {
  readonly server: readonly {
    readonly address: IPOrDomain;
    readonly port: number;
    readonly users: readonly ProtocolUser<TrojanAccount>[];
  }[];
}

/** Sender settings proto message name for outbounds */
export const SENDER_CONFIG_TYPE = "xray.app.proxyman.SenderConfig" as const;
export interface SenderConfig {
  readonly via?: IPOrDomain;
  readonly streamSettings?: Record<string, unknown>;
  readonly multiplexSettings?: {
    readonly enabled?: boolean;
    readonly concurrency?: number;
  };
}

export interface SenderTypedMessage {
  readonly type: typeof SENDER_CONFIG_TYPE;
  readonly value: SenderConfig;
}

// --- Discriminated Union for Inbound Proxy Settings ---
export type InboundProxyTypedMessage =
  | { readonly type: typeof SOCKS_SERVER_CONFIG_TYPE; readonly value: SocksServerConfig }
  | { readonly type: typeof HTTP_SERVER_CONFIG_TYPE; readonly value: HttpServerConfig }
  | { readonly type: typeof VLESS_INBOUND_CONFIG_TYPE; readonly value: VlessInboundConfig }
  | { readonly type: typeof VMESS_INBOUND_CONFIG_TYPE; readonly value: VmessInboundConfig }
  | { readonly type: typeof TROJAN_SERVER_CONFIG_TYPE; readonly value: TrojanServerConfig }
  | { readonly type: typeof SHADOWSOCKS_SERVER_CONFIG_TYPE; readonly value: ShadowsocksServerConfig }
  | { readonly type: typeof DOKODEMO_CONFIG_TYPE; readonly value: DokodemoConfig }
  | { readonly type: string; readonly value: Record<string, unknown> };

// --- Discriminated Union for Outbound Proxy Settings ---
export type OutboundProxyTypedMessage =
  | { readonly type: typeof FREEDOM_CONFIG_TYPE; readonly value: FreedomConfig }
  | { readonly type: typeof BLACKHOLE_CONFIG_TYPE; readonly value: BlackholeConfig }
  | { readonly type: typeof SOCKS_CLIENT_CONFIG_TYPE; readonly value: SocksClientConfig }
  | { readonly type: typeof VLESS_OUTBOUND_CONFIG_TYPE; readonly value: VlessOutboundConfig }
  | { readonly type: typeof VMESS_OUTBOUND_CONFIG_TYPE; readonly value: VmessOutboundConfig }
  | { readonly type: typeof TROJAN_CLIENT_CONFIG_TYPE; readonly value: TrojanClientConfig }
  | { readonly type: string; readonly value: Record<string, unknown> };

/** Constants map of all typed message names for autocomplete */
export const XrayType = {
  ReceiverConfig: RECEIVER_CONFIG_TYPE,
  SenderConfig: SENDER_CONFIG_TYPE,
  // Inbounds
  SocksServer: SOCKS_SERVER_CONFIG_TYPE,
  HttpServer: HTTP_SERVER_CONFIG_TYPE,
  VlessInbound: VLESS_INBOUND_CONFIG_TYPE,
  VmessInbound: VMESS_INBOUND_CONFIG_TYPE,
  TrojanServer: TROJAN_SERVER_CONFIG_TYPE,
  ShadowsocksServer: SHADOWSOCKS_SERVER_CONFIG_TYPE,
  Dokodemo: DOKODEMO_CONFIG_TYPE,
  // Outbounds
  Freedom: FREEDOM_CONFIG_TYPE,
  Blackhole: BLACKHOLE_CONFIG_TYPE,
  SocksClient: SOCKS_CLIENT_CONFIG_TYPE,
  VlessOutbound: VLESS_OUTBOUND_CONFIG_TYPE,
  VmessOutbound: VMESS_OUTBOUND_CONFIG_TYPE,
  TrojanClient: TROJAN_CLIENT_CONFIG_TYPE,
} as const;
