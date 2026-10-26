import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CredentialStore } from "../src/core/adapter.js";
import { SocialError, type SocialErrorCode } from "../src/core/errors.js";
import {
  CredentialManager,
  MemoryCredentialLock,
  MemoryCredentialStore,
  type CredentialManagerOptions,
  type CredentialReconnectRequiredEvent,
  type CredentialRefreshFailureEvent,
  type CredentialRefreshRequest,
  type StoredCredential,
} from "../src/server/credentials.js";

const start = Date.parse("2026-10-24T12:00:00.000Z");

const secretAccess = "access-secret-1";

const secretRefresh = "refresh-secret-1";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};

  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });

  return { promise, resolve };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function harness(options: Partial<CredentialManagerOptions> = {}) {
  let now = start;
  const clock = (): Date => new Date(now);
  const store = new MemoryCredentialStore();
  const lock = new MemoryCredentialLock({ clock });
  const reconnects: CredentialReconnectRequiredEvent[] = [];
  const failures: CredentialRefreshFailureEvent[] = [];
  const requests: CredentialRefreshRequest[] = [];

  const managerOptions: CredentialManagerOptions = {
    clock,
    lockTtlMs: 60_000,
    refreshTimeoutMs: 60_000,
    onReconnectRequired: (event) => {
      reconnects.push(event);
    },
    onRefreshFailure: (event) => {
      failures.push(event);
    },
    refresh: async (request) => {
      requests.push(request);

      return {
        ...request.credential,
        accessToken: `access-${requests.length + 1}`,
        expiresAt: iso(now + 3_600_000),
      };
    },
    ...options,
  };

  return {
    store,
    lock,
    reconnects,
    failures,
    requests,
    clock,
    advance(ms: number) {
      now += ms;
    },
    manager: (overrides: Partial<CredentialManagerOptions> = {}) =>
      new CredentialManager(store, lock, { ...managerOptions, ...overrides }),
  };
}

const expiring: StoredCredential = {
  accessToken: secretAccess,
  refreshToken: secretRefresh,
  expiresAt: iso(start + 30_000),
  scopes: ["write"],
};

function isCode(code: SocialErrorCode) {
  return (error: unknown): error is SocialError =>
    error instanceof SocialError && error.code === code;
}

function assertNoSecrets(
  value: readonly (CredentialRefreshFailureEvent | CredentialReconnectRequiredEvent)[],
): void {
  const text = JSON.stringify(value);

  assert.ok(!text.includes("secret"), text);
}

/** An uncertain refresh throws a new error that carries nothing from the provider or store. */
function isSanitized(code: SocialErrorCode) {
  return (error: unknown): error is SocialError => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.deepEqual(error.retryDisposition, { kind: "after-reconnect" });
    const text = [error.message, error.stack, JSON.stringify(error), JSON.stringify(error.details)];

    for (const part of text) assert.ok(!part?.includes("secret"), part);

    return true;
  };
}

describe("credential manager options", () => {
  test("keeps the positional constructor and raw get", async () => {
    const store = new MemoryCredentialStore();
    const legacy = new CredentialManager(store, new MemoryCredentialLock());
    const withTtl = new CredentialManager(store, new MemoryCredentialLock(), 5_000);

    await legacy.save("a", { accessToken: "x", expiresAt: "2000-01-01T00:00:00Z" });

    // get returns the stored record without expiry checks.
    assert.equal((await withTtl.get("a"))?.value.accessToken, "x");
  });

  test("rejects invalid timing options", () => {
    const store = new MemoryCredentialStore();
    const lock = new MemoryCredentialLock();

    for (const options of [
      { refreshSkewMs: 0 },
      { refreshSkewMs: -1 },
      { refreshSkewMs: Number.NaN },
      { lockTtlMs: 0 },
      { refreshTimeoutMs: 1.5 },
      { lockTtlMs: 1_000, refreshTimeoutMs: 2_000 },
    ])
      assert.throws(() => new CredentialManager(store, lock, options), isCode("invalid_config"));

    assert.throws(() => new CredentialManager(store, lock, -5), isCode("invalid_config"));
  });

  test("rejects malformed expiry on save and on read", async () => {
    const h = harness();
    const manager = h.manager();

    for (const expiresAt of ["tomorrow", "2026-10-24", "2026-13-45T00:00:00Z", ""])
      await assert.rejects(
        manager.save("a", { accessToken: "x", expiresAt }),
        isCode("invalid_input"),
      );

    assert.equal(await h.store.get("a"), undefined);

    // A record written around the manager is validated when resolved.
    await h.store.compareAndSet({
      key: "a",
      expectedRevision: undefined,
      value: { accessToken: secretAccess, expiresAt: "soon" },
    });
    await assert.rejects(manager.resolve("a"), isCode("invalid_input"));
    assert.deepEqual(
      h.reconnects.map((event) => event.reason),
      ["invalid-credential"],
    );
  });
});

