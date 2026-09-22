import {
  ConnectionManager,
  type ConnectionStore,
  type ConnectionProvider,
} from "@opencoredev/social-sdk/server";
import type { Platform } from "@opencoredev/social-sdk";

// Supply a provider factory such as xOAuth() and durable application storage.
// The authenticated session, backend, platforms, and redirect are server configuration.
export function connectionHandlers(config: {
  provider: ConnectionProvider;
  store: ConnectionStore;
  backend: string;
  platforms: readonly Platform[];
  redirectUri: string;
}) {
  const connections = new ConnectionManager({ store: config.store });
  const allowedRedirectUris = [config.redirectUri];

  return {
    async begin(session: { tenantId: string; principalId: string }) {
      return connections.begin({
        ...session,
        backend: config.backend,
        platforms: config.platforms,
        redirectUri: config.redirectUri,
        allowedRedirectUris,
        provider: config.provider,
      });
    },
    async discover(
      session: { tenantId: string; principalId: string },
      input: {
        attemptId: string;
        returnedState: string;
        callbackUrl: string;
      },
    ) {
      return connections.discover({
        ...input,
        ...session,
        allowedRedirectUris,
        provider: config.provider,
      });
    },
    async select(
      session: { tenantId: string; principalId: string },
      input: {
        attemptId: string;
        selectedAccountIds: readonly string[];
      },
    ) {
      return connections.select({ ...input, ...session });
    },
  };
}
