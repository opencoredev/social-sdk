import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { SocialError } from "../src/core/errors.js";
import type { DeliveryOutcome } from "../src/core/types.js";
import {
  ConnectionManager,
  type ConnectionAccount,
  type ConnectionAttempt,
} from "../src/server/connections.js";
import type { StoredCredential } from "../src/server/credentials.js";
import type { DurableDriver } from "../src/server/durable-driver.js";
import {
  DurableConnectionStore,
  DurableIdempotencyStore,
  type CredentialCodec,
} from "../src/server/durable-stores.js";
import {
  createRedisStores,
  redisDurableScripts,
  type RedisScriptRunner,
} from "../src/server/redis-stores.js";
import {
  createSqlStores,
  createSqliteExecutor,
  SqlDurableDriver,
  type SqlExecutor,
} from "../src/server/sql-stores.js";

const directory = mkdtempSync(join(tmpdir(), "social-sdk-durable-"));

after(() => rmSync(directory, { recursive: true, force: true }));

let fileIndex = 0;

function sqliteFile(): string {
  return join(directory, `store-${++fileIndex}.db`);
}

function openSqlite(file: string, now?: () => Date) {
  const database = new DatabaseSync(file);
  const executor = createSqliteExecutor(database);

  return now === undefined
    ? createSqlStores({ executor, dialect: "sqlite" })
    : createSqlStores({ executor, dialect: "sqlite", now });
}

class Clock {
  time = Date.parse("2026-10-24T12:00:00.000Z");

  now = (): Date => new Date(this.time);
}

/** Yields before every write so concurrent read-modify-write cycles interleave. */
function interleaving(driver: DurableDriver): DurableDriver {
  return {
    read: (input) => driver.read(input),
    write: async (input) => {
      await new Promise((resolve) => setImmediate(resolve));

      return driver.write(input);
    },
    remove: (input) => driver.remove(input),
    acquireLease: (input) => driver.acquireLease(input),
    renewLease: (input) => driver.renewLease(input),
    releaseLease: (input) => driver.releaseLease(input),
  };
}

const account = (accountId: string): ConnectionAccount => ({
  ref: { kind: "connected-account", version: 1, backend: "direct", platform: "youtube", accountId },
  displayName: accountId,
});

function attempt(id: string, expiresAt = "2026-10-24T12:10:00.000Z"): ConnectionAttempt {
  return {
    id,
    backend: "direct",
    tenantId: "tenant-1",
    principalId: "user-1",
    platforms: ["youtube"],
    capabilities: ["publish"],
    redirectUri: "https://app.test/callback",
    state: "state-secret",
    codeVerifier: "verifier-secret",
    providerState: "dpop-private-key",
    createdAt: "2026-10-24T12:00:00.000Z",
    expiresAt,
  };
}

function published(targetIndex: number, accountId: string): DeliveryOutcome {
  return {
    state: "published",
    targetIndex,
    account: account(accountId).ref,
    observedAt: "2026-10-24T12:00:01.000Z",
    post: {
      kind: "platform-post",
      version: 1,
      backend: "direct",
      platform: "youtube",
      accountId,
      postId: `post-${targetIndex}`,
      native: { uri: "at://x" },
    },
  };
}

const credential: StoredCredential = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: "2026-10-24T11:00:00.000Z",
  scopes: ["read"],
  metadata: { region: "eu" },
};

function rejectsWith(code: SocialError["code"]) {
  return (error: unknown): error is SocialError =>
    error instanceof SocialError && error.code === code;
}

