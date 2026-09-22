/* oxlint-disable anti-slop/require-readable-spacing -- compact lifecycle fixture. */
import assert from "node:assert/strict";
import { it } from "node:test";
import {
  ConnectionManager,
  MemoryConnectionStore,
  type ConnectionAccount,
} from "../src/server/connections.js";

it("preserves all discovered accounts for discover then select", async () => {
  const store = new MemoryConnectionStore();
  const manager = new ConnectionManager({ store, randomBytes: () => new Uint8Array(64) });
  const providerAccounts: readonly ConnectionAccount[] = [
    {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: "direct",
        platform: "youtube",
        accountId: "channel-1",
      },
      displayName: "One",
    },
    {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: "direct",
        platform: "youtube",
        accountId: "channel-2",
      },
      displayName: "Two",
    },
  ];
  const provider = {
    start: async () => ({ authorizationUrl: "https://provider.test/authorize" }),
    complete: async () => providerAccounts,
  };
  const started = await manager.begin({
    backend: "direct",
    tenantId: "tenant",
    principalId: "principal",
    platforms: ["youtube"],
    redirectUri: "https://app.test/cb",
    allowedRedirectUris: ["https://app.test/cb"],
    provider,
  });
  const input = {
    attemptId: started.attempt.id,
    tenantId: "tenant",
    principalId: "principal",
    callbackUrl: "https://app.test/cb?state=" + started.attempt.state,
    returnedState: started.attempt.state,
    allowedRedirectUris: ["https://app.test/cb"],
    provider,
  };
  const discovered = await manager.discover(input);
  const grants = await manager.select({ ...input, selectedAccountIds: ["channel-2"] });

  assert.deepEqual(
    discovered.map((item) => item.ref.accountId),
    ["channel-1", "channel-2"],
  );
  assert.deepEqual(
    grants.map((grant) => grant.account.accountId),
    ["channel-2"],
  );
});