describe("expiry-aware resolve", () => {
  test("treats a credential without expiresAt as non-expiring", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", { accessToken: secretAccess, refreshToken: secretRefresh });
    h.advance(365 * 24 * 3_600_000);

    const resolved = await manager.resolve("a");

    assert.equal(resolved.freshness, "non-expiring");
    assert.equal(h.requests.length, 0);
  });

  test("returns a fresh credential without refreshing", async () => {
    const h = harness();
    const manager = h.manager();
    const revision = await manager.save("a", { ...expiring, expiresAt: iso(start + 120_000) });

    const resolved = await manager.resolve("a");

    assert.deepEqual(resolved, {
      value: { ...expiring, expiresAt: iso(start + 120_000) },
      revision,
      freshness: "fresh",
    });
    assert.equal(h.requests.length, 0);
  });

  test("refreshes once inside the skew window and stores the result", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", expiring);

    const resolved = await manager.resolve("a");

    assert.equal(resolved.freshness, "refreshed");
    assert.equal(resolved.value.accessToken, "access-2");
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.requests[0]?.credential, expiring);
    assert.equal(h.requests[0]?.signal.aborted, false);

    const stored = await h.store.get("a");
    assert.equal(stored?.revision, resolved.revision);
    assert.deepEqual(stored?.value, resolved.value);
    assert.equal(stored?.value.refreshState, undefined);

    assert.equal((await manager.resolve("a")).freshness, "fresh");
    assert.equal(h.requests.length, 1);
  });

  test("honors a custom skew", async () => {
    const h = harness();
    const manager = h.manager({ refreshSkewMs: 10_000 });
    await manager.save("a", expiring);

    assert.equal((await manager.resolve("a")).freshness, "fresh");
    h.advance(20_001);
    assert.equal((await manager.resolve("a")).freshness, "refreshed");
  });

  test("does not refresh again after another worker already refreshed", async () => {
    const h = harness();
    await h.manager().save("a", expiring);
    const stale = await h.store.get("a");
    assert.ok(stale !== undefined);

    // Worker B read the record before worker A finished refreshing.
    let staleReads = 1;

    const staleView: CredentialStore<StoredCredential> = {
      get: async (key) => (staleReads-- > 0 ? stale : h.store.get(key)),
      compareAndSet: (input) => h.store.compareAndSet(input),
      delete: (key) => h.store.delete(key),
    };

    const refreshed = await h.manager().resolve("a");

    const workerB = new CredentialManager(staleView, h.lock, {
      clock: h.clock,
      refresh: async () => {
        throw new Error("worker B must not refresh");
      },
    });

    const resolved = await workerB.resolve("a");

    assert.equal(resolved.freshness, "fresh");
    assert.deepEqual(resolved.value, refreshed.value);
    assert.equal(h.requests.length, 1);
  });

  test("concurrent resolves call the provider once", async () => {
    const gate = deferred<StoredCredential>();
    let calls = 0;

    const h = harness({
      refresh: async () => {
        calls++;

        return gate.promise;
      },
    });

    const a = h.manager();
    const b = h.manager();
    await a.save("a", expiring);

    const first = a.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));

    await assert.rejects(b.resolve("a"), (error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "upstream_failure");
      assert.equal(error.retryDisposition.kind, "after-delay");

      return true;
    });

    gate.resolve({ ...expiring, accessToken: "next", expiresAt: iso(start + 3_600_000) });
    assert.equal((await first).value.accessToken, "next");
    assert.equal((await b.resolve("a")).freshness, "fresh");
    assert.equal(calls, 1);
  });

  test("token expiry never deletes the stored record", async () => {
    const h = harness();
    const manager = h.manager();
    const value = { accessToken: secretAccess, expiresAt: iso(start - 1) };
    await manager.save("a", value);

    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    assert.deepEqual((await h.store.get("a"))?.value, value);
    assert.deepEqual(
      h.reconnects.map((event) => event.reason),
      ["missing-refresh-token"],
    );
    assert.equal(h.requests.length, 0);
  });

  test("requires reconnect when no refresher is configured or nothing is stored", async () => {
    const h = harness();

    const manager = new CredentialManager(h.store, h.lock, {
      clock: h.clock,
      onReconnectRequired: (event) => {
        h.reconnects.push(event);
      },
    });

    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    await assert.rejects(manager.resolve("missing"), isCode("reconnect_required"));
    assert.deepEqual(
      h.reconnects.map((event) => [event.key, event.reason]),
      [
        ["a", "refresh-unavailable"],
        ["missing", "missing-credential"],
      ],
    );
    assert.equal((await h.store.get("a"))?.value.refreshState, undefined);
  });
});