describe("SQL driver", () => {
  it("runs no queries until createSchema and renders Postgres placeholders", async () => {
    const statements: {
      readonly sql: string;
      readonly parameters: readonly (string | number)[];
    }[] = [];

    const executor: SqlExecutor = {
      query: async (sql, parameters) => {
        statements.push({ sql, parameters });

        return [];
      },
      execute: async (sql, parameters) => {
        statements.push({ sql, parameters });

        return 1;
      },
    };

    const stores = createSqlStores({ executor, dialect: "postgres", tablePrefix: "app_" });
    assert.equal(statements.length, 0);

    await stores.driver.createSchema();
    assert.equal(statements.length, 2);
    assert.match(statements[0]?.sql ?? "", /CREATE TABLE IF NOT EXISTS app_records/);

    await stores.credentials.get("acct");
    assert.equal(
      statements[2]?.sql,
      "SELECT revision, body FROM app_records WHERE namespace = $1 AND record_key = $2",
    );
    assert.deepEqual(statements[2]?.parameters, ["credential", "acct"]);
  });

  it("rejects unsafe identifiers and dialects", () => {
    const executor = createSqliteExecutor(new DatabaseSync(":memory:"));

    assert.throws(
      () =>
        new SqlDurableDriver({ executor, dialect: "sqlite", tablePrefix: "x; DROP TABLE y; --" }),
      rejectsWith("invalid_config"),
    );
  });

  it("hides executor errors that may echo secret parameters", async () => {
    const executor: SqlExecutor = {
      query: async () => {
        throw new Error("syntax error near 'refresh-secret'");
      },
      execute: async () => {
        throw new Error("duplicate key access-secret");
      },
    };

    const { credentials } = createSqlStores({ executor, dialect: "sqlite" });

    await assert.rejects(
      credentials.compareAndSet({ key: "a", expectedRevision: undefined, value: credential }),
      (error: unknown): error is SocialError =>
        error instanceof SocialError &&
        !error.message.includes("secret") &&
        error.cause === undefined &&
        !JSON.stringify(error.toJSON()).includes("secret"),
    );
  });
});

describe("credentials on SQLite", () => {
  it("persists across instances, rejects stale CAS, and never reuses revisions", async () => {
    const file = sqliteFile();
    const first = openSqlite(file);
    await first.driver.createSchema();

    const created = await first.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: credential,
    });

    assert.equal(created.updated, true);

    const second = openSqlite(file);
    const loaded = await second.credentials.get("acct");
    // An expired access token is data only; the refresh token stays stored.
    assert.deepEqual(loaded?.value, credential);
    assert.equal(loaded?.revision, created.revision);

    const updated = await second.credentials.compareAndSet({
      key: "acct",
      expectedRevision: created.revision,
      value: { ...credential, accessToken: "access-2" },
    });

    assert.equal(updated.updated, true);

    const stale = await first.credentials.compareAndSet({
      key: "acct",
      expectedRevision: created.revision,
      value: { ...credential, accessToken: "lost-update" },
    });

    assert.deepEqual(stale, { updated: false });

    const duplicate = await first.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: credential,
    });

    assert.equal(duplicate.updated, false);

    await first.credentials.delete("acct");

    const recreated = await first.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: credential,
    });

    assert.notEqual(recreated.revision, updated.revision);
    assert.notEqual(recreated.revision, created.revision);

    const aba = await second.credentials.compareAndSet({
      key: "acct",
      expectedRevision: updated.revision,
      value: credential,
    });

    assert.equal(aba.updated, false);
  });

  it("deletes only at the expected revision", async () => {
    const stores = openSqlite(sqliteFile());
    await stores.driver.createSchema();

    const created = await stores.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: credential,
    });

    const replaced = await stores.credentials.compareAndSet({
      key: "acct",
      expectedRevision: created.revision,
      value: { ...credential, accessToken: "access-2" },
    });

    assert.equal(await stores.credentials.deleteIfRevision("acct", created.revision ?? ""), false);
    assert.equal((await stores.credentials.get("acct"))?.value.accessToken, "access-2");
    assert.equal(await stores.credentials.deleteIfRevision("acct", replaced.revision ?? ""), true);
    assert.equal(await stores.credentials.get("acct"), undefined);
    assert.equal(await stores.credentials.deleteIfRevision("acct", replaced.revision ?? ""), false);
  });

  it("preserves and validates the refreshState fence", async () => {
    const stores = openSqlite(sqliteFile());
    await stores.driver.createSchema();

    const fenced: StoredCredential = {
      ...credential,
      refreshState: {
        state: "in-flight",
        startedAt: "2026-10-24T12:00:00.000Z",
        deadline: "2026-10-24T12:00:30.000Z",
      },
    };

    await stores.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: fenced,
    });
    assert.deepEqual((await stores.credentials.get("acct"))?.value, fenced);

    await stores.driver.write({
      namespace: "credential",
      key: "bad",
      expectedRevision: undefined,
      revision: crypto.randomUUID(),
      text: JSON.stringify({
        v: 1,
        kind: "credential",
        credential: JSON.stringify({ ...credential, refreshState: { state: "in-flight" } }),
      }),
    });
    await assert.rejects(
      stores.credentials.get("bad"),
      (error: unknown): error is SocialError =>
        error instanceof SocialError && !error.message.includes("access-1"),
    );
  });

  it("accepts a generic codec for encrypted envelopes", async () => {
    interface Envelope {
      readonly ciphertext: string;
    }

    const codec: CredentialCodec<Envelope> = {
      encode: (value) => `sealed:${value.ciphertext}`,
      decode: (text) => (text.startsWith("sealed:") ? { ciphertext: text.slice(7) } : undefined),
    };

    const database = new DatabaseSync(sqliteFile());

    const stores = createSqlStores({
      executor: createSqliteExecutor(database),
      dialect: "sqlite",
      credentialCodec: codec,
    });

    await stores.driver.createSchema();

    await stores.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: { ciphertext: "abc" },
    });
    assert.deepEqual((await stores.credentials.get("acct"))?.value, { ciphertext: "abc" });
    const raw = await stores.driver.read({ namespace: "credential", key: "acct" });
    assert.match(raw?.text ?? "", /sealed:abc/);
  });
});

