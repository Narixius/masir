import type { XrayConfig, XrayInbound } from "@gozargah/xray-schema";
import { createLogger } from "evlog";

import type { Settings } from "../config/settings.js";
import { getXrayGrpcClient } from "../contexts/grpc.js";
import { XrayType } from "../injectables/xray/types.js";
import type { ReconcileResult, XrayMode } from "../protocol.js";
import { tunInterfaceName } from "../utils/tun-name.js";
import type { TaggedXrayRule } from "./rules/storage.js";
import type { ManagedOutbound } from "./subscription/types.js";
import { xray } from "./xray.js";

export type XrayRoutingRule = NonNullable<NonNullable<XrayConfig["routing"]>["rules"]>[number];
export type XrayOutbound = NonNullable<XrayConfig["outbounds"]>[number];

export interface DesiredConfigOptions {
  readonly tun: boolean;
  readonly settings: Settings;
  /** The proxy outbound, already tagged `proxy` (see `toXrayOutbound`). */
  readonly activeOutbound: XrayOutbound;
  readonly extraInbounds?: readonly XrayInbound[];
  readonly extraOutbounds?: readonly XrayOutbound[];
  readonly extraRoutingRules?: readonly XrayRoutingRule[];
  /** The user's rules (`masir rules`), in match order. */
  readonly userRules?: readonly TaggedXrayRule[];
}

/** Tag of the proxy outbound; routing rules refer to it. */
const PROXY_TAG = "proxy";

/**
 * The xray outbound for a stored node. Picks the fields xray understands, so
 * masir-only metadata (`id`, `remarks`) never reaches the xray config.
 */
export const toXrayOutbound = (node: ManagedOutbound, tag: string = PROXY_TAG): XrayOutbound =>
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions
  ({
    mux: node.mux,
    protocol: node.protocol,
    proxySettings: node.proxySettings,
    settings: node.settings,
    streamSettings: node.streamSettings,
    tag,
  }) as unknown as XrayOutbound;

/**
 * Builds the standard mixed (Socks5/HTTP) inbound.
 */
export const buildMixedInbound = (mixedPort: number, sniff = false): XrayInbound =>
  ({
    listen: "127.0.0.1",
    port: mixedPort,
    protocol: "mixed",
    settings: {
      auth: "noauth",
      udp: true,
    },
    // With user rules, sniff so `protocol` (quic, tls, bittorrent) and domain
    // rules also match apps that connect by IP. routeOnly: the sniffed result
    // only feeds routing; the destination itself is never rewritten.
    sniffing: sniff ? { destOverride: ["http", "tls", "quic"], enabled: true, routeOnly: true } : undefined,
    tag: `mixed-${mixedPort}`,
  }) satisfies XrayInbound;

/**
 * Builds the TUN inbound interface.
 * On macOS it gets a free `utunN` name (the only kind macOS allows); elsewhere
 * xray picks the name.
 */
export const buildTunInbound = (settings: Settings): XrayInbound =>
  ({
    protocol: "tun",
    settings: {
      autoOutboundsInterface: "auto",
      autoSystemRoutingTable: ["0.0.0.0/0", "::/0"],
      dns: settings.dnsServers,
      gateway: [settings.gateway],
      mtu: 1500,
      name: tunInterfaceName(),
    },
    sniffing: {
      destOverride: ["http", "tls", "quic", "fakedns"],
      enabled: true,
      routeOnly: true,
    },
    tag: "tun-in",
  }) satisfies XrayInbound;

/**
 * Assembles standard outbounds: active proxy, direct (freedom), and block (blackhole).
 */
export const buildDefaultOutbounds = (activeOutbound: XrayOutbound, extraOutbounds?: readonly XrayOutbound[]): XrayOutbound[] => {
  const mainProxy: XrayOutbound = { ...activeOutbound, tag: PROXY_TAG };
  const direct: XrayOutbound = {
    protocol: "freedom",
    tag: "direct",
  };
  const block: XrayOutbound = {
    protocol: "blackhole",
    tag: "block",
  };
  const outbounds: XrayOutbound[] = [mainProxy, direct, block];
  if (extraOutbounds) {
    for (const ob of extraOutbounds) {
      outbounds.push(ob);
    }
  }
  outbounds.push(
    {
      tag: "dns-out",
      protocol: "dns",
      settings: {},
      streamSettings: {
        sockopt: {
          dialerProxy: "loopback-dns",
        },
      },
    },
    {
      protocol: "loopback",
      tag: "loopback-dns",
      settings: {
        inboundTag: "loopback-dns-in",
        sniffing: {
          destOverride: ["http", "tls", "quic", "fakedns"],
          enabled: true,
          routeOnly: true,
        },
      },
    }
  );

  return outbounds;
};

const IPV4_REGEX = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
/** `host:port` or `[v6]:port` -> host. */
const endpointHost = (endpoint: string): string => {
  const colon = endpoint.lastIndexOf(":");
  const host = colon > 0 ? endpoint.slice(0, colon) : endpoint;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
};