describe("refresh failures", () => {
  test("a definite provider rejection restores the credential and allows a later refresh", async () => {
    const rejection = new SocialError({
      code: "rate_limited",
      operation: "x.oauth.refresh",
      message: "Slow down",
      retryDisposition: { kind: "after-delay", delayMs: 1_000 },
    });

    let fail = true;

    const h = harness({
      refresh: async (request) => {
        if (fail) throw rejection;

        return { ...request.credential, accessToken: "next", expiresAt: iso(start + 3_600_000) };
      },
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), (error) => error === rejection);
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
    assert.deepEqual(h.failures, [
      { key: "a", outcome: "rejected", code: "rate_limited", observedAt: iso(start) },
    ]);
    assert.deepEqual(h.reconnects, []);

    fail = false;
    assert.equal((await manager.resolve("a")).value.accessToken, "next");
  });

  test("a reconnect rejection notifies reconnect with safe metadata", async () => {
    const h = harness({
      refresh: async () => {
        throw new SocialError({
          code: "reconnect_required",
          operation: "x.oauth.refresh",
          message: "invalid_grant",
        });
      },
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    assert.deepEqual(h.reconnects, [
      { key: "a", reason: "refresh-rejected", observedAt: iso(start) },
    ]);
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
  });

  test("an ambiguous failure marks the credential uncertain and never refreshes it again", async () => {
    const original = new Error(`socket closed while sending ${secretRefresh}`);
    let calls = 0;

    const h = harness({
      refresh: async () => {
        calls++;
        throw original;
      },
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), isSanitized("ambiguous_outcome"));
    assert.deepEqual((await h.store.get("a"))?.value.refreshState, {
      state: "uncertain",
      since: iso(start),
    });
    assert.deepEqual(h.failures, [
      { key: "a", outcome: "uncertain", code: "ambiguous_outcome", observedAt: iso(start) },
    ]);
    assert.deepEqual(
      h.reconnects.map((event) => event.reason),
      ["refresh-uncertain"],
    );
    assertNoSecrets(h.failures);
    assertNoSecrets(h.reconnects);

    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    await assert.rejects(h.manager().resolve("a"), isCode("reconnect_required"));
    assert.equal(calls, 1);

    // Saving a reconnected credential clears the marker.
    const current = await h.store.get("a");
    await manager.save(
      "a",
      { accessToken: "fresh", refreshToken: "r2", expiresAt: iso(start + 3_600_000) },
      current?.revision,
    );
    assert.equal((await manager.resolve("a")).freshness, "fresh");
  });

  test("a timed-out refresh aborts, marks uncertain, and ignores a late answer", async () => {
    const late = deferred<StoredCredential>();
    let signal: AbortSignal | undefined;
    let calls = 0;

    const h = harness({
      lockTtlMs: 50,
      refreshTimeoutMs: 10,
      refresh: async (request) => {
        calls++;
        signal = request.signal;

        return late.promise;
      },
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), isCode("timeout"));
    assert.equal(signal?.aborted, true);
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "uncertain");

    late.resolve({ ...expiring, accessToken: "late", expiresAt: iso(start + 3_600_000) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.store.get("a"))?.value.accessToken, secretAccess);

    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    assert.equal(calls, 1);
  });

  test("an expired lock lease does not allow an overlapping refresh", async () => {
    const gate = deferred<StoredCredential>();
    let calls = 0;

    const h = harness({
      lockTtlMs: 1_000,
      refreshTimeoutMs: 1_000,
      refresh: async () => {
        calls++;

        return gate.promise;
      },
    });

    const a = h.manager();
    await a.save("a", expiring);

    const first = a.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));

    // The lease has expired on the shared clock while A is still waiting on the provider.
    h.advance(1_001);

    const b = h.manager({
      refresh: async () => {
        calls++;
        throw new Error("must not run");
      },
    });

    // A's marker deadline has also passed, so B fails closed instead of refreshing.
    await assert.rejects(b.resolve("a"), isCode("reconnect_required"));
    assert.equal(calls, 1);

    // A still finishes its own request and saves through compare-and-set.
    gate.resolve({ ...expiring, accessToken: "next", expiresAt: iso(start + 3_600_000) });
    assert.equal((await first).value.accessToken, "next");
  });

  test("an in-flight marker blocks other workers until its deadline", async () => {
    const gate = deferred<StoredCredential>();

    const h = harness({
      lockTtlMs: 1_000,
      refreshTimeoutMs: 1_000,
      refresh: async () => gate.promise,
    });

    const a = h.manager();
    await a.save("a", expiring);
    const first = a.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));

    // A worker using another lock, or after a lock outage, still sees the persisted marker.
    h.advance(500);

    const other = new CredentialManager(h.store, new MemoryCredentialLock({ clock: h.clock }), {
      clock: h.clock,
      refresh: async () => {
        throw new Error("must not run");
      },
    });

    await assert.rejects(other.resolve("a"), (error) => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "upstream_failure");
      assert.deepEqual(error.retryDisposition, { kind: "after-delay", delayMs: 500 });

      return true;
    });

    gate.resolve({ ...expiring, accessToken: "next", expiresAt: iso(start + 3_600_000) });
    await first;
  });

  test("caller cancellation before refresh writes nothing; during refresh marks uncertain", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", expiring);

    const before = new AbortController();
    before.abort();
    await assert.rejects(manager.resolve("a", { signal: before.signal }), isCode("cancelled"));
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
    assert.equal(h.requests.length, 0);

    const during = new AbortController();
    const gate = deferred<StoredCredential>();
    let providerSignal: AbortSignal | undefined;

    const cancelling = h.manager({
      refresh: async (request) => {
        providerSignal = request.signal;
        during.abort();

        return gate.promise;
      },
    });

    await assert.rejects(cancelling.resolve("a", { signal: during.signal }), isCode("cancelled"));
    assert.equal(providerSignal?.aborted, true);
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "uncertain");
  });

  test("an invalid refresh result is not saved and marks the credential uncertain", async () => {
    const h = harness({
      refresh: async (request) => ({ ...request.credential, expiresAt: "later" }),
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), isCode("upstream_failure"));
    const stored = await h.store.get("a");
    assert.equal(stored?.value.expiresAt, expiring.expiresAt);
    assert.equal(stored?.value.refreshState?.state, "uncertain");
  });

  test("a concurrent save during refresh wins and the refresh reports an ambiguous outcome", async () => {
    const gate = deferred<StoredCredential>();
    const h = harness({ refresh: async () => gate.promise });
    const manager = h.manager();
    await manager.save("a", expiring);

    const pending = manager.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));
    const marked = await h.store.get("a");
    const reconnected = { accessToken: "user-reconnected", expiresAt: iso(start + 3_600_000) };
    await manager.save("a", reconnected, marked?.revision);

    gate.resolve({ ...expiring, accessToken: "lost", expiresAt: iso(start + 3_600_000) });
    await assert.rejects(pending, isCode("ambiguous_outcome"));
    assert.deepEqual((await h.store.get("a"))?.value, reconnected);
    assert.equal(h.failures[0]?.outcome, "uncertain");
  });

  test("throwing notification callbacks do not mask the original failure", async () => {
    const rejection = new SocialError({
      code: "reconnect_required",
      operation: "x.oauth.refresh",
      message: "invalid_grant",
    });

    const h = harness({
      refresh: async () => {
        throw rejection;
      },
      onRefreshFailure: () => {
        throw new Error("sink down");
      },
      onReconnectRequired: async () => {
        throw new Error("sink down");
      },
    });

    const manager = h.manager();
    await manager.save("a", expiring);

    await assert.rejects(manager.resolve("a"), (error) => error === rejection);
    await assert.rejects(manager.resolve("missing"), isCode("reconnect_required"));
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
  });
});

