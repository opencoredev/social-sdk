import { SocialError } from "../core/errors.js";
import type { ConnectedAccountRef, Platform } from "../core/types.js";

export interface ConnectionAttempt {
  readonly id: string;
  readonly backend: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly platforms: readonly Platform[];
  readonly capabilities: readonly string[];
  readonly redirectUri: string;
  readonly state: string;
  readonly codeVerifier: string;
  readonly providerState?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ConnectionStart {
  readonly authorizationUrl: string;
  readonly attempt: Omit<ConnectionAttempt, "state" | "codeVerifier"> & { readonly state: string };
}

export interface ConnectionAccount {
  readonly ref: ConnectedAccountRef;
  readonly displayName: string;
}

export interface ConnectionProvider {
  start(input: {
    readonly platforms: readonly Platform[];
    readonly capabilities: readonly string[];
    readonly redirectUri: string;
    readonly state: string;
    readonly codeChallenge: string;
  }): Promise<{ readonly authorizationUrl: string; readonly providerState?: string }>;
  complete(input: {
    readonly callbackUrl: string;
    readonly attempt: ConnectionAttempt;
  }): Promise<readonly ConnectionAccount[]>;
}

export interface ConnectionStore {
  save(attempt: ConnectionAttempt): Promise<void>;
  get(attemptId: string): Promise<ConnectionAttempt | undefined>;
  /** Atomically claim a one-use code exchange. Never expire or release this claim automatically. */
  claimDiscovery(attemptId: string): Promise<boolean>;
  /** Persist discovered accounts before presenting the account picker. */
  saveDiscoveredAccounts(attemptId: string, accounts: readonly ConnectionAccount[]): Promise<void>;
  getDiscoveredAccounts(attemptId: string): Promise<readonly ConnectionAccount[] | undefined>;
  /**
   * Implementations must consume an attempt and insert all selected grants in
   * one durable transaction. If the transaction fails, the attempt must remain
   * retryable (or expose an explicit recovery marker); never commit a consumed
   * attempt with only a subset of its grants.
   */
  complete(input: {
    readonly attemptId: string;
    readonly state: string;
    readonly accounts: readonly ConnectionAccount[];
    readonly selectedAccountIds: readonly string[];
  }): Promise<readonly ConnectionGrant[]>;
}

export interface ConnectionGrant {
  readonly grantId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly account: ConnectedAccountRef;
  readonly capabilities: readonly string[];
}

export interface ConnectionManagerOptions {
  readonly store: ConnectionStore;
  readonly now?: () => Date;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly ttlMs?: number;
}

function randomBytes(length: number): Uint8Array {
  const result = new Uint8Array(length);
  crypto.getRandomValues(result);

  return result;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));

  return base64Url(new Uint8Array(digest));
}

function allowedRedirect(value: string, allowlist: readonly string[], callback = false): boolean {
  let candidate: URL;

  try {
    candidate = new URL(value);
  } catch {
    return false;
  }

  if (
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    (candidate.protocol !== "https:" &&
      !(
        candidate.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(candidate.hostname)
      ))
  )
    return false;

  return allowlist.some((entry) => {
    try {
      const allowed = new URL(entry);

      if (!callback) return candidate.href === allowed.href;

      if (candidate.origin !== allowed.origin || candidate.pathname !== allowed.pathname)
        return false;

      for (const [key, value] of allowed.searchParams)
        if (
          candidate.searchParams.getAll(key).length !== 1 ||
          candidate.searchParams.get(key) !== value
        )
          return false;

      return true;
    } catch {
      return false;
    }
  });
}

function ensureState(expected: string, actual: string): void {
  const expectedBytes = new TextEncoder().encode(expected);
  const actualBytes = new TextEncoder().encode(actual);
  let difference = expectedBytes.length ^ actualBytes.length;
  const length = Math.max(expectedBytes.length, actualBytes.length);

  for (let index = 0; index < length; index++)
    difference |= (expectedBytes[index] ?? 0) ^ (actualBytes[index] ?? 0);

  if (difference !== 0) {
    throw new SocialError({
      code: "unauthorized",
      operation: "connections.complete",
      message: "Connection state did not match this authenticated attempt",
    });
  }
}

export class ConnectionManager {
  readonly #options: Required<
    Pick<ConnectionManagerOptions, "store" | "now" | "randomBytes" | "ttlMs">
  >;

