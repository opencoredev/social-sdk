import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import {
  stableSerialize,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyStore,
} from "../core/idempotency.js";
import type {
  AuthorizationContext,
  DeliveryOutcome,
  JsonObject,
  PublishRequest,
  PublishSequenceRequest,
} from "../core/types.js";
import { parseJson } from "../transport/json.js";
import type { JsonField } from "../transport/validation.js";
import {
  ScheduleDecodeError,
  codec,
  decodeAuthorization,
  decodeOutcome,
  decodePublishRequest,
  decodeSequenceRequest,
} from "../core/persisted-codec.js";

export type ScheduleWork =
  | { readonly kind: "publish"; readonly request: PublishRequest }
  | { readonly kind: "sequence"; readonly request: PublishSequenceRequest };

interface StepBase {
  /** Position of this step's item in the sequence; 0 for a single publication. */
  readonly itemIndex: number;
  /** Original target index in the item for each target of the step's request. */
  readonly targetIndexes: readonly number[];
}

/**
 * One publish call the scheduler makes. The exact request is recorded before dispatch so
 * recovery can reopen its idempotency claim; a `dispatching` step is never sent again.
 */
export type ScheduledStep =
  | (StepBase & { readonly state: "pending" | "cancelled" })
  | (StepBase & { readonly state: "dispatching"; readonly request: PublishRequest })
  | (StepBase & {
      readonly state: "dispatched";
      readonly request: PublishRequest;
      /** Latest outcomes, indexed by the original target positions in the item. */
      readonly outcomes: readonly DeliveryOutcome[];
      readonly polls: number;
      /** Set when `publish` refused the step before sending anything. */
      readonly error?: { readonly code: string; readonly message: string };
    });

/**
 * An ordered list of steps that advance independently of other lanes. A single
 * publication has a `native` lane for routes that schedule on the provider and a
 * `runtime` lane for the rest; a reply chain has one lane per destination.
 */
export interface ScheduledLane {
  readonly id: string;
  readonly mode: "native" | "runtime";
  /** Each step replies to the previous step's published post. */
  readonly chained: boolean;
  /** Increments when a reschedule replaces provider-side work, giving it new keys. */
  readonly revision: number;
  readonly steps: readonly ScheduledStep[];
}

export type ScheduledJobStatus =
  | "scheduled"
  | "running"
  | "blocked"
  | "completed"
  | "cancelled"
  | "cancel-unresolved";

export interface UnresolvedCancellation {
  readonly itemIndex: number;
  readonly targetIndex: number;
  readonly reason: "cancel-unsupported" | "cancel-failed" | "not-cancellable-state" | "in-flight";
}

