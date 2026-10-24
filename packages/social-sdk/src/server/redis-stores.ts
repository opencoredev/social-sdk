import type { StoredCredential } from "./credentials.js";
import {
  storeError,
  type DurableAddress,
  type DurableDriver,
  type DurableLeaseInput,
} from "./durable-driver.js";
import {
  createDurableStores,
  storedCredentialCodec,
  type CredentialCodec,
  type DurableStores,
} from "./durable-stores.js";

/**
 * Runs a Lua script with `EVAL`. Every script touches exactly one key and
 * returns a Lua table, so adapters can return the reply array as-is:
 *
 * - ioredis: `(script, keys, args) => redis.eval(script, keys.length, ...keys, ...args)`
 * - node-redis: `(script, keys, args) => client.eval(script, { keys: [...keys], arguments: [...args] })`
 *
 * Because each script uses one key, the stores work on Redis Cluster without
 * hash tags. Records have no TTL, so use a `noeviction` policy (or a dedicated
 * database with no eviction) or Redis may silently drop claims and grants.
 */
export interface RedisScriptRunner {
  eval(
    script: string,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<readonly unknown[]>;
}

/** Lua sources. Exported so tests and operators can review them; do not edit at runtime. */
export const redisDurableScripts = {
  /** Returns `{revision, body}`, or an empty table when missing. */
  read: `local value = redis.call('HMGET', KEYS[1], 'r', 'b')
if not value[1] then return {} end
return {value[1], value[2]}`,
  /** ARGV: expected revision ('' for absent), new revision, body. */
  write: `local current = redis.call('HGET', KEYS[1], 'r')
if ARGV[1] == '' then
  if current then return {0} end
elseif current ~= ARGV[1] then
  return {0}
end
redis.call('HSET', KEYS[1], 'r', ARGV[2], 'b', ARGV[3])
return {1}`,
  /** ARGV: expected revision ('' for any). */
  remove: `if ARGV[1] ~= '' and redis.call('HGET', KEYS[1], 'r') ~= ARGV[1] then return {0} end
return {redis.call('DEL', KEYS[1])}`,
  /** ARGV: token, ttl milliseconds. */
  acquireLease: `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return {1} end
return {0}`,
  /** ARGV: token, ttl milliseconds. */
  renewLease: `if redis.call('GET', KEYS[1]) == ARGV[1] then return {redis.call('PEXPIRE', KEYS[1], ARGV[2])} end
return {0}`,
  /** ARGV: token. */
  releaseLease: `if redis.call('GET', KEYS[1]) == ARGV[1] then return {redis.call('DEL', KEYS[1])} end
return {0}`,
} as const;

const PREFIX = /^[A-Za-z0-9_:.-]{1,64}$/;

function isOne(reply: readonly unknown[]): boolean {
  return reply.length === 1 && (reply[0] === 1 || reply[0] === "1");
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * {@link DurableDriver} over Redis. Records are hashes with fields `r`
 * (revision) and `b` (body); leases are plain keys with a server-side PX
 * expiry, so Redis's clock decides lease expiry. Redis replication is
 * asynchronous: a failover can lose acknowledged writes, so prefer the SQL
 * driver where losing a consumed attempt or claim is unacceptable.
 */
export class RedisDurableDriver implements DurableDriver {
  readonly #runner: RedisScriptRunner;
  readonly #prefix: string;

  constructor(options: {
    readonly runner: RedisScriptRunner;
    /** Key prefix. Letters, digits, and `_:.-`. Defaults to `social-sdk:`. */
    readonly prefix?: string;
  }) {
    const prefix = options.prefix ?? "social-sdk:";

    if (!PREFIX.test(prefix))
      throw storeError(
        "redis.configure",
        "prefix must be 1 to 64 characters of letters, digits, or _:.-",
        "invalid_config",
      );
    this.#runner = options.runner;
    this.#prefix = prefix;
  }

  /** Namespaces contain no `:`, so `<prefix><namespace>:<key>` never collides across namespaces. */
  #key(input: DurableAddress): string {
    return `${this.#prefix}${input.namespace}:${input.key}`;
  }

  async read(
    input: DurableAddress,
  ): Promise<{ readonly text: string; readonly revision: string } | undefined> {
    const reply = await this.#runner.eval(redisDurableScripts.read, [this.#key(input)], []);

    if (reply.length === 0) return undefined;
    const [revision, text] = reply;

    if (reply.length !== 2 || !isText(revision) || !isText(text))
      throw storeError("redis.read", "Redis returned an unexpected reply");

    return { text, revision };
  }

  async write(
    input: DurableAddress & {
      readonly expectedRevision: string | undefined;
      readonly revision: string;
      readonly text: string;
    },
  ): Promise<boolean> {
    return isOne(
      await this.#runner.eval(
        redisDurableScripts.write,
        [this.#key(input)],
        [input.expectedRevision ?? "", input.revision, input.text],
      ),
    );
  }

  async remove(input: DurableAddress & { readonly expectedRevision?: string }): Promise<boolean> {
    return isOne(
      await this.#runner.eval(
        redisDurableScripts.remove,
        [this.#key(input)],
        [input.expectedRevision ?? ""],
      ),
    );
  }

  async acquireLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean> {
    return isOne(
      await this.#runner.eval(
        redisDurableScripts.acquireLease,
        [this.#key(input)],
        [input.token, String(input.ttlMs)],
      ),
    );
  }

  async renewLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean> {
    return isOne(
      await this.#runner.eval(
        redisDurableScripts.renewLease,
        [this.#key(input)],
        [input.token, String(input.ttlMs)],
      ),
    );
  }

  async releaseLease(input: DurableLeaseInput): Promise<boolean> {
    return isOne(
      await this.#runner.eval(redisDurableScripts.releaseLease, [this.#key(input)], [input.token]),
    );
  }
}

export type RedisStores<TCredential> = DurableStores<TCredential> & {
  readonly driver: RedisDurableDriver;
};

interface RedisStoresOptions {
  readonly runner: RedisScriptRunner;
  readonly prefix?: string;
  /** Clock for reported lease `expiresAt` values and attempt expiry checks. */
  readonly now?: () => Date;
}

/**
 * Builds every durable store on one Redis driver. Runs no commands. Without a
 * codec, credentials are plain JSON {@link storedCredentialCodec}.
 */
export function createRedisStores(options: RedisStoresOptions): RedisStores<StoredCredential>;
export function createRedisStores<TCredential>(
  options: RedisStoresOptions & { readonly credentialCodec: CredentialCodec<TCredential> },
): RedisStores<TCredential>;
export function createRedisStores<TCredential>(
  options: RedisStoresOptions & { readonly credentialCodec?: CredentialCodec<TCredential> },
): RedisStores<TCredential> | RedisStores<StoredCredential> {
  const driver = new RedisDurableDriver(
    options.prefix === undefined
      ? { runner: options.runner }
      : { runner: options.runner, prefix: options.prefix },
  );

  return options.credentialCodec === undefined
    ? { driver, ...createDurableStores({ driver, codec: storedCredentialCodec, now: options.now }) }
    : {
        driver,
        ...createDurableStores({ driver, codec: options.credentialCodec, now: options.now }),
      };
}