describe("fenced rotate", () => {
  test("rotates a non-expiring credential on request and clears the marker", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", { accessToken: secretAccess, refreshToken: secretRefresh });
    const seen: StoredCredential[] = [];

    const next = await manager.rotate("a", async (current) => {
      seen.push(current);

      return { ...current, accessToken: "rotated" };
    });

    assert.deepEqual(seen, [{ accessToken: secretAccess, refreshToken: secretRefresh }]);
    assert.equal(next.accessToken, "rotated");
    assert.deepEqual((await h.store.get("a"))?.value, {
      accessToken: "rotated",
      refreshToken: secretRefresh,
    });
  });

  test("persists the in-flight marker before calling the rotation callback", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", { accessToken: secretAccess });
    let marker: StoredCredential["refreshState"];

    await manager.rotate("a", async (current) => {
      marker = (await h.store.get("a"))?.value.refreshState;

      return { ...current, accessToken: "rotated" };
    });

    assert.deepEqual(marker, {
      state: "in-flight",
      startedAt: iso(start),
      deadline: iso(start + 60_000),
    });
  });

  test("does not rotate while another refresh is in flight, even after the lease expires", async () => {
    const gate = deferred<StoredCredential>();

    const h = harness({
      lockTtlMs: 1_000,
      refreshTimeoutMs: 1_000,
      refresh: async () => gate.promise,
    });

    const a = h.manager();
    await a.save("a", expiring);
    const pending = a.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));
    let rotations = 0;

    const rotate = (manager: CredentialManager) =>
      manager.rotate("a", async (current) => {
        rotations++;

        return current;
      });

    // Same lock, lease still held.
    await assert.rejects(rotate(h.manager()), isCode("upstream_failure"));

    // Another lock instance: the persisted marker still fences.
    const otherLock = new CredentialManager(h.store, new MemoryCredentialLock({ clock: h.clock }), {
      clock: h.clock,
    });

    await assert.rejects(rotate(otherLock), isCode("upstream_failure"));

    // The lease and the marker deadline have both passed: fail closed.
    h.advance(1_001);
    await assert.rejects(rotate(h.manager()), isCode("reconnect_required"));
    assert.equal(rotations, 0);

    gate.resolve({ ...expiring, accessToken: "next", expiresAt: iso(start + 3_600_000) });
    await pending;
  });

  test("an ambiguous rotation failure fences later rotations and resolves", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", expiring);
    const original = new Error(`connection reset after ${secretRefresh}`);
    let rotations = 0;

    await assert.rejects(
      manager.rotate("a", async () => {
        rotations++;
        throw original;
      }),
      isSanitized("ambiguous_outcome"),
    );
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "uncertain");
    assert.deepEqual(
      h.reconnects.map((event) => event.reason),
      ["refresh-uncertain"],
    );

    await assert.rejects(
      manager.rotate("a", async (current) => {
        rotations++;

        return current;
      }),
      isCode("reconnect_required"),
    );
    await assert.rejects(manager.resolve("a"), isCode("reconnect_required"));
    assert.equal(rotations, 1);
    assert.equal(h.requests.length, 0);
  });

  test("a definite rotation rejection restores the credential", async () => {
    const h = harness();
    const manager = h.manager();
    await manager.save("a", expiring);
    const rejection = new SocialError({ code: "rate_limited", operation: "x", message: "Later" });

    await assert.rejects(
      manager.rotate("a", async () => {
        throw rejection;
      }),
      (error) => error === rejection,
    );
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
  });

  test("a rotation that outlives its deadline times out and marks uncertain", async () => {
    const late = deferred<StoredCredential>();
    const h = harness({ lockTtlMs: 50, refreshTimeoutMs: 10 });
    const manager = h.manager();
    await manager.save("a", { accessToken: secretAccess });

    await assert.rejects(
      manager.rotate("a", async () => late.promise),
      isCode("timeout"),
    );
    late.resolve({ accessToken: "late" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await h.store.get("a"))?.value.accessToken, secretAccess);
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "uncertain");
  });
});

