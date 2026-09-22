import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ConnectionManager,
  MemoryConnectionStore,
  type ConnectionAccount,
} from "../src/server/connections.js";
import {
  CredentialManager,
  MemoryCredentialLock,
  MemoryCredentialStore,
} from "../src/server/credentials.js";

describe("server connection lifecycle", () => {
  test("persists discovery for account selection across manager reconstruction without exchanging twice", async () => {
    const store = new MemoryConnectionStore();
    let exchanges = 0;
    let release: () => void = () => {};

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const account: ConnectionAccount = {
      ref: {
        kind: "connected-account",
        version: 1,
        backend: "direct",
        platform: "x",
        accountId: "a",
      },
      displayName: "A",
    };

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid/authorize" };
      },
      async complete() {
        exchanges++;
        await gate;

        return [account];
      },
    };

    const manager = new ConnectionManager({ store });

    const started = await manager.begin({
      backend: "direct",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    const callback = {
      attemptId: started.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: "https://app.invalid/callback",
      returnedState: started.attempt.state,
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    };

    const first = manager.discover(callback);

    // Drain promise jobs until the provider has entered its controlled exchange.
    while (exchanges === 0) await Promise.resolve();
    const reconstructed = new ConnectionManager({ store });
    await assert.rejects(reconstructed.discover(callback));
    assert.equal(exchanges, 1);
    release();
    const accounts = await first;
    assert.deepEqual(accounts, [account]);
    assert.deepEqual(store.grants(), []);
    assert.deepEqual(await reconstructed.discover(callback), [account]);
    assert.equal(exchanges, 1);

    const selection = {
      attemptId: started.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      selectedAccountIds: ["a"],
    };

    await assert.rejects(reconstructed.select({ ...selection, tenantId: "other" }));
    await assert.rejects(
      reconstructed.select({ ...selection, selectedAccountIds: ["not-discovered"] }),
    );
    await assert.rejects(reconstructed.select({ ...selection, selectedAccountIds: ["a", "a"] }));
    assert.equal((await reconstructed.select(selection))[0]?.account.accountId, "a");
    await assert.rejects(reconstructed.select(selection));
    assert.equal(exchanges, 1);
  });

  test("never replays a one-use code after losing the exchange response", async () => {
    const store = new MemoryConnectionStore();
    let exchanges = 0;

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid/authorize" };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        exchanges++;
        throw new Error("lost response");
      },
    };

    const manager = new ConnectionManager({ store });

    const started = await manager.begin({
      backend: "direct",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    const callback = {
      attemptId: started.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: "https://app.invalid/callback",
      returnedState: started.attempt.state,
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    };

    await assert.rejects(manager.discover(callback));
    await assert.rejects(new ConnectionManager({ store }).discover(callback));
    assert.equal(exchanges, 1);
    assert.deepEqual(store.grants(), []);
  });

  test("rejects altered redirect parameters, callback-state conflicts and provider account scope swaps", async () => {
    const store = new MemoryConnectionStore();
    let completions = 0;

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid/authorize" };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        completions++;

        return [
          {
            ref: {
              kind: "connected-account",
              version: 1,
              backend: "other",
              platform: "x",
              accountId: "a",
            },
            displayName: "A",
          },
        ];
      },
    };

    const manager = new ConnectionManager({ store });
    const redirectUri = "https://app.invalid/callback?route=trusted";

    const begin = {
      backend: "mock",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri,
      allowedRedirectUris: [redirectUri],
      provider,
    };

    await assert.rejects(
      manager.begin({ ...begin, redirectUri: "https://app.invalid/callback?route=other" }),
    );
    const started = await manager.begin(begin);

    const complete = {
      attemptId: started.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: redirectUri,
      returnedState: started.attempt.state,
      allowedRedirectUris: [redirectUri],
      selectedAccountIds: ["a"],
      provider,
    };

    await assert.rejects(
      manager.complete({ ...complete, callbackUrl: "https://app.invalid/callback?route=other" }),
    );
    await assert.rejects(
      manager.complete({ ...complete, callbackUrl: redirectUri + "&state=wrong" }),
    );
    assert.equal(completions, 0);
    await assert.rejects(manager.complete(complete));
    assert.equal(store.grants().length, 0);
    assert.equal(completions, 1);
  });
  test("binds PKCE/state to an authenticated attempt and grants selected accounts", async () => {
    const store = new MemoryConnectionStore();
    let challenge = "";

    const provider = {
      async start(input: {
        readonly codeChallenge: string;
        readonly state: string;
        readonly platforms: readonly string[];
        readonly capabilities: readonly string[];
        readonly redirectUri: string;
      }) {
        challenge = input.codeChallenge;

        return { authorizationUrl: `https://provider.invalid/authorize?state=${input.state}` };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        return [
          {
            ref: {
              kind: "connected-account",
              version: 1,
              backend: "mock",
              platform: "x",
              accountId: "a",
            },
            displayName: "A",
          },
          {
            ref: {
              kind: "connected-account",
              version: 1,
              backend: "mock",
              platform: "threads",
              accountId: "b",
            },
            displayName: "B",
          },
        ];
      },
    };

    const manager = new ConnectionManager({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: (length) => new Uint8Array(length).fill(7),
    });

    const started = await manager.begin({
      backend: "mock",
      tenantId: "tenant-a",
      principalId: "user-a",
      platforms: ["x", "threads"],
      redirectUri: "https://app.invalid/oauth/callback",
      allowedRedirectUris: ["https://app.invalid/oauth/callback"],
      provider,
    });

    assert.ok(challenge.length > 20);

    const grants = await manager.complete({
      attemptId: started.attempt.id,
      tenantId: "tenant-a",
      principalId: "user-a",
      callbackUrl: "https://app.invalid/oauth/callback?code=opaque",
      returnedState: started.attempt.state,
      allowedRedirectUris: ["https://app.invalid/oauth/callback"],
      selectedAccountIds: ["b"],
      provider,
    });

    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.account.accountId, "b");
    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "tenant-a",
        principalId: "user-a",
        callbackUrl: "https://app.invalid/oauth/callback",
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.invalid/oauth/callback"],
        selectedAccountIds: ["b"],
        provider,
      }),
    );
  });

  test("rejects callback state and redirect mismatches", async () => {
    const store = new MemoryConnectionStore();

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid" };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        return [];
      },
    };

    const manager = new ConnectionManager({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: (length) => new Uint8Array(length).fill(3),
    });

    const started = await manager.begin({
      backend: "mock",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "tenant",
        principalId: "user",
        callbackUrl: "https://evil.invalid/callback",
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "other-tenant",
        principalId: "user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "tenant",
        principalId: "other-user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "tenant",
        principalId: "user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: "wrong",
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
  });

  test("expires, rejects denied selection, and consumes a callback exactly once", async () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new MemoryConnectionStore();

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid" };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        return [
          {
            ref: {
              kind: "connected-account",
              version: 1,
              backend: "mock",
              platform: "x",
              accountId: "a",
            },
            displayName: "A",
          },
        ];
      },
    };

    let randomSequence = 0;

    const manager = new ConnectionManager({
      store,
      now: () => now,
      randomBytes: (length) => new Uint8Array(length).fill(++randomSequence),
      ttlMs: 10,
    });

    const expired = await manager.begin({
      backend: "mock",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    now = new Date("2026-01-01T00:00:01.000Z");
    await assert.rejects(
      manager.complete({
        attemptId: expired.attempt.id,
        tenantId: "tenant",
        principalId: "user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: expired.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
    now = new Date("2026-01-01T00:00:00.000Z");

    const selected = await manager.begin({
      backend: "mock",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    await assert.rejects(
      manager.complete({
        attemptId: selected.attempt.id,
        tenantId: "tenant",
        principalId: "user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: selected.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["other"],
        provider,
      }),
    );

    const first = manager.complete({
      attemptId: selected.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: "https://app.invalid/callback",
      returnedState: selected.attempt.state,
      allowedRedirectUris: ["https://app.invalid/callback"],
      selectedAccountIds: ["a"],
      provider,
    });

    const second = manager.complete({
      attemptId: selected.attempt.id,
      tenantId: "tenant",
      principalId: "user",
      callbackUrl: "https://app.invalid/callback",
      returnedState: selected.attempt.state,
      allowedRedirectUris: ["https://app.invalid/callback"],
      selectedAccountIds: ["a"],
      provider,
    });

    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(store.grants().length, 1);
  });

  test("does not report a grant when the durable completion transaction fails", async () => {
    const store = new (class extends MemoryConnectionStore {
      override async complete(): Promise<never> {
        throw new Error("database unavailable");
      }
    })();

    const provider = {
      async start() {
        return { authorizationUrl: "https://provider.invalid" };
      },
      async complete(): Promise<readonly ConnectionAccount[]> {
        return [
          {
            ref: {
              kind: "connected-account",
              version: 1,
              backend: "mock",
              platform: "x",
              accountId: "a",
            },
            displayName: "A",
          },
        ];
      },
    };

    const manager = new ConnectionManager({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });

    const started = await manager.begin({
      backend: "mock",
      tenantId: "tenant",
      principalId: "user",
      platforms: ["x"],
      redirectUri: "https://app.invalid/callback",
      allowedRedirectUris: ["https://app.invalid/callback"],
      provider,
    });

    await assert.rejects(
      manager.complete({
        attemptId: started.attempt.id,
        tenantId: "tenant",
        principalId: "user",
        callbackUrl: "https://app.invalid/callback",
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.invalid/callback"],
        selectedAccountIds: ["a"],
        provider,
      }),
    );
  });
});

describe("credential CAS lifecycle", () => {
  test("rotates under a lock and rejects stale writes", async () => {
    const store = new MemoryCredentialStore();
    const manager = new CredentialManager(store, new MemoryCredentialLock());

    const revision = await manager.save("account-a", {
      accessToken: "old",
      refreshToken: "refresh",
    });

    const next = await manager.rotate("account-a", async (current) => ({
      ...current,
      accessToken: "new",
    }));

    assert.equal(next.accessToken, "new");
    await assert.rejects(manager.save("account-a", { accessToken: "stale" }, revision));
  });

  test("does not overwrite credentials when refresh fails or races", async () => {
    const store = new MemoryCredentialStore();
    const lock = new MemoryCredentialLock();
    const manager = new CredentialManager(store, lock);
    await manager.save("account-b", { accessToken: "old" });
    await assert.rejects(
      manager.rotate("account-b", async () => {
        throw new Error("provider unavailable");
      }),
    );
    assert.equal((await manager.get("account-b"))?.value.accessToken, "old");

    const first = manager.rotate("account-b", async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 2));

      return { ...current, accessToken: "new" };
    });

    const second = manager.rotate("account-b", async (current) => ({
      ...current,
      accessToken: "raced",
    }));

    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await manager.get("account-b"))?.value.accessToken, "new");
  });
});