export interface ScheduledJob {
  readonly version: 1;
  readonly id: string;
  /** Tenant scope; every lookup and claim is keyed by it. */
  readonly scope: string;
  readonly status: ScheduledJobStatus;
  /** UTC instant the work is due. */
  readonly runAt: string;
  readonly timeZone?: string;
  readonly queueId?: string;
  /** When `runDue` should next look at this job; absent when nothing will change on its own. */
  readonly nextRunAt?: string;
  readonly authorization?: AuthorizationContext;
  readonly work: ScheduleWork;
  readonly lanes: readonly ScheduledLane[];
  readonly lease?: { readonly owner: string; readonly until: string };
  /** Why the job cannot progress without `retryFailed`, reconciliation, or operator action. */
  readonly blocked?: { readonly code: string; readonly message: string };
  readonly cancellation?: {
    readonly requestedAt: string;
    readonly unresolved: readonly UnresolvedCancellation[];
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredScheduledJob {
  readonly job: ScheduledJob;
  /** Opaque store revision for compare-and-set. */
  readonly revision: string;
}

/**
 * Durable schedule storage. Every write is a compare-and-set on the job's revision, which
 * is what makes `runDue` claims, cancellation, and rescheduling safe across processes.
 */
export interface ScheduleStore {
  /** Inserts a new job; fails without writing when the ID exists in its scope. */
  create(
    job: ScheduledJob,
  ): Promise<{ readonly created: true; readonly revision: string } | { readonly created: false }>;
  get(input: {
    readonly scope: string;
    readonly id: string;
  }): Promise<StoredScheduledJob | undefined>;
  compareAndSet(input: {
    readonly expectedRevision: string;
    readonly job: ScheduledJob;
  }): Promise<{ readonly updated: true; readonly revision: string } | { readonly updated: false }>;
  /**
   * Jobs whose `nextRunAt` is at or before `now` and whose lease is absent or expired,
   * earliest first. A listed job is a candidate only; callers claim it with compareAndSet.
   */
  listDue(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly StoredScheduledJob[]>;
  /**
   * Atomically reserves a queue slot for a job. Succeeds when the slot is free or its
   * holder no longer occupies it (cancelled or moved).
   */
  reserveSlot(input: {
    readonly scope: string;
    readonly queueId: string;
    readonly at: string;
    readonly jobId: string;
  }): Promise<boolean>;
}

export interface KeyValueEntry {
  readonly key: string;
  readonly value: string;
  readonly version: string;
}

/**
 * The storage primitive both adapters need. It maps to one SQL table
 * `(key text primary key, value text not null, version bigint not null)`:
 * insert with `ON CONFLICT DO NOTHING` when `expectedVersion` is undefined, otherwise
 * `UPDATE ... SET value = ?, version = version + 1 WHERE key = ? AND version = ?`,
 * and list with `WHERE key > ? AND key LIKE 'prefix%' ORDER BY key LIMIT ?`.
 * Redis, DynamoDB conditional writes, Cloudflare Durable Objects, and similar stores
 * fit the same contract. The adapter must make each call atomic.
 */
export interface VersionedKeyValueStore {
  get(key: string): Promise<KeyValueEntry | undefined>;
  /** Writes only when the key's version equals `expectedVersion`; undefined requires absence. */
  compareAndSet(input: {
    readonly key: string;
    readonly expectedVersion: string | undefined;
    readonly value: string;
  }): Promise<{ readonly updated: true; readonly version: string } | { readonly updated: false }>;
  /** Deletes only when the key's version equals `expectedVersion`. */
  delete(input: { readonly key: string; readonly expectedVersion: string }): Promise<boolean>;
  /** Entries whose key starts with `prefix` and sorts after `after`, ascending by key. */
  list(input: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit: number;
  }): Promise<readonly KeyValueEntry[]>;
}

/** An in-process {@link VersionedKeyValueStore} for tests and single-process development. */
export class MemoryKeyValueStore implements VersionedKeyValueStore {
  readonly #entries = new Map<string, { value: string; version: number }>();

  async get(key: string): Promise<KeyValueEntry | undefined> {
    const entry = this.#entries.get(key);

    return entry === undefined
      ? undefined
      : { key, value: entry.value, version: String(entry.version) };
  }

  async compareAndSet(input: {
    readonly key: string;
    readonly expectedVersion: string | undefined;
    readonly value: string;
  }): Promise<{ readonly updated: true; readonly version: string } | { readonly updated: false }> {
    const current = this.#entries.get(input.key);

    if (
      (current === undefined && input.expectedVersion !== undefined) ||
      (current !== undefined && String(current.version) !== input.expectedVersion)
    )
      return { updated: false };

    const version = (current?.version ?? 0) + 1;
    this.#entries.set(input.key, { value: input.value, version });

    return { updated: true, version: String(version) };
  }

  async delete(input: {
    readonly key: string;
    readonly expectedVersion: string;
  }): Promise<boolean> {
    const current = this.#entries.get(input.key);

    if (current === undefined || String(current.version) !== input.expectedVersion) return false;

    this.#entries.delete(input.key);

    return true;
  }

  async list(input: {
    readonly prefix: string;
    readonly after?: string;
    readonly limit: number;
  }): Promise<readonly KeyValueEntry[]> {
    const keys = [...this.#entries.keys()]
      .filter(
        (key) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after),
      )
      .sort()
      .slice(0, input.limit);

    const entries: KeyValueEntry[] = [];

    for (const key of keys) {
      const entry = this.#entries.get(key);

      if (entry !== undefined)
        entries.push({ key, value: entry.value, version: String(entry.version) });
    }

    return entries;
  }
}

const jobFormat = "social-sdk.schedule-job";

const claimFormat = "social-sdk.idempotency-claim";

function storageError(cause: unknown): SocialError {
  return new SocialError({
    code: "upstream_failure",
    operation: "schedule.store",
    message:
      cause instanceof ScheduleDecodeError
        ? `Stored record failed validation: ${cause.message}`
        : "Stored record is not valid JSON",
    cause,
  });
}

function decodeStep(value: JsonField, path: string): ScheduledStep {
  const o = codec.obj(value, path);

  const base = {
    itemIndex: codec.int(o["itemIndex"], `${path}.itemIndex`),
    targetIndexes: codec.list(o["targetIndexes"], `${path}.targetIndexes`, codec.int),
  };

  const state = codec.literal(o["state"], `${path}.state`, [
    "pending",
    "cancelled",
    "dispatching",
    "dispatched",
  ]);

  if (state === "pending" || state === "cancelled") return { ...base, state };

  const request = decodePublishRequest(o["request"], `${path}.request`);

  if (state === "dispatching") return { ...base, state, request };

  return {
    ...base,
    state,
    request,
    outcomes: codec.list(o["outcomes"], `${path}.outcomes`, decodeOutcome),
    polls: codec.int(o["polls"], `${path}.polls`),
    ...definedFields({
      error: codec.optional(o["error"], `${path}.error`, (error, at) => {
        const e = codec.obj(error, at);

        return {
          code: codec.str(e["code"], `${at}.code`),
          message: codec.str(e["message"], `${at}.message`),
        };
      }),
    }),
  };
}

function decodeLane(value: JsonField, path: string): ScheduledLane {
  const o = codec.obj(value, path);

  return {
    id: codec.nonEmpty(o["id"], `${path}.id`),
    mode: codec.literal(o["mode"], `${path}.mode`, ["native", "runtime"]),
    chained: codec.optBool(o["chained"], `${path}.chained`) ?? false,
    revision: codec.int(o["revision"], `${path}.revision`),
    steps: codec.list(o["steps"], `${path}.steps`, decodeStep),
  };
}

function decodeWork(value: JsonField, path: string): ScheduleWork {
  const o = codec.obj(value, path);
  const workKind = codec.literal(o["kind"], `${path}.kind`, ["publish", "sequence"]);

  if (workKind === "publish")
    return { kind: workKind, request: decodePublishRequest(o["request"], `${path}.request`) };

  return { kind: workKind, request: decodeSequenceRequest(o["request"], `${path}.request`) };
}

export function decodeJob(value: JsonField): ScheduledJob {
  const envelope = codec.obj(value, "record");

  codec.literal(envelope["format"], "record.format", [jobFormat]);
  codec.versionOne(envelope, "record");
  const path = "record.job";
  const o = codec.obj(envelope["job"], path);

  return {
    version: codec.versionOne(o, path),
    id: codec.nonEmpty(o["id"], `${path}.id`),
    scope: codec.nonEmpty(o["scope"], `${path}.scope`),
    status: codec.literal(o["status"], `${path}.status`, [
      "scheduled",
      "running",
      "blocked",
      "completed",
      "cancelled",
      "cancel-unresolved",
    ]),
    runAt: codec.nonEmpty(o["runAt"], `${path}.runAt`),
    work: decodeWork(o["work"], `${path}.work`),
    lanes: codec.list(o["lanes"], `${path}.lanes`, decodeLane),
    createdAt: codec.nonEmpty(o["createdAt"], `${path}.createdAt`),
    updatedAt: codec.nonEmpty(o["updatedAt"], `${path}.updatedAt`),
    ...definedFields({
      timeZone: codec.optStr(o["timeZone"], `${path}.timeZone`),
      queueId: codec.optStr(o["queueId"], `${path}.queueId`),
      nextRunAt: codec.optStr(o["nextRunAt"], `${path}.nextRunAt`),
      authorization: codec.optional(
        o["authorization"],
        `${path}.authorization`,
        decodeAuthorization,
      ),
      lease: codec.optional(o["lease"], `${path}.lease`, (lease, at) => {
        const l = codec.obj(lease, at);

        return {
          owner: codec.nonEmpty(l["owner"], `${at}.owner`),
          until: codec.nonEmpty(l["until"], `${at}.until`),
        };
      }),
      blocked: codec.optional(o["blocked"], `${path}.blocked`, (blocked, at) => {
        const b = codec.obj(blocked, at);

        return {
          code: codec.str(b["code"], `${at}.code`),
          message: codec.str(b["message"], `${at}.message`),
        };
      }),
      cancellation: codec.optional(
        o["cancellation"],
        `${path}.cancellation`,
        (cancellation, at) => {
          const c = codec.obj(cancellation, at);

          return {
            requestedAt: codec.nonEmpty(c["requestedAt"], `${at}.requestedAt`),
            unresolved: codec.list(c["unresolved"], `${at}.unresolved`, (entry, entryPath) => {
              const u = codec.obj(entry, entryPath);

              return {
                itemIndex: codec.int(u["itemIndex"], `${entryPath}.itemIndex`),
                targetIndex: codec.int(u["targetIndex"], `${entryPath}.targetIndex`),
                reason: codec.literal(u["reason"], `${entryPath}.reason`, [
                  "cancel-unsupported",
                  "cancel-failed",
                  "not-cancellable-state",
                  "in-flight",
                ]),
              };
            }),
          };
        },
      ),
    }),
  };
}

export function encodeJob(job: ScheduledJob): string {
  return stableSerialize({ format: jobFormat, version: 1, job });
}

function parseStored<T>(value: string, decode: (value: JsonField) => T): T {
  try {
    return decode(parseJson(value));
  } catch (error) {
    throw storageError(error);
  }
}

function part(value: string): string {
  return encodeURIComponent(value);
}

const activeStatuses: ReadonlySet<ScheduledJobStatus> = new Set([
  "scheduled",
  "running",
  "blocked",
  "cancel-unresolved",
]);

/**
 * Builds a store without a separately written due index. Reads at most `maxScanEntries`
 * authoritative job records per scan; exceeding the bound fails explicitly. Applications
 * with larger queues should implement ScheduleStore with an indexed database query.
 */
export function createKeyValueScheduleStore(
  kv: VersionedKeyValueStore,
  options: { readonly maxScanEntries?: number } = {},
): ScheduleStore {
  const maxScanEntries = options.maxScanEntries ?? 10_000;

  if (!Number.isSafeInteger(maxScanEntries) || maxScanEntries < 1 || maxScanEntries > 100_000)
    throw new SocialError({
      code: "invalid_config",
      operation: "schedule.store",
      message: "maxScanEntries must be an integer from 1 through 100000",
    });

  const jobKey = (scope: string, id: string) => `schedule/job/${part(scope)}/${part(id)}`;

  const slotKey = (scope: string, queueId: string, at: string) =>
    `schedule/slot/${part(scope)}/${part(queueId)}/${at}`;

  async function read(scope: string, id: string): Promise<StoredScheduledJob | undefined> {
    const entry = await kv.get(jobKey(scope, id));

    if (entry === undefined) return undefined;

    const job = parseStored(entry.value, decodeJob);

    if (job.scope !== scope || job.id !== id)
      throw storageError(new ScheduleDecodeError("record.job", "the job stored under its key"));

    return { job, revision: entry.version };
  }

  return {
    async create(job) {
      const result = await kv.compareAndSet({
        key: jobKey(job.scope, job.id),
        expectedVersion: undefined,
        value: encodeJob(job),
      });

      return result.updated ? { created: true, revision: result.version } : { created: false };
    },
    get: (input) => read(input.scope, input.id),
    async compareAndSet(input) {
      const key = jobKey(input.job.scope, input.job.id);

      const result = await kv.compareAndSet({
        key,
        expectedVersion: input.expectedRevision,
        value: encodeJob(input.job),
      });

      return result.updated ? { updated: true, revision: result.version } : { updated: false };
    },
    async listDue(input) {
      const due: StoredScheduledJob[] = [];
      const prefix = "schedule/job/";
      let after: string | undefined;
      let scanned = 0;

      // Each record is its own authoritative index entry. A concurrent create or move
      // can wait until the next scan, but cannot become permanently undiscoverable.
      while (scanned <= maxScanEntries) {
        const pageSize = Math.min(256, maxScanEntries - scanned + 1);

        const entries = await kv.list({
          prefix,
          limit: pageSize,
          ...definedFields({ after }),
        });

        if (entries.length === 0) break;

        for (const entry of entries) {
          after = entry.key;
          scanned++;

          if (scanned > maxScanEntries)
            throw new SocialError({
              code: "rate_limited",
              operation: "schedule.store",
              message:
                "The schedule scan exceeded maxScanEntries; use an indexed ScheduleStore or raise the bound",
            });

          const job = parseStored(entry.value, decodeJob);

          if (entry.key !== jobKey(job.scope, job.id))
            throw storageError(
              new ScheduleDecodeError("record.job", "the job stored under its key"),
            );

          if (job.nextRunAt === undefined || job.nextRunAt > input.now) continue;

          if (job.lease !== undefined && job.lease.until > input.now) continue;

          due.push({ job, revision: entry.version });
        }

        if (entries.length < pageSize) break;
      }

      due.sort(
        (left, right) =>
          (left.job.nextRunAt ?? "").localeCompare(right.job.nextRunAt ?? "") ||
          left.job.id.localeCompare(right.job.id),
      );

      return due.slice(0, input.limit);
    },
    async reserveSlot(input) {
      const key = slotKey(input.scope, input.queueId, input.at);

      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await kv.get(key);

        if (current === undefined) {
          if (
            (await kv.compareAndSet({ key, expectedVersion: undefined, value: input.jobId }))
              .updated
          )
            return true;
          continue;
        }

        if (current.value === input.jobId) return true;

        // A reservation whose job was never written is treated as held.
        const holder = await read(input.scope, current.value);

        if (
          holder === undefined ||
          (activeStatuses.has(holder.job.status) &&
            holder.job.queueId === input.queueId &&
            holder.job.runAt === input.at)
        )
          return false;

        if (
          (await kv.compareAndSet({ key, expectedVersion: current.version, value: input.jobId }))
            .updated
        )
          return true;
      }

      return false;
    },
  };
}

/** An in-process schedule store. It serializes every record, like a durable adapter would. */
export class MemoryScheduleStore implements ScheduleStore {
  readonly #store = createKeyValueScheduleStore(new MemoryKeyValueStore());