describe("credential lock on SQLite", () => {
  it("owns, expires, renews, and releases leases by token", async () => {
    const clock = new Clock();
    const file = sqliteFile();
    const first = openSqlite(file, clock.now);
    await first.driver.createSchema();
    const second = openSqlite(file, clock.now);

    await assert.rejects(first.credentialLock.acquire("acct", 0), rejectsWith("invalid_input"));
    await assert.rejects(first.credentialLock.acquire("acct", 1.5), rejectsWith("invalid_input"));

    const lease = await first.credentialLock.acquire("acct", 1000);
    assert.ok(lease);
    assert.match(lease.token, /^[0-9a-f-]{36}$/);
    assert.equal(lease.expiresAt, "2026-10-24T12:00:01.000Z");
    assert.equal(await second.credentialLock.acquire("acct", 1000), undefined);

    // A non-owner release leaves the lease in place.
    await second.credentialLock.release({ ...lease, token: crypto.randomUUID() });
    assert.equal(await second.credentialLock.acquire("acct", 1000), undefined);

    clock.time += 500;
    const renewed = await first.credentialLock.renew(lease, 1000);
    assert.equal(renewed?.expiresAt, "2026-10-24T12:00:01.500Z");

    clock.time += 900;
    assert.equal(await second.credentialLock.acquire("acct", 1000), undefined);

    clock.time += 100;
    const taken = await second.credentialLock.acquire("acct", 1000);
    assert.ok(taken);
    assert.equal(await first.credentialLock.renew(lease, 1000), undefined);

    // The expired owner cannot release the new owner's lease.
    await first.credentialLock.release(lease);
    assert.equal(await first.credentialLock.acquire("acct", 1000), undefined);

    await second.credentialLock.release(taken);
    assert.ok(await first.credentialLock.acquire("acct", 1000));
  });
});