describe("result persistence failures", () => {
  function failingResultWrites(
    h: ReturnType<typeof harness>,
    failure: Error,
    scope: "result-only" | "every-write-after-marker",
  ): CredentialStore<StoredCredential> {
    let markerWritten = false;

    return {
      get: (key) => h.store.get(key),
      compareAndSet: async (input) => {
        if (input.value.refreshState?.state === "in-flight") {
          markerWritten = true;

          return h.store.compareAndSet(input);
        }

        if (
          markerWritten &&
          (scope === "every-write-after-marker" || input.value.refreshState === undefined)
        )
          throw failure;

        return h.store.compareAndSet(input);
      },
      delete: (key) => h.store.delete(key),
    };
  }

  test("a throwing result write notifies, keeps the uncertainty marker, and throws a sanitized error", async () => {
    const h = harness();
    await h.manager().save("a", expiring);
    const failure = new Error(`database unavailable writing ${secretRefresh}`);

    const manager = new CredentialManager(failingResultWrites(h, failure, "result-only"), h.lock, {
      clock: h.clock,
      refresh: async (request) => ({
        ...request.credential,
        accessToken: "next",
        expiresAt: iso(start + 3_600_000),
      }),
      onRefreshFailure: (event) => {
        h.failures.push(event);
      },
      onReconnectRequired: (event) => {
        h.reconnects.push(event);
      },
    });

    await assert.rejects(manager.resolve("a"), isSanitized("ambiguous_outcome"));
    assert.deepEqual(h.failures, [
      { key: "a", outcome: "uncertain", code: "ambiguous_outcome", observedAt: iso(start) },
    ]);
    assert.deepEqual(
      h.reconnects.map((event) => event.reason),
      ["refresh-uncertain"],
    );
    assert.deepEqual((await h.store.get("a"))?.value.refreshState, {
      state: "uncertain",
      since: iso(start),
    });
    await assert.rejects(h.manager().resolve("a"), isCode("reconnect_required"));
  });

  test("if the store stays down the in-flight marker remains and expires into uncertainty", async () => {
    const h = harness({ lockTtlMs: 1_000, refreshTimeoutMs: 1_000 });
    await h.manager().save("a", expiring);
    const failure = new Error(`database unavailable writing ${secretRefresh}`);
    let calls = 0;

    const manager = new CredentialManager(
      failingResultWrites(h, failure, "every-write-after-marker"),
      h.lock,
      {
        clock: h.clock,
        lockTtlMs: 1_000,
        refreshTimeoutMs: 1_000,
        refresh: async (request) => {
          calls++;

          return { ...request.credential, accessToken: "next" };
        },
      },
    );

    await assert.rejects(manager.resolve("a"), isSanitized("ambiguous_outcome"));
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "in-flight");
    await assert.rejects(h.manager().resolve("a"), isCode("upstream_failure"));
    h.advance(1_001);
    await assert.rejects(h.manager().resolve("a"), isCode("reconnect_required"));
    assert.equal(calls, 1);
    assert.equal(h.requests.length, 0);
  });

  test("throwing callbacks and a failing lock release do not mask the store failure", async () => {
    const h = harness();
    await h.manager().save("a", expiring);
    const failure = new Error(`database unavailable writing ${secretRefresh}`);

    const lock = {
      acquire: (key: string, ttlMs: number) => h.lock.acquire(key, ttlMs),
      release: async () => {
        throw new Error("lock backend down");
      },
    };

    const manager = new CredentialManager(failingResultWrites(h, failure, "result-only"), lock, {
      clock: h.clock,
      refresh: async (request) => ({
        ...request.credential,
        accessToken: "next",
        expiresAt: iso(start + 3_600_000),
      }),
      onRefreshFailure: () => {
        throw new Error("sink down");
      },
      onReconnectRequired: async () => {
        throw new Error("sink down");
      },
    });

    await assert.rejects(manager.resolve("a"), isSanitized("ambiguous_outcome"));
    assert.equal((await h.store.get("a"))?.value.refreshState?.state, "uncertain");
  });
});