  create(job: ScheduledJob) {
    return this.#store.create(job);
  }

  get(input: { readonly scope: string; readonly id: string }) {
    return this.#store.get(input);
  }

  compareAndSet(input: { readonly expectedRevision: string; readonly job: ScheduledJob }) {
    return this.#store.compareAndSet(input);
  }

  listDue(input: { readonly now: string; readonly limit: number }) {
    return this.#store.listDue(input);
  }

  reserveSlot(input: {
    readonly scope: string;
    readonly queueId: string;
    readonly at: string;
    readonly jobId: string;
  }) {
    return this.#store.reserveSlot(input);
  }
}

interface StoredClaim {
  readonly claimId: string;
  readonly fingerprint: string;
  readonly targetKeys: readonly string[];
  readonly outcomes: Readonly<Record<string, DeliveryOutcome>>;
}

function decodeClaim(value: JsonField): StoredClaim {
  const o = codec.obj(value, "claim");

  codec.literal(o["format"], "claim.format", [claimFormat]);
  codec.versionOne(o, "claim");
  const outcomes: Record<string, DeliveryOutcome> = {};
  const saved: JsonObject = codec.obj(o["outcomes"], "claim.outcomes");

  for (const [index, [key, outcome]] of Object.entries(saved).entries())
    outcomes[key] = decodeOutcome(outcome, `claim.outcomes[${index}]`);

  return {
    claimId: codec.nonEmpty(o["claimId"], "claim.claimId"),
    fingerprint: codec.nonEmpty(o["fingerprint"], "claim.fingerprint"),
    targetKeys: codec.list(o["targetKeys"], "claim.targetKeys", codec.str),
    outcomes,
  };
}

function encodeClaim(claim: StoredClaim): string {
  return stableSerialize({ format: claimFormat, version: 1, ...claim });
}

/**
 * A durable {@link IdempotencyStore} with compare-and-set outcomes on any
 * {@link VersionedKeyValueStore}, so `posts.reconcile` and `posts.retryFailed` work
 * across processes.
 */
export function createKeyValueIdempotencyStore(kv: VersionedKeyValueStore): IdempotencyStore {
  const claimKey = (scope: string, key: string) => `idempotency/${part(scope)}/${part(key)}`;

  function locate(claimId: string): string {
    const separator = claimId.lastIndexOf("#");

    if (separator < 1)
      throw new SocialError({
        code: "invalid_input",
        operation: "idempotency.save",
        message: "Unknown idempotency claim",
      });

    return claimId.slice(0, separator);
  }

  async function update(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly accept: (current: DeliveryOutcome | undefined) => boolean;
    readonly outcome: DeliveryOutcome;
  }): Promise<boolean> {
    const key = locate(input.claimId);

    for (let attempt = 0; attempt < 10; attempt++) {
      const entry = await kv.get(key);

      if (entry === undefined)
        throw new SocialError({
          code: "invalid_input",
          operation: "idempotency.save",
          message: "Unknown idempotency claim",
        });

      const claim = parseStored(entry.value, decodeClaim);

      if (claim.claimId !== input.claimId || !claim.targetKeys.includes(input.targetKey))
        throw new SocialError({
          code: "invalid_input",
          operation: "idempotency.save",
          message: "Target does not belong to this idempotency claim",
        });

      if (!input.accept(claim.outcomes[input.targetKey])) return false;

      const next: StoredClaim = {
        ...claim,
        outcomes: { ...claim.outcomes, [input.targetKey]: input.outcome },
      };

      if (
        (await kv.compareAndSet({ key, expectedVersion: entry.version, value: encodeClaim(next) }))
          .updated
      )
        return true;
    }

    throw new SocialError({
      code: "upstream_failure",
      operation: "idempotency.save",
      message: "The idempotency claim kept changing; try again",
    });
  }

