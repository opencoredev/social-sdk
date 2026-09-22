import type { CredentialStore } from "../core/adapter.js";
import { SocialError } from "../core/errors.js";

export interface CredentialLease {
  readonly key: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface CredentialLock {
  acquire(key: string, ttlMs: number): Promise<CredentialLease | undefined>;
  release(lease: CredentialLease): Promise<void>;
}

export interface StoredCredential {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt?: string;
  readonly scopes?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export class MemoryCredentialStore implements CredentialStore<StoredCredential> {
  readonly #values = new Map<string, { value: StoredCredential; revision: string }>();
  #sequence = 0;

  async get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    const found = this.#values.get(key);

    if (found === undefined) return undefined;
    const value = { ...found.value };

    if (found.value.scopes !== undefined) value.scopes = [...found.value.scopes];

    return { value, revision: found.revision };
  }

  async compareAndSet(input: {
    readonly key: string;
    readonly expectedRevision: string | undefined;
    readonly value: StoredCredential;
  }): Promise<{ readonly updated: boolean; readonly revision?: string }> {
    const current = this.#values.get(input.key);

    if ((current?.revision ?? undefined) !== input.expectedRevision) return { updated: false };
    const revision = `credential-${++this.#sequence}`;
    const value = { ...input.value };

    if (input.value.scopes !== undefined) value.scopes = [...input.value.scopes];

    this.#values.set(input.key, { value, revision });

    return { updated: true, revision };
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
}

export class MemoryCredentialLock implements CredentialLock {
  readonly #leases = new Map<string, CredentialLease>();
  #sequence = 0;

  async acquire(key: string, ttlMs: number): Promise<CredentialLease | undefined> {
    const current = this.#leases.get(key);

    if (current !== undefined && Date.parse(current.expiresAt) > Date.now()) return undefined;

    const lease = {
      key,
      token: `lease-${++this.#sequence}`,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };

    this.#leases.set(key, lease);

    return lease;
  }

  async release(lease: CredentialLease): Promise<void> {
    if (this.#leases.get(lease.key)?.token === lease.token) this.#leases.delete(lease.key);
  }
}

export class CredentialManager {
  constructor(
    private readonly store: CredentialStore<StoredCredential>,
    private readonly lock: CredentialLock,
    private readonly lockTtlMs = 30_000,
  ) {}

  get(
    key: string,
  ): Promise<{ readonly value: StoredCredential; readonly revision: string } | undefined> {
    return this.store.get(key);
  }

  async save(key: string, value: StoredCredential, expectedRevision?: string): Promise<string> {
    const result = await this.store.compareAndSet({ key, expectedRevision, value });

    if (!result.updated || result.revision === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "credentials.save",
        message: "Credential revision changed; reload before saving",
      });

    return result.revision;
  }

  async rotate(
    key: string,
    refresh: (current: StoredCredential) => Promise<StoredCredential>,
  ): Promise<StoredCredential> {
    const lease = await this.lock.acquire(key, this.lockTtlMs);

    if (lease === undefined)
      throw new SocialError({
        code: "upstream_failure",
        operation: "credentials.rotate",
        message: "Another worker is already refreshing this credential",
      });

    try {
      const current = await this.store.get(key);

      if (current === undefined)
        throw new SocialError({
          code: "reconnect_required",
          operation: "credentials.rotate",
          message: "No credential is stored for this account",
        });
      const next = await refresh(current.value);

      const saved = await this.store.compareAndSet({
        key,
        expectedRevision: current.revision,
        value: next,
      });

      if (!saved.updated)
        throw new SocialError({
          code: "upstream_failure",
          operation: "credentials.rotate",
          message:
            "Credential changed while refreshing; do not repeat the provider request blindly",
        });

      return next;
    } finally {
      await this.lock.release(lease);
    }
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }
}
