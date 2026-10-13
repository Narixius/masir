export interface SubscriptionUserInfo {
  readonly upload: number;
  readonly download: number;
  readonly total: number;
  readonly expire: number;
}

export interface SubscriptionMeta {
  readonly name: string;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly nodeCount: number;
  readonly userinfo?: SubscriptionUserInfo;
  readonly updateIntervalMinutes?: number;
  /**
   * Stored-data format. Missing on subscriptions saved before nodes carried
   * `remarks`; `sub use` refreshes those once to backfill server names.
   */
  readonly formatVersion?: number;
}

/** Current `SubscriptionMeta.formatVersion`: nodes carry `remarks`. */
export const SUBSCRIPTION_FORMAT_VERSION = 2;

export interface SubscriptionsIndex {
  readonly subscriptions: Record<string, SubscriptionMeta>;
  readonly activeNodeId?: string;
  readonly activeSubscriptionName?: string;
}

export interface ManagedOutbound {
  readonly id: string;
  readonly tag: string;
  /** Human-readable server name from the provider (`#remark` in links, `remarks` in JSON configs). */
  readonly remarks?: string;
  readonly protocol: string;
  readonly settings?: Record<string, unknown>;
  readonly streamSettings?: Record<string, unknown>;
  readonly proxySettings?: Record<string, unknown>;
  readonly mux?: Record<string, unknown>;
}

/** What a subscription refresh did to the active node, if it belongs to that subscription. */
export type ActiveNodeStatus = "unchanged" | "changed" | "removed" | "not-active";

/** Result of refreshing one subscription; small and serializable so it can cross the IPC boundary. */
export type SubscriptionUpdateOutcome =
  | {
      readonly name: string;
      readonly ok: true;
      readonly nodeCount: number;
      readonly activeNodeStatus: ActiveNodeStatus;
      readonly removedActiveNode?: ManagedOutbound;
    }
  | { readonly name: string; readonly ok: false; readonly error: string };
