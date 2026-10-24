import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CredentialStore } from "../src/core/adapter.js";
import { SocialError } from "../src/core/errors.js";
import { parseJson } from "../src/transport/json.js";
import {
  CredentialManager,
  MemoryCredentialLock,
  type StoredCredential,
} from "../src/server/credentials.js";
import {
  createEncryptedCredentialStore,
  parseEncryptedCredentialEnvelope,
  type CredentialEncryptionKey,
  type EncryptedCredentialEnvelope,
} from "../src/server/encrypted-credentials.js";

const accessToken = "access-token-super-secret";

const refreshToken = "refresh-token-super-secret";

const credential: StoredCredential = {
  accessToken,
  refreshToken,
  expiresAt: "2026-10-24T12:00:00Z",
  scopes: ["write"],
  metadata: { provider: "x" },
};

/** Generic CAS store that holds whatever it is given, like a JSON column would. */
class MemoryRecordStore<T> implements CredentialStore<T> {
  readonly records = new Map<string, { value: T; revision: string }>();
  #sequence = 0;

  async get(key: string): Promise<{ readonly value: T; readonly revision: string } | undefined> {
    return this.records.get(key);
  }

  async compareAndSet(input: {
    readonly key: string;
    readonly expectedRevision: string | undefined;
    readonly value: T;
  }): Promise<{ readonly updated: boolean; readonly revision?: string }> {
    if (this.records.get(input.key)?.revision !== input.expectedRevision) return { updated: false };
    const revision = `rev-${++this.#sequence}`;
    this.records.set(input.key, { value: input.value, revision });

    return { updated: true, revision };
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

function rawKey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function keyring(
  keys: Readonly<Record<string, CredentialEncryptionKey>>,
): (keyId: string) => Promise<CredentialEncryptionKey | undefined> {
  return async (keyId) => keys[keyId];
}

function setup(
  options: {
    readonly namespace?: string;
    readonly currentKeyId?: string;
    readonly keys?: Readonly<Record<string, CredentialEncryptionKey>>;
    readonly inner?: MemoryRecordStore<EncryptedCredentialEnvelope>;
  } = {},
) {
  const inner = options.inner ?? new MemoryRecordStore<EncryptedCredentialEnvelope>();

  const store = createEncryptedCredentialStore({
    store: inner,
    namespace: options.namespace ?? "tenant-a",
    currentKeyId: options.currentKeyId ?? "k1",
    resolveKey: keyring(options.keys ?? { k1: rawKey(1) }),
  });

  return { inner, store };
}

function envelope(
  inner: MemoryRecordStore<EncryptedCredentialEnvelope>,
  key: string,
): { value: EncryptedCredentialEnvelope; revision: string } {
  const found = inner.records.get(key);

  if (found === undefined) throw new Error(`No record for ${key}`);

  return found;
}

function base64UrlBytes(text: string): number {
  return Buffer.from(text, "base64url").length;
}

function assertSafeFailure(reason: string) {
  return (error: unknown): error is SocialError => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, "invalid_config");
    assert.equal(error.details?.["reason"], reason);
    assert.equal(error.cause, undefined);
    const text = `${error.message} ${JSON.stringify(error.toJSON())}`;
    assert.ok(!text.includes(accessToken));
    assert.ok(!text.includes(refreshToken));

    return true;
  };
}

