import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SocialError } from "../src/core/errors.js";
import { ConnectionManager, MemoryConnectionStore } from "../src/server/connections.js";
import {
  CredentialManager,
  MemoryCredentialLock,
  type StoredCredential,
} from "../src/server/credentials.js";
import { DurableCredentialStore, type CredentialCodec } from "../src/server/durable-stores.js";
import { createEncryptedCredentialStore } from "../src/server/encrypted-credentials.js";
import { MemoryKeyValueStore, createKeyValueScheduleStore } from "../src/server/schedule-store.js";
import {
  SqlDurableDriver,
  createSqliteExecutor,
  type SqlExecutor,
} from "../src/server/sql-stores.js";

const secret = "tok-SECRET-9f3a";

/** Rejects when any field a caller can log or serialize mentions the secret. */
function sanitized(code: SocialError["code"]) {
  return (error: unknown): error is SocialError => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);

    for (const part of [error.message, error.stack, JSON.stringify(error), error.upstreamCode])
      assert.ok(!part?.includes(secret), part);

    return true;
  };
}

/** A codec whose failure quotes the value it was given, as a careless application codec might. */
const echoingCodec: CredentialCodec<StoredCredential> = {
  encode(value) {
    throw new SocialError({
      code: "invalid_input",
      operation: "app.codec",
      message: `cannot encode ${JSON.stringify(value)}`,
      details: { value: value.accessToken },
    });
  },
  decode: () => undefined,
};

describe("storage errors never carry what the store was given", () => {
  test("a connection store that echoes the attempt cannot leak its verifier", async () => {
    const inner = new MemoryConnectionStore();

    const manager = new ConnectionManager({
      store: {
        ...inner,
        get: (id) => inner.get(id),
        claimDiscovery: (id) => inner.claimDiscovery(id),
        saveDiscoveredAccounts: (id, accounts) => inner.saveDiscoveredAccounts(id, accounts),
        getDiscoveredAccounts: (id) => inner.getDiscoveredAccounts(id),
        complete: (input) => inner.complete(input),
        async save(attempt) {
          throw new Error(`insert failed: ${JSON.stringify(attempt)} ${secret}`);
        },
      },
    });

    await assert.rejects(
      manager.begin({
        backend: "direct",
        tenantId: "tenant",
        principalId: "principal",
        platforms: ["youtube"],
        redirectUri: "https://app.test/cb",
        allowedRedirectUris: ["https://app.test/cb"],
        provider: {
          start: async () => ({ authorizationUrl: "https://provider.test/authorize" }),
          complete: async () => [],
        },
      }),
      sanitized("upstream_failure"),
    );
  });

  test("a durable store keeps only the code of an executor's SocialError", async () => {
    const real = createSqliteExecutor(new DatabaseSync(":memory:"));

    const executor: SqlExecutor = {
      query: (sql, parameters) => real.query(sql, parameters),
      async execute(sql, parameters) {
        if (sql.trimStart().startsWith("INSERT"))
          throw new SocialError({
            code: "rate_limited",
            operation: "app.executor",
            message: `slow down: ${JSON.stringify(parameters)} ${secret}`,
            retryDisposition: { kind: "after-delay", delayMs: 5 },
          });

        return real.execute(sql, parameters);
      },
    };

    const driver = new SqlDurableDriver({ executor, dialect: "sqlite" });
    await driver.createSchema();

    const store = new DurableCredentialStore({
      driver,
      codec: { encode: JSON.stringify, decode: () => undefined },
    });

    await assert.rejects(
      store.compareAndSet({
        key: "a",
        expectedRevision: undefined,
        value: { accessToken: secret },
      }),
      (error: unknown): error is SocialError => {
        assert.ok(sanitized("rate_limited")(error));
        assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 5 });

        return true;
      },
    );
  });

  test("durable and encrypted stores replace a codec error that quotes the credential", async () => {
    const driver = new SqlDurableDriver({
      executor: createSqliteExecutor(new DatabaseSync(":memory:")),
      dialect: "sqlite",
    });

    await driver.createSchema();

    const durable = new DurableCredentialStore({ driver, codec: echoingCodec });

    const encrypted = createEncryptedCredentialStore({
      store: {
        get: async () => undefined,
        compareAndSet: async () => ({ updated: false }),
        delete: async () => undefined,
      },
      namespace: "tenant-a",
      currentKeyId: "k1",
      resolveKey: async () => new Uint8Array(32).fill(1),
      codec: echoingCodec,
    });

    for (const store of [durable, encrypted])
      await assert.rejects(
        store.compareAndSet({
          key: "a",
          expectedRevision: undefined,
          value: { accessToken: secret },
        }),
        sanitized("invalid_input"),
      );
  });
});

describe("storage error details the SDK keeps", () => {
  test("an unknown credential store failure still retries after a delay", async () => {
    const manager = new CredentialManager(
      {
        get: async () => {
          throw new Error(`connection refused ${secret}`);
        },
        compareAndSet: async () => ({ updated: false }),
        delete: async () => undefined,
      },
      new MemoryCredentialLock(),
    );

    await assert.rejects(manager.resolve("a"), (error: unknown): error is SocialError => {
      assert.ok(sanitized("upstream_failure")(error));
      assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 1_000 });

      return true;
    });
  });

  test("the memory connection store's fixed messages survive the store guard", async () => {
    const manager = new ConnectionManager({
      store: new MemoryConnectionStore(),
      randomBytes: () => new Uint8Array(64),
    });

    const begin = () =>
      manager.begin({
        backend: "direct",
        tenantId: "tenant",
        principalId: "principal",
        platforms: ["youtube"],
        redirectUri: "https://app.test/cb",
        allowedRedirectUris: ["https://app.test/cb"],
        provider: {
          start: async () => ({ authorizationUrl: "https://provider.test/authorize" }),
          complete: async () => [],
        },
      });

    await begin();

    // Fixed random bytes reuse the attempt ID, so the second save collides.
    await assert.rejects(begin(), { message: "Connection attempt ID collision" });
  });

  test("a corrupted schedule record is reported without the parser's excerpt", async () => {
    const kv = new MemoryKeyValueStore();

    await kv.compareAndSet({
      key: "schedule/job/s/j",
      expectedVersion: undefined,
      value: `{"format":"social-sdk.schedule-job","draft":"${secret}"`,
    });

    await assert.rejects(
      createKeyValueScheduleStore(kv).get({ scope: "s", id: "j" }),
      (error: unknown): error is SocialError => {
        assert.ok(sanitized("upstream_failure")(error));
        assert.equal(error.message, "Stored record is not valid JSON");

        return true;
      },
    );
  });
});