describe("idempotency on SQLite", () => {
  it("claims once, detects conflicts, and merges concurrent outcomes", async () => {
    const file = sqliteFile();
    const first = openSqlite(file);
    await first.driver.createSchema();
    const second = openSqlite(file);

    const input = {
      scope: "tenant-1",
      key: "post-1",
      fingerprint: "f1",
      targetKeys: ["a", "b", "c"],
    };

    const claimed = await first.idempotency.claim(input);
    assert.equal(claimed.kind, "new");
    assert.deepEqual(await second.idempotency.claim({ ...input, fingerprint: "f2" }), {
      kind: "conflict",
    });
    assert.deepEqual(await second.idempotency.claim({ ...input, targetKeys: ["a", "b"] }), {
      kind: "conflict",
    });

    const racing = [first, second, first].map(
      (stores) => new DurableIdempotencyStore({ driver: interleaving(stores.driver) }),
    );

    await Promise.all(
      ["a", "b", "c"].map((targetKey, index) =>
        racing[index]?.saveOutcome({
          claimId: claimed.claimId,
          targetKey,
          outcome: published(index, `acct-${targetKey}`),
        }),
      ),
    );

    const replay = await openSqlite(file).idempotency.claim(input);
    assert.equal(replay.kind, "existing");

    if (replay.kind !== "existing") return;
    assert.equal(replay.claimId, claimed.claimId);
    assert.deepEqual(Object.keys(replay.outcomes).sort(), ["a", "b", "c"]);
    assert.deepEqual(replay.outcomes["b"], published(1, "acct-b"));

    await assert.rejects(
      first.idempotency.saveOutcome({
        claimId: claimed.claimId,
        targetKey: "z",
        outcome: published(9, "z"),
      }),
      rejectsWith("invalid_input"),
    );
  });

  it("never recreates an absent claim or merges into a new generation", async () => {
    const stores = openSqlite(sqliteFile());
    await stores.driver.createSchema();
    const input = { scope: "s", key: "k", fingerprint: "f", targetKeys: ["a"] };
    const outcome = published(0, "acct-a");

    await assert.rejects(
      stores.idempotency.saveOutcome({
        claimId: `${crypto.randomUUID()}.deadbeef`,
        targetKey: "a",
        outcome,
      }),
      rejectsWith("not_found"),
    );
    await assert.rejects(
      stores.idempotency.saveOutcome({ claimId: "nonsense", targetKey: "a", outcome }),
      rejectsWith("not_found"),
    );

    const original = await stores.idempotency.claim(input);
    assert.equal(original.kind, "new");
    const documentKey = original.claimId.slice(37);
    await stores.driver.remove({ namespace: "idempotency", key: documentKey });

    await assert.rejects(
      stores.idempotency.saveOutcome({ claimId: original.claimId, targetKey: "a", outcome }),
      rejectsWith("not_found"),
    );
    assert.equal(
      await stores.driver.read({ namespace: "idempotency", key: documentKey }),
      undefined,
    );

    const next = await stores.idempotency.claim(input);
    assert.equal(next.kind, "new");
    await assert.rejects(
      stores.idempotency.saveOutcome({ claimId: original.claimId, targetKey: "a", outcome }),
      rejectsWith("not_found"),
    );
  });
});

