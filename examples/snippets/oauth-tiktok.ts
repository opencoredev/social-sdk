import { tiktokOAuth } from "@opencoredev/social-sdk/server";
import {
  createConnectionManager,
  MemoryOAuthCredentialSink,
  requiredEnvironment,
  discoverAndSelect,
} from "./oauth-common.js";

export function createTikTokConnection(input: {
  readonly redirectUri: string;
  readonly allowedRedirectUris: readonly string[];
}) {
  const sink = new MemoryOAuthCredentialSink();

  const provider = tiktokOAuth({
    clientId: requiredEnvironment("TIKTOK_CLIENT_KEY"),
    clientSecret: requiredEnvironment("TIKTOK_CLIENT_SECRET"),
    redirectUri: input.redirectUri,
    scopes: ["user.info.basic", "video.publish"],
    credentialSink: sink,
  });

  const manager = createConnectionManager();

  return {
    async begin(connection: { readonly tenantId: string; readonly principalId: string }) {
      const started = await manager.begin({
        backend: "direct",
        tenantId: connection.tenantId,
        principalId: connection.principalId,
        platforms: ["tiktok"],
        capabilities: ["posts.publish"],
        redirectUri: input.redirectUri,
        allowedRedirectUris: input.allowedRedirectUris,
        provider,
      });

      return { authorizationUrl: started.authorizationUrl, attempt: started.attempt };
    },
    async complete(connection: {
      readonly tenantId: string;
      readonly principalId: string;
      readonly attemptId: string;
      readonly callbackUrl: string;
      readonly returnedState: string;
      readonly selectedAccountIds: readonly string[];
    }) {
      return discoverAndSelect({
        manager,
        provider,
        attemptId: connection.attemptId,
        tenantId: connection.tenantId,
        principalId: connection.principalId,
        callbackUrl: connection.callbackUrl,
        returnedState: connection.returnedState,
        allowedRedirectUris: input.allowedRedirectUris,
        selectedAccountIds: connection.selectedAccountIds,
      });
    },
    credentials: sink,
  };
}