  constructor(options: ConnectionManagerOptions) {
    const ttlMs = options.ttlMs ?? 10 * 60 * 1000;

    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1)
      throw new SocialError({
        code: "invalid_config",
        operation: "connections.constructor",
        message: "ttlMs must be a positive safe integer",
      });
    this.#options = {
      store: options.store,
      now: options.now ?? (() => new Date()),
      randomBytes: options.randomBytes ?? randomBytes,
      ttlMs,
    };
  }

  async begin(input: {
    readonly backend: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly platforms: readonly Platform[];
    readonly capabilities?: readonly string[];
    readonly redirectUri: string;
    readonly allowedRedirectUris: readonly string[];
    readonly provider: ConnectionProvider;
  }): Promise<ConnectionStart> {
    if (!input.tenantId || !input.principalId)
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.begin",
        message: "An authenticated tenant and principal are required",
      });

    if (!allowedRedirect(input.redirectUri, input.allowedRedirectUris))
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.begin",
        message: "redirectUri is not on the exact callback allowlist",
      });

    if (input.platforms.length === 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.begin",
        message: "At least one platform is required",
      });
    const now = this.#options.now();
    const state = base64Url(this.#options.randomBytes(32));
    const codeVerifier = base64Url(this.#options.randomBytes(48));
    const attemptId = base64Url(this.#options.randomBytes(18));
    const expiresAt = new Date(now.getTime() + this.#options.ttlMs).toISOString();

    const started = await input.provider.start({
      platforms: input.platforms,
      capabilities: input.capabilities ?? [],
      redirectUri: input.redirectUri,
      state,
      codeChallenge: await challenge(codeVerifier),
    });

    const attemptBase = {
      id: attemptId,
      backend: input.backend,
      tenantId: input.tenantId,
      principalId: input.principalId,
      platforms: [...input.platforms],
      capabilities: [...(input.capabilities ?? [])],
      redirectUri: input.redirectUri,
      state,
      codeVerifier,
      createdAt: now.toISOString(),
      expiresAt,
    };

    const attempt: ConnectionAttempt =
      started.providerState === undefined
        ? attemptBase
        : { ...attemptBase, providerState: started.providerState };

    await this.#options.store.save(attempt);
    const { state: publicState, codeVerifier: _privateVerifier, ...publicAttempt } = attempt;

    return {
      authorizationUrl: started.authorizationUrl,
      attempt: { ...publicAttempt, state: publicState },
    };
  }

  async discover(input: {
    readonly attemptId: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly callbackUrl: string;
    readonly returnedState: string;
    readonly allowedRedirectUris: readonly string[];
    readonly provider: ConnectionProvider;
  }): Promise<readonly ConnectionAccount[]> {
    const attempt = await this.#options.store.get(input.attemptId);

    if (attempt === undefined)
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.complete",
        message: "Connection attempt was not found",
      });

    if (attempt.tenantId !== input.tenantId || attempt.principalId !== input.principalId)
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.complete",
        message: "Connection attempt belongs to a different authenticated principal",
      });

    if (
      !allowedRedirect(input.callbackUrl, input.allowedRedirectUris, true) ||
      !allowedRedirect(input.callbackUrl, [attempt.redirectUri], true)
    )
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.complete",
        message: "Callback URL is not the exact registered redirect",
      });
    ensureState(attempt.state, input.returnedState);
    const states = new URL(input.callbackUrl).searchParams.getAll("state");

    // Callers may pass a callback URL after extracting its state parameter; when
    // present, reject duplicates or a value that differs from the authenticated state.
    if (states.length > 1 || (states.length === 1 && states[0] !== input.returnedState))
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.complete",
        message: "Callback state differs from the authenticated callback parameter",
      });

    if (this.#options.now().getTime() >= Date.parse(attempt.expiresAt))
      throw new SocialError({
        code: "timeout",
        operation: "connections.complete",
        message: "Connection attempt expired",
      });
    const saved = await this.#options.store.getDiscoveredAccounts(attempt.id);

    if (saved) return saved;

    if (!(await this.#options.store.claimDiscovery(attempt.id))) {
      const completed = await this.#options.store.getDiscoveredAccounts(attempt.id);

      if (completed) return completed;
      throw new SocialError({
        code: "reconnect_required",
        operation: "connections.discover",
        message:
          "Code exchange is already in progress or its result was lost. Wait for discovery or begin a new connection; the code will not be exchanged again.",
      });
    }

    const accounts = await input.provider.complete({ callbackUrl: input.callbackUrl, attempt });
    this.#validateAccounts(attempt, accounts);
    await this.#options.store.saveDiscoveredAccounts(attempt.id, accounts);

    return structuredClone(accounts);
  }

  #validateAccounts(attempt: ConnectionAttempt, accounts: readonly ConnectionAccount[]): void {
    if (accounts.length === 0)
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.discover",
        message: "The provider returned no connected accounts",
      });
    const known = new Set(accounts.map((account) => account.ref.accountId));

    if (
      known.size !== accounts.length ||
      accounts.some(
        ({ ref }) =>
          ref.kind !== "connected-account" ||
          ref.version !== 1 ||
          ref.backend !== attempt.backend ||
          !attempt.platforms.includes(ref.platform) ||
          !ref.accountId,
      )
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.discover",
        message:
          "Provider returned ambiguous accounts or references outside this connection attempt",
      });
  }

  async select(input: {
    readonly attemptId: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly selectedAccountIds: readonly string[];
  }): Promise<readonly ConnectionGrant[]> {
    const attempt = await this.#options.store.get(input.attemptId);

    if (
      !attempt ||
      attempt.tenantId !== input.tenantId ||
      attempt.principalId !== input.principalId
    )
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.select",
        message: "Connection attempt was not found for this authenticated principal",
      });

    if (this.#options.now().getTime() >= Date.parse(attempt.expiresAt))
      throw new SocialError({
        code: "timeout",
        operation: "connections.select",
        message: "Connection attempt expired",
      });
    const accounts = await this.#options.store.getDiscoveredAccounts(attempt.id);

    if (!accounts)
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.select",
        message: "Complete account discovery before selecting accounts",
      });
    this.#validateAccounts(attempt, accounts);
    const selected = new Set(input.selectedAccountIds);

    if (!selected.size || selected.size !== input.selectedAccountIds.length)
      throw new SocialError({
        code: "invalid_input",
        operation: "connections.select",
        message: "Select one or more distinct discovered accounts",
      });
    const known = new Set(accounts.map(({ ref }) => ref.accountId));

    if ([...selected].some((id) => !known.has(id)))
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.select",
        message: "Selected account was not returned by the provider",
      });

    return this.#options.store.complete({
      attemptId: attempt.id,
      state: attempt.state,
      accounts,
      selectedAccountIds: input.selectedAccountIds,
    });
  }

  /** Convenience for callers that already know which discovered accounts to select. */
  async complete(
    input: Parameters<ConnectionManager["discover"]>[0] & {
      readonly selectedAccountIds: readonly string[];
    },
  ): Promise<readonly ConnectionGrant[]> {
    await this.discover(input);

    return this.select(input);
  }
}