describe("connections on SQLite", () => {
  it("claims discovery permanently and completes atomically into lasting grants", async () => {
    const clock = new Clock();
    const file = sqliteFile();
    const first = openSqlite(file, clock.now);
    await first.driver.createSchema();
    const second = openSqlite(file, clock.now);
    const accounts = [account("one"), account("two")];

    await first.connections.save(attempt("attempt-1"));
    await assert.rejects(first.connections.save(attempt("attempt-1")));
    assert.equal(await second.connections.claimDiscovery("attempt-1"), true);
    assert.equal(await first.connections.claimDiscovery("attempt-1"), false);
    await second.connections.saveDiscoveredAccounts("attempt-1", accounts);
    await assert.rejects(first.connections.saveDiscoveredAccounts("attempt-1", accounts));
    assert.deepEqual(await first.connections.getDiscoveredAccounts("attempt-1"), accounts);

    const request = {
      attemptId: "attempt-1",
      state: "state-secret",
      accounts,
      selectedAccountIds: ["two"],
    };

    await assert.rejects(
      first.connections.complete({ ...request, state: "wrong" }),
      rejectsWith("unauthorized"),
    );
    await assert.rejects(
      first.connections.complete({ ...request, selectedAccountIds: ["two", "two"] }),
      rejectsWith("invalid_input"),
    );
    await assert.rejects(
      first.connections.complete({ ...request, selectedAccountIds: ["three"] }),
      rejectsWith("unauthorized"),
    );
    await assert.rejects(
      first.connections.complete({ ...request, accounts: [account("two")] }),
      rejectsWith("unauthorized"),
    );

    // Two workers race the same completion; exactly one wins.
    const results = await Promise.allSettled([
      new DurableConnectionStore({ driver: interleaving(first.driver), now: clock.now }).complete(
        request,
      ),
      new DurableConnectionStore({ driver: interleaving(second.driver), now: clock.now }).complete(
        request,
      ),
    ]);

    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    assert.equal(fulfilled.length, 1);
    const grants = fulfilled[0] ?? [];
    assert.equal(grants.length, 1);
    assert.equal(grants[0]?.account.accountId, "two");
    assert.deepEqual(grants[0]?.capabilities, ["publish"]);

    assert.equal(await first.connections.get("attempt-1"), undefined);
    assert.equal(await first.connections.getDiscoveredAccounts("attempt-1"), undefined);
    const raw = await first.driver.read({ namespace: "connection", key: "attempt-1" });
    assert.doesNotMatch(raw?.text ?? "", /verifier-secret|state-secret|dpop-private-key/);

    // Grants outlive the attempt's expiry and a recreated store.
    clock.time += 24 * 60 * 60 * 1000;
    const reopened = openSqlite(file, clock.now);
    const grantId = grants[0]?.grantId ?? "";
    assert.deepEqual(await reopened.connections.getGrant(grantId), grants[0]);
    assert.deepEqual(await reopened.connections.listGrants("attempt-1"), grants);

    assert.equal(await reopened.connections.revokeGrant(grantId), true);
    assert.equal(await reopened.connections.revokeGrant(grantId), false);
    assert.equal(await first.connections.getGrant(grantId), undefined);
    assert.deepEqual(await first.connections.listGrants("attempt-1"), []);
    assert.equal(await first.connections.getGrant("not-a-grant"), undefined);
  });

  it("keeps the attempt retryable when the completing write fails", async () => {
    const clock = new Clock();
    const stores = openSqlite(sqliteFile(), clock.now);
    await stores.driver.createSchema();
    let failWrites = false;

    const flaky: DurableDriver = {
      read: (input) => stores.driver.read(input),
      remove: (input) => stores.driver.remove(input),
      acquireLease: (input) => stores.driver.acquireLease(input),
      renewLease: (input) => stores.driver.renewLease(input),
      releaseLease: (input) => stores.driver.releaseLease(input),
      write: async (input) => {
        if (failWrites) throw new Error("connection reset");

        return stores.driver.write(input);
      },
    };

    const store = new DurableConnectionStore({ driver: flaky, now: clock.now });
    const accounts = [account("one")];

    await store.save(attempt("attempt-2"));
    await store.claimDiscovery("attempt-2");
    await store.saveDiscoveredAccounts("attempt-2", accounts);

    failWrites = true;

    const request = {
      attemptId: "attempt-2",
      state: "state-secret",
      accounts,
      selectedAccountIds: ["one"],
    };

    await assert.rejects(store.complete(request), rejectsWith("upstream_failure"));

    assert.deepEqual(await store.get("attempt-2"), attempt("attempt-2"));
    assert.deepEqual(await store.getDiscoveredAccounts("attempt-2"), accounts);

    failWrites = false;
    const grants = await store.complete(request);
    assert.equal(grants.length, 1);
  });

  it("rejects completion after expiry and refuses expired discovery claims", async () => {
    const clock = new Clock();
    const stores = openSqlite(sqliteFile(), clock.now);
    await stores.driver.createSchema();
    const accounts = [account("one")];

    await stores.connections.save(attempt("attempt-3"));
    await stores.connections.save(attempt("attempt-4"));
    await stores.connections.claimDiscovery("attempt-3");
    await stores.connections.saveDiscoveredAccounts("attempt-3", accounts);

    clock.time += 10 * 60 * 1000;
    await assert.rejects(
      stores.connections.complete({
        attemptId: "attempt-3",
        state: "state-secret",
        accounts,
        selectedAccountIds: ["one"],
      }),
      rejectsWith("timeout"),
    );
    assert.equal(await stores.connections.claimDiscovery("attempt-4"), false);
  });

  it("drives ConnectionManager end to end", async () => {
    const file = sqliteFile();
    const stores = openSqlite(file);
    await stores.driver.createSchema();
    const accounts = [account("one"), account("two")];
    let exchanges = 0;

    const provider = {
      start: async () => ({ authorizationUrl: "https://provider.test/authorize" }),
      complete: async () => {
        exchanges++;

        return accounts;
      },
    };

    const manager = new ConnectionManager({ store: stores.connections });
    const allowedRedirectUris = ["https://app.test/callback"];

    const started = await manager.begin({
      backend: "direct",
      tenantId: "tenant-1",
      principalId: "user-1",
      platforms: ["youtube"],
      redirectUri: "https://app.test/callback",
      allowedRedirectUris,
      provider,
    });

    const callback = {
      attemptId: started.attempt.id,
      tenantId: "tenant-1",
      principalId: "user-1",
      callbackUrl: "https://app.test/callback?code=abc",
      returnedState: started.attempt.state,
      allowedRedirectUris,
      provider,
    };

    assert.deepEqual(await manager.discover(callback), accounts);
    const restarted = new ConnectionManager({ store: openSqlite(file).connections });
    assert.deepEqual(await restarted.discover(callback), accounts);
    assert.equal(exchanges, 1);

    const grants = await restarted.select({ ...callback, selectedAccountIds: ["one", "two"] });
    assert.equal(grants.length, 2);
    await assert.rejects(restarted.select({ ...callback, selectedAccountIds: ["one"] }));
  });
});