describe("cancellation before the provider call", () => {
  type Stage = "lock-acquire" | "locked-read" | "marker-write";

  async function abortDuring(stage: Stage) {
    const h = harness();
    await h.manager().save("a", expiring);
    const gate = deferred<void>();
    const reached = deferred<void>();
    let reads = 0;

    const store: CredentialStore<StoredCredential> = {
      get: async (key) => {
        reads++;

        if (stage === "locked-read" && reads === 2) {
          reached.resolve();
          await gate.promise;
        }

        return h.store.get(key);
      },
      compareAndSet: async (input) => {
        if (stage === "marker-write" && input.value.refreshState?.state === "in-flight") {
          reached.resolve();
          await gate.promise;
        }

        return h.store.compareAndSet(input);
      },
      delete: (key) => h.store.delete(key),
    };

    const lock = {
      acquire: async (key: string, ttlMs: number) => {
        if (stage === "lock-acquire") {
          reached.resolve();
          await gate.promise;
        }

        return h.lock.acquire(key, ttlMs);
      },
      release: (lease: Parameters<MemoryCredentialLock["release"]>[0]) => h.lock.release(lease),
    };

    const manager = new CredentialManager(store, lock, {
      clock: h.clock,
      refresh: async (request) => {
        h.requests.push(request);

        return request.credential;
      },
      onRefreshFailure: (event) => {
        h.failures.push(event);
      },
      onReconnectRequired: (event) => {
        h.reconnects.push(event);
      },
    });

    const controller = new AbortController();
    const pending = manager.resolve("a", { signal: controller.signal });
    await reached.promise;
    controller.abort();
    gate.resolve();

    await assert.rejects(pending, isCode("cancelled"));
    assert.equal(h.requests.length, 0);
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
    assert.deepEqual(h.failures, []);
    assert.deepEqual(h.reconnects, []);

    // Nothing was left fenced: a later resolve refreshes normally.
    assert.equal((await h.manager().resolve("a")).freshness, "refreshed");
  }

  test("aborting while the lock is being acquired never calls the provider", () =>
    abortDuring("lock-acquire"));

  test("aborting during the read under the lock never calls the provider", () =>
    abortDuring("locked-read"));

  test("aborting while the in-flight marker is written restores the credential", () =>
    abortDuring("marker-write"));
});