export class MemoryConnectionStore implements ConnectionStore {
  readonly #attempts = new Map<
    string,
    {
      readonly attempt: ConnectionAttempt;
      consumed: boolean;
      discoveryClaimed: boolean;
      accounts?: readonly ConnectionAccount[];
    }
  >();
  readonly #grants: ConnectionGrant[] = [];
  #sequence = 0;

  async save(attempt: ConnectionAttempt): Promise<void> {
    if (this.#attempts.has(attempt.id))
      throw new SocialError({
        code: "upstream_failure",
        operation: "connections.begin",
        message: "Connection attempt ID collision",
      });
    this.#attempts.set(attempt.id, {
      attempt: structuredClone(attempt),
      consumed: false,
      discoveryClaimed: false,
    });
  }

  async get(attemptId: string): Promise<ConnectionAttempt | undefined> {
    const stored = this.#attempts.get(attemptId);

    return stored && !stored.consumed ? structuredClone(stored.attempt) : undefined;
  }

  async claimDiscovery(attemptId: string): Promise<boolean> {
    const stored = this.#attempts.get(attemptId);

    if (!stored || stored.consumed || stored.discoveryClaimed) return false;
    stored.discoveryClaimed = true;

    return true;
  }

  async saveDiscoveredAccounts(
    attemptId: string,
    accounts: readonly ConnectionAccount[],
  ): Promise<void> {
    const stored = this.#attempts.get(attemptId);

    if (!stored || stored.consumed || !stored.discoveryClaimed || stored.accounts)
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.discover",
        message: "Discovery cannot be saved for this attempt",
      });
    stored.accounts = structuredClone(accounts);
  }

  async getDiscoveredAccounts(
    attemptId: string,
  ): Promise<readonly ConnectionAccount[] | undefined> {
    const stored = this.#attempts.get(attemptId);

    return stored?.accounts && !stored.consumed ? structuredClone(stored.accounts) : undefined;
  }

  async complete(input: {
    readonly attemptId: string;
    readonly state: string;
    readonly accounts: readonly ConnectionAccount[];
    readonly selectedAccountIds: readonly string[];
  }): Promise<readonly ConnectionGrant[]> {
    const stored = this.#attempts.get(input.attemptId);

    if (stored === undefined || stored.consumed || stored.attempt.state !== input.state)
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.complete",
        message: "Connection callback is invalid or already consumed",
      });

    if (!stored.accounts || JSON.stringify(stored.accounts) !== JSON.stringify(input.accounts))
      throw new SocialError({
        code: "unauthorized",
        operation: "connections.select",
        message: "Grants must match persisted discovery",
      });
    const selected = new Set(input.selectedAccountIds);

    const grants = input.accounts
      .filter((account) => selected.has(account.ref.accountId))
      .map((account) => ({
        grantId: `grant-${++this.#sequence}`,
        tenantId: stored.attempt.tenantId,
        principalId: stored.attempt.principalId,
        account: account.ref,
        capabilities: stored.attempt.capabilities,
      }));

    this.#grants.push(...structuredClone(grants));
    stored.consumed = true;

    return structuredClone(grants);
  }

  grants(): readonly ConnectionGrant[] {
    return structuredClone(this.#grants);
  }
}