  return {
    async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
      const key = claimKey(input.scope, input.key);

      for (let attempt = 0; attempt < 3; attempt++) {
        const entry = await kv.get(key);

        if (entry !== undefined) {
          const claim = parseStored(entry.value, decodeClaim);

          if (
            claim.fingerprint !== input.fingerprint ||
            stableSerialize(claim.targetKeys) !== stableSerialize(input.targetKeys)
          )
            return { kind: "conflict" };

          return { kind: "existing", claimId: claim.claimId, outcomes: claim.outcomes };
        }

        const claim: StoredClaim = {
          claimId: `${key}#${crypto.randomUUID()}`,
          fingerprint: input.fingerprint,
          targetKeys: [...input.targetKeys],
          outcomes: {},
        };

        if (
          (await kv.compareAndSet({ key, expectedVersion: undefined, value: encodeClaim(claim) }))
            .updated
        )
          return { kind: "new", claimId: claim.claimId, outcomes: {} };
      }

      throw new SocialError({
        code: "upstream_failure",
        operation: "idempotency.claim",
        message: "The idempotency claim could not be created",
      });
    },
    async saveOutcome(input) {
      await update({ ...input, accept: () => true });
    },
    compareAndSetOutcome: (input) =>
      update({
        claimId: input.claimId,
        targetKey: input.targetKey,
        outcome: input.outcome,
        accept: (current) =>
          current === undefined
            ? input.expected === undefined
            : input.expected !== undefined &&
              stableSerialize(current) === stableSerialize(input.expected),
      }),
  };
}