interface ServerDestinations {
  readonly domains: string[];
  readonly ips: string[];
}

/** The server-address parts of an outbound's `settings`, across protocols. Leaves are checked at use. */
interface ServerAddressSettings {
  readonly address?: string | readonly string[];
  readonly vnext?: readonly { readonly address?: string }[];
  readonly servers?: readonly { readonly address?: string }[];
  readonly peers?: readonly { readonly endpoint?: string }[];
}

/**
 * Hosts an outbound dials. Covers the shapes xray accepts: flat `settings.address`,
 * `vnext[]` (vless/vmess), `servers[]` (trojan/shadowsocks/socks/http) and
 * wireguard `peers[].endpoint` (whose `address` is the tunnel IP, not a server).
 */
const dialedHosts = (outbound: XrayOutbound): string[] => {
  const { settings } = outbound as { readonly settings?: ServerAddressSettings };
  if (!settings) {
    return [];
  }
  const candidates: (string | readonly string[] | undefined)[] = [];
  if (outbound.protocol !== "wireguard") {
    candidates.push(settings.address);
  }
  for (const server of settings.vnext ?? []) {
    candidates.push(server.address);
  }
  for (const server of settings.servers ?? []) {
    candidates.push(server.address);
  }
  for (const peer of settings.peers ?? []) {
    candidates.push(endpointHost(peer.endpoint ?? ""));
  }
  const hosts: string[] = [];
  for (const host of candidates) {
    if (typeof host === "string" && host.length > 0) {
      hosts.push(host);
    }
  }
  return hosts;
};

/** Server hosts of `outbounds`, split into domains (need bootstrap DNS) and literal IPs. */
const extractServerDestinations = (outbounds: readonly XrayOutbound[]): ServerDestinations => {
  const domains = new Set<string>();
  const ips = new Set<string>();
  for (const host of outbounds.flatMap(dialedHosts)) {
    if (IPV4_REGEX.test(host) || host.includes(":")) {
      ips.add(host);
    } else {
      domains.add(host);
    }
  }
  return { domains: [...domains], ips: [...ips] };
};

export const buildDnsSettings = (options: DesiredConfigOptions): NonNullable<XrayConfig["dns"]> => {
  const outbounds: XrayOutbound[] = [options.activeOutbound];
  for (const outbound of options.extraOutbounds ?? []) {
    outbounds.push(outbound);
  }
  const { domains } = extractServerDestinations(outbounds);

  const dns: NonNullable<XrayConfig["dns"]> = {
    servers: [
      {
        address: "https://1.1.1.1/dns-query",
        queryStrategy: "UseIPv4",
      },
    ],
  };

  if (domains.length) {
    dns.servers?.push({
      address: "1.1.1.1",
      domains,
      tag: "dns-bootstrap",
      finalQuery: true,
    });
  }

  return dns;
};

/**
 * Generates routing rules based on mode:
 * When TUN is active, injects anti-loop and private network bypass rules.
 */
export const buildRoutingRules = (options: DesiredConfigOptions): XrayRoutingRule[] => {
  const rules: XrayRoutingRule[] = [];

  rules.push(
    // prevent loop in tun mode
    {
      process: ["self/", "xray/"],
      outboundTag: "direct",
    },
    // dns-bootstrap: the outbound server addresses -> resolve direct
    { inboundTag: ["dns-bootstrap"], outboundTag: "direct" },
    // requests from dns-out -> resolves through proxy
    {
      inboundTag: ["loopback-dns-in"],
      outboundTag: "proxy",
    },
    // route all dns traffics to dns-out
    {
      port: 53,
      network: "udp",
      outboundTag: "dns-out",
    },
    // doh server always through proxy
    {
      ruleTag: "dns-upstream",
      ip: ["1.1.1.1"],
      port: 443,
      network: "tcp",
      outboundTag: "proxy",
    }
  );

  // After the plumbing above (anti-loop, DNS), before the LAN bypass: a user
  // rule may route a LAN range elsewhere, but must not break DNS or loop xray.
  for (const rule of options.userRules ?? []) {
    rules.push(rule);
  }

  rules.push({
    ip: ["geoip:private"],
    outboundTag: "direct",
    ruleTag: "lan-bypass",
  });

  if (options.extraRoutingRules) {
    for (const rule of options.extraRoutingRules) {
      rules.push(rule);
    }
  }

  rules.push({
    network: "tcp,udp",
    outboundTag: options.settings.routingMode,
    ruleTag: "default-route",
  });

  return rules;
};

/**
 * Deterministically produces the full desired XrayConfig.
 */