describe("encrypted credential store", () => {
  test("round-trips a credential and stores only a versioned envelope", async () => {
    const { inner, store } = setup();

    const written = await store.compareAndSet({
      key: "acct-1",
      expectedRevision: undefined,
      value: credential,
    });

    assert.deepEqual(written, { updated: true, revision: "rev-1" });
    const stored = envelope(inner, "acct-1").value;

    assert.deepEqual(Object.keys(stored).sort(), [
      "algorithm",
      "ciphertext",
      "keyId",
      "nonce",
      "version",
    ]);
    assert.equal(stored.version, 1);
    assert.equal(stored.algorithm, "A256GCM");
    assert.equal(stored.keyId, "k1");
    assert.equal(base64UrlBytes(stored.nonce), 12);
    assert.ok(!JSON.stringify(stored).includes("secret"));

    assert.deepEqual(await store.get("acct-1"), { value: credential, revision: "rev-1" });
    assert.equal(await store.get("missing"), undefined);
  });

  test("preserves compare-and-set revisions and deletes", async () => {
    const { store } = setup();

    const first = await store.compareAndSet({
      key: "acct-1",
      expectedRevision: undefined,
      value: credential,
    });

    assert.deepEqual(
      await store.compareAndSet({
        key: "acct-1",
        expectedRevision: undefined,
        value: { accessToken: "other" },
      }),
      { updated: false },
    );
    assert.equal((await store.get("acct-1"))?.value.accessToken, accessToken);

    const second = await store.compareAndSet({
      key: "acct-1",
      expectedRevision: first.revision,
      value: { accessToken: "next" },
    });

    assert.equal(second.updated, true);
    assert.equal((await store.get("acct-1"))?.revision, second.revision);

    await store.delete("acct-1");
    assert.equal(await store.get("acct-1"), undefined);
  });

  test("uses a fresh nonce for every write", async () => {
    const { inner, store } = setup();
    const nonces = new Set<string>();
    const ciphertexts = new Set<string>();
    let revision: string | undefined;

    for (let index = 0; index < 5; index++) {
      const result = await store.compareAndSet({
        key: "acct-1",
        expectedRevision: revision,
        value: credential,
      });

      revision = result.revision;
      nonces.add(envelope(inner, "acct-1").value.nonce);
      ciphertexts.add(envelope(inner, "acct-1").value.ciphertext);
    }

    assert.equal(nonces.size, 5);
    assert.equal(ciphertexts.size, 5);
  });

  test("rejects a record moved to another store key", async () => {
    const { inner, store } = setup();
    await store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });
    await store.compareAndSet({
      key: "acct-2",
      expectedRevision: undefined,
      value: { accessToken: "victim" },
    });
    inner.records.set("acct-2", envelope(inner, "acct-1"));

    await assert.rejects(store.get("acct-2"), assertSafeFailure("decryption-failed"));
  });

  test("rejects a record read under another namespace", async () => {
    const inner = new MemoryRecordStore<EncryptedCredentialEnvelope>();
    const a = setup({ inner, namespace: "tenant-a" });
    const b = setup({ inner, namespace: "tenant-b" });
    await a.store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });

    await assert.rejects(b.store.get("acct-1"), assertSafeFailure("decryption-failed"));
  });

  test("rejects tampered ciphertext, nonce, and key id", async () => {
    const keys = { k1: rawKey(1), k2: rawKey(1) };
    const { inner, store } = setup({ keys });
    await store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });
    const original = envelope(inner, "acct-1");

    const flipped = Buffer.from(original.value.ciphertext, "base64url");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    inner.records.set("acct-1", {
      ...original,
      value: { ...original.value, ciphertext: flipped.toString("base64url") },
    });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("decryption-failed"));

    inner.records.set("acct-1", {
      ...original,
      value: { ...original.value, nonce: Buffer.alloc(12, 7).toString("base64url") },
    });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("decryption-failed"));

    // Same key bytes under another id: the id is authenticated, so this still fails.
    inner.records.set("acct-1", { ...original, value: { ...original.value, keyId: "k2" } });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("decryption-failed"));

    inner.records.set("acct-1", original);
    assert.equal((await store.get("acct-1"))?.value.accessToken, accessToken);
  });

  test("rejects unknown versions and malformed envelopes instead of reporting absence", async () => {
    const { inner, store } = setup();
    await store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });
    const original = envelope(inner, "acct-1");

    inner.records.set("acct-1", { ...original, value: { ...original.value, nonce: "short" } });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("malformed-envelope"));

    inner.records.set("acct-1", { ...original, value: { ...original.value, keyId: "" } });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("malformed-envelope"));

    inner.records.set("acct-1", { ...original, value: { ...original.value, ciphertext: "AAAA" } });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("malformed-envelope"));

    // Untyped JSON from another writer goes through the same decoder.
    const decoded = parseJson(JSON.stringify(original.value));
    assert.deepEqual(parseEncryptedCredentialEnvelope(decoded), original.value);

    for (const [variant, reason] of [
      [{ ...original.value, version: 2 }, "unsupported-version"],
      [{ ...original.value, version: "1" }, "unsupported-version"],
      [{ ...original.value, algorithm: "A128GCM" }, "malformed-envelope"],
      [{ ...original.value, extra: "field" }, "malformed-envelope"],
      [{ ...original.value, nonce: "AAAA+AAAAAAAAAAA" }, "malformed-envelope"],
      ["not an object", "malformed-envelope"],
      [null, "malformed-envelope"],
    ] as const)
      assert.throws(() => parseEncryptedCredentialEnvelope(variant), assertSafeFailure(reason));
  });

  test("missing or failing keys reject and never read as absent", async () => {
    const { inner, store } = setup();
    await store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });

    const withoutKey = setup({ inner, keys: {} });
    await assert.rejects(withoutKey.store.get("acct-1"), (error) => {
      assertSafeFailure("key-unavailable")(error);
      assert.ok(error instanceof SocialError);
      assert.equal(error.details?.["keyId"], "k1");

      return true;
    });

    const failing = createEncryptedCredentialStore({
      store: inner,
      namespace: "tenant-a",
      currentKeyId: "k1",
      resolveKey: async () => {
        throw new Error(`vault said ${refreshToken}`);
      },
    });

    await assert.rejects(failing.get("acct-1"), assertSafeFailure("key-unavailable"));
    await assert.rejects(
      failing.compareAndSet({ key: "acct-2", expectedRevision: undefined, value: credential }),
      assertSafeFailure("key-unavailable"),
    );
    assert.equal(inner.records.has("acct-2"), false);
  });

  test("rejects keys that are not 256-bit AES-GCM", async () => {
    const short = setup({ keys: { k1: new Uint8Array(16) } });
    await assert.rejects(
      short.store.compareAndSet({ key: "a", expectedRevision: undefined, value: credential }),
      assertSafeFailure("invalid-key"),
    );

    const aes128 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
      "encrypt",
      "decrypt",
    ]);

    const weak = setup({ keys: { k1: aes128 } });
    await assert.rejects(
      weak.store.compareAndSet({ key: "a", expectedRevision: undefined, value: credential }),
      assertSafeFailure("invalid-key"),
    );
  });

  test("accepts a WebCrypto key", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);

    const { store } = setup({ keys: { k1: key } });
    await store.compareAndSet({ key: "acct-1", expectedRevision: undefined, value: credential });

    assert.equal((await store.get("acct-1"))?.value.refreshToken, refreshToken);
  });

  test("rotates keys: reads old records and writes with the active key", async () => {
    const inner = new MemoryRecordStore<EncryptedCredentialEnvelope>();
    const before = setup({ inner, currentKeyId: "k1", keys: { k1: rawKey(1) } });
    await before.store.compareAndSet({
      key: "acct-1",
      expectedRevision: undefined,
      value: credential,
    });

    const after = setup({ inner, currentKeyId: "k2", keys: { k1: rawKey(1), k2: rawKey(2) } });
    const read = await after.store.get("acct-1");
    assert.equal(read?.value.accessToken, accessToken);

    await after.store.compareAndSet({
      key: "acct-1",
      expectedRevision: read?.revision,
      value: read?.value ?? credential,
    });
    assert.equal(envelope(inner, "acct-1").value.keyId, "k2");

    const retired = setup({ inner, currentKeyId: "k2", keys: { k2: rawKey(2) } });
    assert.equal((await retired.store.get("acct-1"))?.value.accessToken, accessToken);
  });

  test("validates credentials strictly on write and read", async () => {
    const { inner, store } = setup();
    await assert.rejects(
      store.compareAndSet({
        key: "acct-1",
        expectedRevision: undefined,
        value: { accessToken, expiresAt: "tomorrow" },
      }),
      (error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(inner.records.has("acct-1"), false);

    const loose = createEncryptedCredentialStore({
      store: inner,
      namespace: "tenant-a",
      currentKeyId: "k1",
      resolveKey: keyring({ k1: rawKey(1) }),
      codec: {
        encode: (value: string) => value,
        decode: (plaintext) => plaintext,
      },
    });

    await loose.compareAndSet({
      key: "acct-1",
      expectedRevision: undefined,
      value: JSON.stringify({ accessToken, unexpected: refreshToken }),
    });

    await assert.rejects(store.get("acct-1"), assertSafeFailure("invalid-plaintext"));

    await loose.compareAndSet({
      key: "acct-1",
      expectedRevision: (await inner.get("acct-1"))?.revision,
      value: `{not json ${refreshToken}`,
    });
    await assert.rejects(store.get("acct-1"), assertSafeFailure("invalid-plaintext"));
  });

  test("supports a caller codec", async () => {
    interface Session {
      readonly did: string;
      readonly token: string;
    }

    const inner = new MemoryRecordStore<EncryptedCredentialEnvelope>();

    const store = createEncryptedCredentialStore<Session>({
      store: inner,
      namespace: "bluesky",
      currentKeyId: "k1",
      resolveKey: keyring({ k1: rawKey(3) }),
      codec: {
        encode: (value) => JSON.stringify(value),
        decode: (plaintext) => {
          const parsed: unknown = JSON.parse(plaintext);

          if (!isSession(parsed)) throw new Error("bad session");

          return { did: parsed.did, token: parsed.token };
        },
      },
    });

    await store.compareAndSet({
      key: "s",
      expectedRevision: undefined,
      value: { did: "did:plc:a", token: "t" },
    });
    assert.deepEqual((await store.get("s"))?.value, { did: "did:plc:a", token: "t" });
  });

  test("forwards conditional delete only when the inner store supports it", async () => {
    const plain = setup();
    assert.equal(plain.store.deleteIfRevision, undefined);

    class ConditionalStore extends MemoryRecordStore<EncryptedCredentialEnvelope> {
      async deleteIfRevision(key: string, expectedRevision: string): Promise<boolean> {
        if (this.records.get(key)?.revision !== expectedRevision) return false;
        this.records.delete(key);

        return true;
      }
    }

    const { inner, store } = setup({ inner: new ConditionalStore() });

    const first = await store.compareAndSet({
      key: "acct-1",
      expectedRevision: undefined,
      value: credential,
    });

    const second = await store.compareAndSet({
      key: "acct-1",
      expectedRevision: first.revision,
      value: { accessToken: "next" },
    });

    assert.equal(await store.deleteIfRevision?.("acct-1", first.revision ?? ""), false);
    assert.equal(inner.records.has("acct-1"), true);
    assert.equal(await store.deleteIfRevision?.("acct-1", second.revision ?? ""), true);
    assert.equal(inner.records.has("acct-1"), false);
  });

  test("rejects invalid configuration", () => {
    const inner = new MemoryRecordStore<EncryptedCredentialEnvelope>();
    const resolveKey = keyring({});

    assert.throws(
      () =>
        createEncryptedCredentialStore({
          store: inner,
          namespace: "",
          currentKeyId: "k1",
          resolveKey,
        }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
    assert.throws(
      () =>
        createEncryptedCredentialStore({
          store: inner,
          namespace: "a",
          currentKeyId: "",
          resolveKey,
        }),
      (error) => error instanceof SocialError && error.code === "invalid_config",
    );
  });

  test("works as the store behind CredentialManager", async () => {
    const { store } = setup();

    const manager = new CredentialManager(store, new MemoryCredentialLock(), {
      clock: () => new Date("2026-10-24T00:00:00Z"),
    });

    const revision = await manager.save("acct-1", credential);
    const resolved = await manager.resolve("acct-1");

    assert.equal(resolved.revision, revision);
    assert.equal(resolved.freshness, "fresh");
    assert.equal(resolved.value.accessToken, accessToken);
  });
});

function isSession(value: unknown): value is { readonly did: string; readonly token: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "did" in value &&
    "token" in value &&
    typeof value.did === "string" &&
    typeof value.token === "string"
  );
}