describe("revoke", () => {
  test("keeps a credential reconnected during revocation and reports the conflict", async () => {
    const h = harness();
    let manager: CredentialManager | undefined;
    const reconnected = { accessToken: "reconnected-b", expiresAt: iso(start + 3_600_000) };

    manager = h.manager({
      revoke: async () => {
        const current = await h.store.get("a");
        await manager?.save("a", reconnected, current?.revision);
      },
    });
    await manager.save("a", expiring);

    await assert.rejects(manager.revoke("a"), (error: unknown): error is SocialError => {
      assert.ok(error instanceof SocialError);
      assert.equal(error.code, "upstream_failure");
      assert.deepEqual(error.details, { reason: "credential-replaced" });

      return true;
    });
    assert.deepEqual((await h.store.get("a"))?.value, reconnected);
  });

  test("succeeds when the record was deleted during revocation", async () => {
    const h = harness();

    const manager = h.manager({
      revoke: async () => {
        await h.store.delete("a");
      },
    });

    await manager.save("a", expiring);

    await manager.revoke("a");
    assert.equal(await h.store.get("a"), undefined);
  });

  test("refuses to revoke through a store without conditional delete", async () => {
    const h = harness();
    await h.manager().save("a", expiring);
    let revokes = 0;

    const legacyStore: CredentialStore<StoredCredential> = {
      get: (key) => h.store.get(key),
      compareAndSet: (input) => h.store.compareAndSet(input),
      delete: (key) => h.store.delete(key),
    };

    const manager = new CredentialManager(legacyStore, h.lock, {
      clock: h.clock,
      revoke: async () => {
        revokes++;
      },
    });

    await assert.rejects(manager.revoke("a"), isCode("invalid_config"));
    assert.equal(revokes, 0);
    assert.deepEqual((await h.store.get("a"))?.value, expiring);
    assert.notEqual(await h.lock.acquire("a", 1), undefined);
  });

  test("revokes at the provider before deleting locally", async () => {
    const order: string[] = [];
    const revoked: StoredCredential[] = [];
    const h = harness();

    const manager = h.manager({
      revoke: async (request) => {
        order.push("provider");
        revoked.push(request.credential);
        assert.ok((await h.store.get("a")) !== undefined);
      },
    });

    await manager.save("a", expiring);

    await manager.revoke("a");
    order.push("done");

    assert.deepEqual(order, ["provider", "done"]);
    assert.deepEqual(revoked, [expiring]);
    assert.equal(await h.store.get("a"), undefined);

    // Revoking an absent credential is a no-op.
    await manager.revoke("a");
    assert.equal(revoked.length, 1);
  });

  test("keeps local state when provider revocation fails", async () => {
    const failure = new SocialError({
      code: "upstream_failure",
      operation: "x.oauth.revoke",
      message: "Provider unavailable",
    });

    const h = harness();

    const manager = h.manager({
      revoke: async () => {
        throw failure;
      },
    });

    await manager.save("a", expiring);

    await assert.rejects(manager.revoke("a"), (error) => error === failure);
    assert.deepEqual((await h.store.get("a"))?.value, expiring);

    // The lock was released, so a retry is possible.
    assert.notEqual(await h.lock.acquire("a", 1), undefined);
  });

  test("does not revoke while a refresh is in flight", async () => {
    const gate = deferred<StoredCredential>();
    let revokes = 0;
    const h = harness({ refresh: async () => gate.promise });

    const manager = h.manager({
      revoke: async () => {
        revokes++;
      },
    });

    await manager.save("a", expiring);
    const pending = manager.resolve("a");
    await new Promise((resolve) => setImmediate(resolve));

    const revoker = new CredentialManager(h.store, new MemoryCredentialLock({ clock: h.clock }), {
      clock: h.clock,
      revoke: async () => {
        revokes++;
      },
    });

    await assert.rejects(revoker.revoke("a"), isCode("upstream_failure"));
    assert.equal(revokes, 0);

    gate.resolve({ ...expiring, accessToken: "next", expiresAt: iso(start + 3_600_000) });
    await pending;
    await revoker.revoke("a");
    assert.equal(revokes, 1);
    assert.equal(await h.store.get("a"), undefined);
  });
});