export const buildDesiredConfig = (options: DesiredConfigOptions): XrayConfig => {
  const inbounds: XrayInbound[] = [buildMixedInbound(options.settings.mixedPort, (options.userRules ?? []).length > 0)];
  if (options.tun) {
    inbounds.push(buildTunInbound(options.settings));
  }
  if (options.extraInbounds) {
    for (const inbound of options.extraInbounds) {
      inbounds.push(inbound);
    }
  }

  const outbounds = buildDefaultOutbounds(options.activeOutbound, options.extraOutbounds);
  const routingRules = buildRoutingRules(options);
  const dns = buildDnsSettings(options);
  return {
    dns,
    inbounds,
    outbounds,
    routing:
      routingRules.length > 0
        ? {
            // `ip` rules only see IP destinations under "AsIs"; with user IP rules
            // (e.g. `geoip:ir`), resolve unmatched domains so those rules apply too.
            domainStrategy: (options.userRules ?? []).some((rule) => rule.ip !== undefined) ? "IPIfNonMatch" : "AsIs",
            rules: routingRules,
          }
        : undefined,
  };
};

/**
 * Reconciles current Xray state with desired target config.
 * Uses gRPC for hot state transitions (e.g. TUN enable/disable) when already running;
 * gracefully boots or restarts Xray if stopped or if hot-swap cannot be applied.
 */
export interface ReconcileOptions {
  readonly tun: boolean;
  readonly settings: Settings;
  /** Restart a running xray with the desired config even when the mode already matches (e.g. the active node changed). */
  readonly reload?: boolean;
}

export const reconcile = async (desiredConfig: XrayConfig, options: ReconcileOptions): Promise<ReconcileResult> => {
  const log = createLogger({ operation: "configManager.reconcile", tun: options.tun });
  const requestedMode: XrayMode = options.tun ? "tun" : "proxy";

  if (!xray.isRunning()) {
    log.set({ action: "cold-boot", mode: requestedMode });
    const res = await xray.runWithConfig(desiredConfig);
    log.emit();
    return {
      apiPort: res.apiPort,
      mode: requestedMode,
      pid: res.pid,
      status: "started",
    };
  }

  if (options.reload) {
    log.set({ action: "reload", mode: requestedMode });
    const res = await xray.runWithConfig(desiredConfig);
    log.emit();
    return {
      apiPort: res.apiPort,
      mode: requestedMode,
      pid: res.pid,
      status: "reloaded",
    };
  }

  const currentMode = xray.getMode();
  if (currentMode === requestedMode) {
    log.set({ action: "already-matching", mode: currentMode });
    log.emit();
    return {
      apiPort: xray.getApiPort(),
      mode: currentMode,
      pid: xray.getXrayPid() ?? xray.getXray()?.pid ?? 0,
      status: "already-running",
    };
  }

  // Attempt hot gRPC delta synchronization
  try {
    const client = getXrayGrpcClient();

    if (requestedMode === "tun") {
      log.set({ action: "hot-enable-tun" });
      client.addInbound({
        proxySettings: {
          type: "xray.proxy.tun.Config",
          value: {
            DNS: options.settings.dnsServers,
            MTU: 1500,
            autoOutboundsInterface: "auto",
            autoSystemRoutingTable: ["0.0.0.0/0", "::/0"],
            gateway: [options.settings.gateway],
          },
        },
        receiverSettings: {
          type: XrayType.ReceiverConfig,
          value: {
            sniffingSettings: {
              destinationOverride: ["http", "tls", "quic", "fakedns"],
              enabled: true,
              routeOnly: true,
            },
          },
        },
        tag: "tun-in",
      });

      client.addRule(
        {
          ip: ["geoip:private"],
          outboundTag: "direct",
          ruleTag: "lan-bypass",
        },
        true
      );

      xray.setMode("tun");
      log.emit();
      return {
        apiPort: xray.getApiPort(),
        mode: "tun",
        pid: xray.getXrayPid() ?? xray.getXray()?.pid ?? 0,
        status: "tun-enabled",
      };
    }

    log.set({ action: "hot-disable-tun" });
    client.removeInbound("tun-in");
    try {
      client.removeRule("lan-bypass");
    } catch {
      // Ignore if rule was not present
    }

    xray.setMode("proxy");
    log.emit();
    return {
      apiPort: xray.getApiPort(),
      mode: "proxy",
      pid: xray.getXrayPid() ?? xray.getXray()?.pid ?? 0,
      status: "tun-disabled",
    };
  } catch (grpcError) {
    log.warn(`gRPC hot sync failed, falling back to clean reload: ${String(grpcError)}`);
    const res = await xray.runWithConfig(desiredConfig);
    log.emit();
    return {
      apiPort: res.apiPort,
      mode: requestedMode,
      pid: res.pid,
      status: requestedMode === "tun" ? "tun-enabled" : "tun-disabled",
    };
  }
};

export const configManager = {
  buildDefaultOutbounds,
  buildDesiredConfig,
  buildMixedInbound,
  buildRoutingRules,
  buildTunInbound,
  reconcile,
};
