/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/require-readable-spacing -- OAuth recipe mirrors upstream provider API shape and preserves compact teaching examples. */

import {
  JoseKey,
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
  type OAuthClientOptions,
  type OAuthSession,
  type RuntimeLock,
} from "@atproto/oauth-client-node";

/** Durable stores are application-owned. Use a database-backed implementation in production. */
export interface BlueskyOAuthStores {
  readonly stateStore: NodeSavedStateStore;
  readonly sessionStore: NodeSavedSessionStore;
  readonly requestLock?: RuntimeLock;
}

export interface BlueskyOAuthClientConfig {
  readonly clientMetadata: OAuthClientOptions["clientMetadata"];
  readonly privateKey: string;
  readonly keyId: string;
  readonly stores: BlueskyOAuthStores;
  readonly requestLock?: RuntimeLock;
}

export async function createBlueskyOAuthClient(
  config: BlueskyOAuthClientConfig,
): Promise<NodeOAuthClient> {
  const key = await JoseKey.fromImportable(config.privateKey, config.keyId);
  const requestLock = config.requestLock ?? config.stores.requestLock;
  return new NodeOAuthClient({
    clientMetadata: config.clientMetadata,
    keyset: [key],
    responseMode: "query",
    stateStore: config.stores.stateStore,
    sessionStore: config.stores.sessionStore,
    ...(requestLock === undefined ? {} : { requestLock }),
  });
}

export interface BlueskyOAuthClientLike {
  authorize(
    handle: string,
    options: { readonly state: string; readonly signal?: AbortSignal },
  ): Promise<URL>;
  callback(
    params: URLSearchParams,
  ): Promise<{ readonly session: OAuthSession; readonly state: string | null }>;
  restore(did: string): Promise<OAuthSession>;
}

/**
 * Framework-neutral request handlers. The OAuth client performs PKCE, PAR,
 * DPoP, issuer/identity checks, token refresh, and callback validation.
 */
export function createBlueskyOAuthFlow(client: BlueskyOAuthClientLike) {
  return {
    async begin(input: {
      readonly handle: string;
      readonly state: string;
      readonly signal?: AbortSignal;
    }): Promise<string> {
      return (await client.authorize(input.handle, input)).toString();
    },
    async callback(callbackUrl: string): Promise<{
      readonly did: string;
      readonly state: string | null;
      readonly session: OAuthSession;
    }> {
      const url = new URL(callbackUrl);
      const result = await client.callback(url.searchParams);
      return { did: result.session.did, state: result.state, session: result.session };
    },
    async restore(did: string): Promise<OAuthSession> {
      return client.restore(did);
    },
  };
}

/** Map-backed fixture adapter; replace its operations with durable SQL/KV reads and writes in production. */
export interface BlueskyStoreRows {
  readonly states: Map<string, NodeSavedState>;
  readonly sessions: Map<string, NodeSavedSession>;
}

export function mapBackedBlueskyStores(rows: BlueskyStoreRows): BlueskyOAuthStores {
  return {
    stateStore: {
      async set(key, value) {
        rows.states.set(key, structuredClone(value));
      },
      async get(key) {
        const value = rows.states.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      async del(key) {
        rows.states.delete(key);
      },
    },
    sessionStore: {
      async set(key, value) {
        rows.sessions.set(key, structuredClone(value));
      },
      async get(key) {
        const value = rows.sessions.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      async del(key) {
        rows.sessions.delete(key);
      },
    },
  };
}