/**
 * Executes {@link redisDurableScripts} with JavaScript equivalents of their Lua,
 * one script at a time like Redis does. It checks the driver and store logic,
 * not the Lua source.
 */
class ScriptedRedis implements RedisScriptRunner {
  readonly hashes = new Map<string, { r: string; b: string }>();
  readonly strings = new Map<string, { value: string; expiresAt: number }>();
  time = 0;

  #live(key: string): string | undefined {
    const entry = this.strings.get(key);

    if (entry !== undefined && entry.expiresAt <= this.time) this.strings.delete(key);

    return this.strings.get(key)?.value;
  }

  async eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<readonly unknown[]> {
    assert.equal(keys.length, 1, "every script must touch exactly one key");
    const key = keys[0] ?? "";
    const [first = "", second = "", third = ""] = args;

    switch (script) {
      case redisDurableScripts.read: {
        const hash = this.hashes.get(key);

        return hash === undefined ? [] : [hash.r, hash.b];
      }

      case redisDurableScripts.write: {
        const current = this.hashes.get(key)?.r;

        if (first === "" ? current !== undefined : current !== first) return [0];
        this.hashes.set(key, { r: second, b: third });

        return [1];
      }

      case redisDurableScripts.remove: {
        if (first !== "" && this.hashes.get(key)?.r !== first) return [0];

        return [this.hashes.delete(key) ? 1 : 0];
      }

      case redisDurableScripts.acquireLease:
        if (this.#live(key) !== undefined) return [0];
        this.strings.set(key, { value: first, expiresAt: this.time + Number(second) });

        return [1];
      case redisDurableScripts.renewLease:
        if (this.#live(key) !== first) return [0];
        this.strings.set(key, { value: first, expiresAt: this.time + Number(second) });

        return [1];
      case redisDurableScripts.releaseLease:
        if (this.#live(key) !== first) return [0];
        this.strings.delete(key);

        return [1];
      default:
        throw new Error("unexpected script");
    }
  }
}

describe("Redis driver with a scripted runner", () => {
  it("keeps namespaces apart and supports credential CAS and leases", async () => {
    const redis = new ScriptedRedis();
    const stores = createRedisStores({ runner: redis, prefix: "app:" });

    const created = await stores.credentials.compareAndSet({
      key: "acct",
      expectedRevision: undefined,
      value: credential,
    });

    assert.ok(redis.hashes.has("app:credential:acct"));
    assert.equal(
      (
        await stores.credentials.compareAndSet({
          key: "acct",
          expectedRevision: "stale",
          value: credential,
        })
      ).updated,
      false,
    );
    assert.deepEqual(
      await createRedisStores({ runner: redis, prefix: "app:" }).credentials.get("acct"),
      {
        value: credential,
        revision: created.revision,
      },
    );
    assert.equal(await stores.connections.get("acct"), undefined);

    const lease = await stores.credentialLock.acquire("acct", 100);
    assert.ok(lease);
    assert.ok(redis.strings.has("app:credential-lease:acct"));
    assert.equal(await stores.credentialLock.acquire("acct", 100), undefined);
    redis.time += 100;
    const next = await stores.credentialLock.acquire("acct", 100);
    assert.ok(next);
    await stores.credentialLock.release(lease);
    assert.equal(await stores.credentialLock.acquire("acct", 100), undefined);
    await stores.credentialLock.release(next);
    assert.ok(await stores.credentialLock.acquire("acct", 100));
  });

  it("merges concurrent outcomes and completes connections", async () => {
    const redis = new ScriptedRedis();
    const stores = createRedisStores({ runner: redis });
    const input = { scope: "s", key: "k", fingerprint: "f", targetKeys: ["a", "b"] };
    const claimed = await stores.idempotency.claim(input);

    if (claimed.kind === "conflict") assert.fail("expected a new claim");
    const racing = new DurableIdempotencyStore({ driver: interleaving(stores.driver) });

    await Promise.all([
      racing.saveOutcome({
        claimId: claimed.claimId,
        targetKey: "a",
        outcome: published(0, "acct-a"),
      }),
      racing.saveOutcome({
        claimId: claimed.claimId,
        targetKey: "b",
        outcome: published(1, "acct-b"),
      }),
    ]);
    const replay = await stores.idempotency.claim(input);
    assert.equal(replay.kind, "existing");
    assert.deepEqual(replay.kind === "existing" ? Object.keys(replay.outcomes).sort() : [], [
      "a",
      "b",
    ]);

    const clock = new Clock();
    const connections = createRedisStores({ runner: redis, now: clock.now }).connections;
    await connections.save(attempt("attempt-r"));
    assert.equal(await connections.claimDiscovery("attempt-r"), true);
    await connections.saveDiscoveredAccounts("attempt-r", [account("one")]);

    const grants = await connections.complete({
      attemptId: "attempt-r",
      state: "state-secret",
      accounts: [account("one")],
      selectedAccountIds: ["one"],
    });

    clock.time += 60 * 60 * 1000;
    assert.deepEqual(await connections.getGrant(grants[0]?.grantId ?? ""), grants[0]);
  });
});
