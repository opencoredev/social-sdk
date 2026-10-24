import type { JobRunner } from "../core/adapter.js";
import type { SocialClient } from "../core/client.js";
import { SocialError } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import { stableSerialize } from "../core/idempotency.js";
import type {
  AuthorizationContext,
  ConnectedAccountRef,
  DeliveryOutcome,
  MediaAttachment,
  PlatformPostRef,
  PreparationIssue,
  PublishRequest,
  PublishTarget,
} from "../core/types.js";
import { parseJson } from "../transport/json.js";
import {
  ScheduleDecodeError,
  decodePublishRequest,
  decodeSequenceRequest,
} from "../core/persisted-codec.js";
import type {
  ScheduleStore,
  ScheduleWork,
  ScheduledJob,
  ScheduledJobStatus,
  ScheduledLane,
  ScheduledStep,
  StoredScheduledJob,
  UnresolvedCancellation,
} from "./schedule-store.js";
import {
  parseInstant,
  queueSlotInstants,
  resolveFixedTime,
  validateQueue,
  type ScheduleTime,
} from "./schedule-time.js";

export {
  OutcomeReconciler,
  type OutcomeReconcilerConfig,
  type RecoveryClient,
  type SettleOptions,
} from "./reconciler.js";

export {
  MemoryKeyValueStore,
  MemoryScheduleStore,
  createKeyValueIdempotencyStore,
  createKeyValueScheduleStore,
  decodeJob,
  encodeJob,
  type KeyValueEntry,
  type ScheduleStore,
  type ScheduleWork,
  type ScheduledJob,
  type ScheduledJobStatus,
  type ScheduledLane,
  type ScheduledStep,
  type StoredScheduledJob,
  type UnresolvedCancellation,
  type VersionedKeyValueStore,
} from "./schedule-store.js";

export {
  resolveLocalTime,
  type LocalTimeResolution,
  type QueueSlot,
  type ScheduleTime,
  type Weekday,
} from "./schedule-time.js";

export { ScheduleDecodeError } from "../core/persisted-codec.js";

/** The client operations the scheduler needs; any `createSocial` client satisfies it. */
export type SchedulerClient = Pick<SocialClient, "posts" | "capabilities" | "jobRunner">;

export interface SocialSchedulerConfig {
  /** A client created with `recovery: outcomeRecovery()`; recovery runs through it. */
  readonly social: SchedulerClient;
  readonly store: ScheduleStore;
  readonly clock?: () => Date;
  /**
   * Optional wake hints. After a job is stored or moved, the scheduler enqueues a
   * `social-sdk.schedule.run-due` job at its next run time; the handler should call
   * `runDue`. The store stays authoritative, so a lost or duplicate hint only changes
   * when work is noticed. Keep a periodic `runDue` call as the backstop.
   */
  readonly jobRunner?: JobRunner;
  /** How long a `runDue` claim holds a job, 1000 through 3600000 ms. Defaults to 300000. */
  readonly leaseMs?: number;
  /** Delay between polls of pending outcomes, 1000 through 86400000 ms. Defaults to 60000. */
  readonly pollIntervalMs?: number;
  /** Polls per step before the job is reported blocked, 1 through 1000. Defaults to 30. */
  readonly maxPolls?: number;
  /** Lease owner name for this process. Defaults to a random UUID. */
  readonly ownerId?: string;
}

export interface ScheduleCallOptions {
  /** Stored with the job and passed to every publish, poll, retry, and cancellation. */
  readonly authorization?: AuthorizationContext;
}

export interface ScheduleInput extends ScheduleCallOptions {
  readonly work: ScheduleWork;
  readonly at: ScheduleTime;
  /** Caller-chosen job ID, unique within the tenant. Defaults to a random UUID. */
  readonly id?: string;
  /**
   * Submit single publications early to routes whose manifest declares `posts.schedule`
   * and `posts.cancelScheduled` as available. Other routes are always sent by `runDue`
   * at the scheduled time, so this never forces a write a route does not support.
   * Defaults to true. Sequences always run at the scheduled time.
   */
  readonly preferNativeSchedule?: boolean;
}

export type CancelScheduleResult =
  | { readonly state: "cancelled"; readonly job: ScheduledJob }
  | {
      readonly state: "unresolved";
      readonly job: ScheduledJob;
      readonly unresolved: readonly UnresolvedCancellation[];
    }
  | { readonly state: "not-cancellable"; readonly job: ScheduledJob }
  | { readonly state: "not-found" };

export type RescheduleResult =
  | { readonly state: "rescheduled"; readonly job: ScheduledJob }
  | {
      readonly state: "not-reschedulable";
      readonly reason: "dispatched" | "in-flight" | "native-state-uncertain" | "terminal";
      readonly job: ScheduledJob;
    }
  | {
      readonly state: "unresolved";
      readonly job: ScheduledJob;
      readonly unresolved: readonly UnresolvedCancellation[];
    }
  | { readonly state: "not-found" };

export interface RunDueInput {
  readonly now?: Date;
  /** Maximum jobs claimed by this call, 1 through 1000. Defaults to 25. */
  readonly limit?: number;
  /**
   * Maximum jobs processed at once, 1 through 100. Defaults to 4. Within one job, lanes
   * run one after another, and every publish shares the client's per-backend limit.
   */
  readonly concurrency?: number;
}

export interface RunDueResult {
  /** Jobs this call leased. Due jobs another runner claimed first are not counted. */
  readonly claimed: number;
  readonly jobs: readonly {
    readonly scope: string;
    readonly id: string;
    readonly status: ScheduledJobStatus;
  }[];
}

/** Outcomes of one sequence item (or the single publication), by original target index. */
export interface ScheduledItemOutcomes {
  readonly itemIndex: number;
  readonly outcomes: readonly DeliveryOutcome[];
}

type JobKey = { readonly scope: string; readonly id: string };

type LeaseKey = JobKey & { readonly leaseOwner: string };

type Mutation = (job: ScheduledJob) => ScheduledJob | undefined;

const terminal: ReadonlySet<DeliveryOutcome["state"]> = new Set([
  "published",
  "failed",
  "cancelled",
  "not-submitted",
]);

function invalid(message: string, issues?: readonly PreparationIssue[]): SocialError {
  return new SocialError({
    code: "invalid_input",
    operation: "schedule",
    message,
    ...definedFields({ issues }),
  });
}

function bounded(input: {
  readonly value: number | undefined;
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
  readonly name: string;
}): number {
  const value = input.value ?? input.fallback;

  if (!Number.isSafeInteger(value) || value < input.min || value > input.max)
    throw new SocialError({
      code: "invalid_config",
      operation: "schedule",
      message: `${input.name} must be an integer from ${input.min} through ${input.max}`,
    });

  return value;
}

function scopeOf(authorization: AuthorizationContext | undefined): string {
  return authorization?.tenantId ?? "credential-ready";
}

function accountKey(account: ConnectedAccountRef): string {
  return JSON.stringify([account.backend, account.platform, account.accountId]);
}

async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index];

      if (item !== undefined) results[index] = await run(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, () => worker()));

  return results;
}

function mediaOf(target: PublishTarget, content: PublishRequest["content"]): MediaAttachment[] {
  return [...(content.media ?? []), ...(target.content?.media ?? [])];
}

/** Copies scheduled work through the durable format, so what runs later is what was stored. */
function durableWork(work: ScheduleWork): ScheduleWork {
  const items =
    work.kind === "publish"
      ? [{ targets: work.request.targets, content: work.request.content }]
      : work.request.items;

  for (const item of items)
    for (const target of item.targets)
      for (const media of mediaOf(target, item.content))
        for (const source of [media.source, media.thumbnail])
          if (source !== undefined && source.kind !== "https-url" && source.kind !== "media-ref")
            throw invalid(
              "Scheduled media must use https-url or media-ref sources; Blob and stream inputs cannot be stored",
            );

  let serialized: string;

  try {
    serialized = stableSerialize(work.request);
  } catch (error) {
    throw invalid(
      `Scheduled requests must be plain JSON data: ${error instanceof Error ? error.message : "unsupported value"}`,
    );
  }

  try {
    const value = parseJson(serialized);

    return work.kind === "publish"
      ? { kind: "publish", request: decodePublishRequest(value, "request") }
      : { kind: "sequence", request: decodeSequenceRequest(value, "request") };
  } catch (error) {
    if (error instanceof ScheduleDecodeError)
      throw invalid(`Scheduled request is not storable: ${error.message}`);
    throw error;
  }
}

function baseKey(work: ScheduleWork): string {
  return work.request.idempotencyKey ?? "";
}

/** The exact publish request a step sends. `parent` fills a chained reply. */
function stepRequest(input: {
  readonly job: Pick<ScheduledJob, "work" | "runAt" | "timeZone">;
  readonly lane: ScheduledLane;
  readonly step: ScheduledStep;
  readonly parent?: PlatformPostRef;
}): PublishRequest {
  const { job, lane, step } = input;
  const idempotencyKey = `${baseKey(job.work)}:${lane.id}:r${lane.revision}:${step.itemIndex}`;

  const item =
    job.work.kind === "publish" ? job.work.request : job.work.request.items[step.itemIndex];

  if (item === undefined) throw invalid("A scheduled step refers to a missing sequence item");

  const targets = step.targetIndexes.map((index) => {
    const target = item.targets[index];

    if (target === undefined) throw invalid("A scheduled step refers to a missing target");

    return target;
  });

  const replyTo = lane.chained && step.itemIndex > 0 ? input.parent : item.replyTo;

  return {
    targets,
    content: item.content,
    idempotencyKey,
    ...definedFields({
      replyTo,
      schedule:
        lane.mode === "native"
          ? { at: job.runAt, ...definedFields({ timeZone: job.timeZone }) }
          : undefined,
    }),
  };
}

/** Rewrites step-relative outcome indexes to the item's original target positions. */
function remap(outcomes: readonly DeliveryOutcome[], step: ScheduledStep): DeliveryOutcome[] {
  return outcomes.map((outcome) => ({
    ...outcome,
    targetIndex: step.targetIndexes[outcome.targetIndex] ?? outcome.targetIndex,
  }));
}

function refusedOutcomes(input: {
  readonly request: PublishRequest;
  readonly step: ScheduledStep;
  readonly error: SocialError;
  readonly observedAt: string;
}): DeliveryOutcome[] {
  const { error, step } = input;

  const reason =
    error.code === "unauthorized"
      ? "unauthorized"
      : error.code === "invalid_input"
        ? "validation"
        : error.code === "idempotency_conflict"
          ? "idempotency-conflict"
          : "before-submission";

  return input.request.targets.map((target, index) => ({
    state: "not-submitted",
    targetIndex: step.targetIndexes[index] ?? index,
    account: target.account,
    observedAt: input.observedAt,
    reason,
    ...definedFields({ issues: error.issues }),
  }));
}

type LaneProgress =
  | { readonly kind: "dispatch"; readonly stepIndex: number; readonly parent?: PlatformPostRef }
  | { readonly kind: "recover"; readonly stepIndex: number }
  | { readonly kind: "convert-native" }
  | { readonly kind: "wait-time" }
  | { readonly kind: "wait-outcome" }
  | { readonly kind: "stopped" }
  | { readonly kind: "done" }
  | { readonly kind: "cancelled" };

function hasUnresolved(step: ScheduledStep): boolean {
  return (
    step.state === "dispatched" && step.outcomes.some((outcome) => !terminal.has(outcome.state))
  );
}

/** Decides what a lane needs next. Pure; the scheduler performs the I/O it names. */
function laneProgress(input: {
  readonly job: ScheduledJob;
  readonly lane: ScheduledLane;
  readonly now: number;
}): LaneProgress {
  const { job, lane, now } = input;
  const stepIndex = lane.steps.findIndex((step) => step.state !== "dispatched");
  const step = lane.steps[stepIndex];

  if (step === undefined) return { kind: "done" };

  if (step.state === "cancelled") return { kind: "cancelled" };

  if (step.state === "dispatching") return { kind: "recover", stepIndex };

  const due = Date.parse(job.runAt) <= now;

  if (lane.mode === "native")
    return due ? { kind: "convert-native" } : { kind: "dispatch", stepIndex };

  if (!due) return { kind: "wait-time" };

  const previous = lane.steps[stepIndex - 1];

  if (previous === undefined || previous.state !== "dispatched")
    return { kind: "dispatch", stepIndex };

  if (previous.error !== undefined) return { kind: "stopped" };

  if (lane.chained) {
    const parent = previous.outcomes[0];

    // A reply is sent only under a parent known to be published; an accepted or unknown
    // parent might never appear, and replying to it could orphan the rest of the chain.
    if (parent?.state === "published") return { kind: "dispatch", stepIndex, parent: parent.post };

    return parent === undefined || terminal.has(parent.state)
      ? { kind: "stopped" }
      : { kind: "wait-outcome" };
  }

  const stopOnFailure = job.work.kind !== "sequence" || job.work.request.stopOnFailure !== false;

  if (!stopOnFailure) return { kind: "dispatch", stepIndex };

  if (previous.outcomes.some((outcome) => !terminal.has(outcome.state)))
    return { kind: "wait-outcome" };

  if (previous.outcomes.some((outcome) => outcome.state !== "published"))
    return { kind: "stopped" };

  return { kind: "dispatch", stepIndex };
}

function hasDispatchedRuntime(job: ScheduledJob): boolean {
  return job.lanes.some(
    (lane) =>
      lane.mode === "runtime" &&
      lane.steps.some((step) => step.state === "dispatching" || step.state === "dispatched"),
  );
}

function withStep(input: {
  readonly job: ScheduledJob;
  readonly laneId: string;
  readonly stepIndex: number;
  readonly update: (step: ScheduledStep) => ScheduledStep | undefined;
}): ScheduledJob | undefined {
  let changed = false;

  const lanes = input.job.lanes.map((lane) => {
    if (lane.id !== input.laneId) return lane;

    const steps = lane.steps.map((step, index) => {
      if (index !== input.stepIndex) return step;

      const next = input.update(step);

      if (next === undefined) return step;

      changed = true;

      return next;
    });

    return { ...lane, steps };
  });

  return changed ? { ...input.job, lanes } : undefined;
}

function pendingStep(step: ScheduledStep): ScheduledStep {
  return { itemIndex: step.itemIndex, targetIndexes: step.targetIndexes, state: "pending" };
}

/** Outcomes per item, merged across lanes, by original target index. */
export function scheduledOutcomes(job: ScheduledJob): readonly ScheduledItemOutcomes[] {
  const items = new Map<number, DeliveryOutcome[]>();

  for (const lane of job.lanes)
    for (const step of lane.steps)
      if (step.state === "dispatched") {
        const outcomes = items.get(step.itemIndex) ?? [];
        outcomes.push(...step.outcomes);
        items.set(step.itemIndex, outcomes);
      }

  return [...items.entries()]
    .sort(([left], [right]) => left - right)
    .map(([itemIndex, outcomes]) => ({
      itemIndex,
      outcomes: outcomes.sort((left, right) => left.targetIndex - right.targetIndex),
    }));
}

/**
 * Durable scheduling for publications and sequences. Every state change is a
 * compare-and-set on the job record, so several processes can call `runDue` against one
 * store: a job is processed by one lease holder at a time, and a step that may have been
 * sent is recovered from its idempotency claim instead of being sent again.
 *
 * Configure the client with a durable `idempotencyStore` that implements
 * `compareAndSetOutcome`; polling, recovery, and retries depend on it.
 */
export class SocialScheduler {
  readonly #social: SchedulerClient;
  readonly #store: ScheduleStore;
  readonly #clock: () => Date;
  readonly #jobRunner: JobRunner | undefined;
  readonly #leaseMs: number;
  readonly #pollIntervalMs: number;
  readonly #maxPolls: number;
  readonly #owner: string;

  constructor(config: SocialSchedulerConfig) {
    this.#social = config.social;
    this.#store = config.store;
    this.#clock = config.clock ?? (() => new Date());
    this.#jobRunner = config.jobRunner ?? config.social.jobRunner;

    this.#leaseMs = bounded({
      value: config.leaseMs,
      fallback: 300_000,
      min: 1_000,
      max: 3_600_000,
      name: "leaseMs",
    });

    this.#pollIntervalMs = bounded({
      value: config.pollIntervalMs,
      fallback: 60_000,
      min: 1_000,
      max: 86_400_000,
      name: "pollIntervalMs",
    });

    this.#maxPolls = bounded({
      value: config.maxPolls,
      fallback: 30,
      min: 1,
      max: 1_000,
      name: "maxPolls",
    });

    this.#owner = config.ownerId ?? crypto.randomUUID();
  }

  /** Validates, authorizes, and stores work. No provider request is sent until `runDue`. */
  async schedule(input: ScheduleInput): Promise<ScheduledJob> {
    const now = this.#clock();
    const work = durableWork(input.work);
    const scope = scopeOf(input.authorization);
    const id = input.id ?? crypto.randomUUID();

    if (id.trim() === "" || id.length > 200)
      throw invalid("Job id must be a nonempty string of at most 200 characters");

    if (baseKey(work).trim() === "") throw invalid("Scheduled work requires an idempotencyKey");

    if (work.kind === "publish" && work.request.schedule !== undefined)
      throw invalid(
        "Set the time with `at`; the scheduler chooses whether a route schedules natively",
      );

    const lanes = this.#lanes(work, input.preferNativeSchedule !== false);
    const at = input.at;

    const draft = (runAt: string): ScheduledJob => ({
      version: 1,
      id,
      scope,
      status: "scheduled",
      runAt,
      work,
      lanes,
      nextRunAt: lanes.some((lane) => lane.mode === "native") ? now.toISOString() : runAt,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      ...definedFields({
        timeZone: at.kind === "instant" ? undefined : at.timeZone,
        queueId: at.kind === "queue" ? at.queueId : undefined,
        authorization: input.authorization,
      }),
    });

    if (at.kind !== "queue") {
      const fixed = resolveFixedTime(at);

      if (Date.parse(fixed) <= now.getTime())
        throw invalid("The scheduled time must be in the future");

      const job = draft(fixed);
      await this.#preflight(job);

      return this.#create(job);
    }

    validateQueue(at);
    await this.#preflight(draft(new Date(now.getTime() + 86_400_000).toISOString()));

    const runAt = await this.#reserveQueueSlot({ key: { scope, id }, at, now: now.getTime() });

    return this.#create(draft(runAt));
  }

  /** Reads a job in the caller's tenant scope. */
  async get(id: string, options: ScheduleCallOptions = {}): Promise<ScheduledJob | undefined> {
    const stored = await this.#store.get({ scope: scopeOf(options.authorization), id });

    if (stored === undefined) return undefined;

    await this.#authorizeCaller(stored.job, options, "posts.read");

    return stored.job;
  }

  /**
   * Stops every step that has not been sent, then asks providers to cancel natively
   * scheduled posts. The job is `cancelled` only when nothing can still publish; anything
   * a provider did not confirm is listed as unresolved. Calling again retries those.
   */
  async cancel(id: string, options: ScheduleCallOptions = {}): Promise<CancelScheduleResult> {
    const key = { scope: scopeOf(options.authorization), id };
    const stored = await this.#store.get(key);

    if (stored === undefined) return { state: "not-found" };

    await this.#authorizeCaller(stored.job, options, "posts.cancelScheduled");
    const requestedAt = this.#clock().toISOString();

    // Cancelling pending steps first fences runners: their dispatch compare-and-set fails.
    const fenced = await this.#mutate(key, (job) => {
      if (job.status === "completed" || job.status === "cancelled") return undefined;

      const { nextRunAt: _cleared, ...rest } = job;

      return {
        ...rest,
        status: "cancel-unresolved",
        lanes: job.lanes.map((lane) => ({
          ...lane,
          steps: lane.steps.map((step) =>
            step.state === "pending" ? { ...pendingStep(step), state: "cancelled" } : step,
          ),
        })),
        cancellation: { requestedAt: job.cancellation?.requestedAt ?? requestedAt, unresolved: [] },
        updatedAt: requestedAt,
      };
    });

    if (fenced === undefined) return { state: "not-found" };

    if (fenced.job.status === "completed") return { state: "not-cancellable", job: fenced.job };

    if (fenced.job.status === "cancelled") return { state: "cancelled", job: fenced.job };

    const { job, unresolved } = await this.#cancelProviderWork({
      key,
      job: fenced.job,
      finalize: true,
      authorization: options.authorization,
    });

    return unresolved.length === 0
      ? { state: "cancelled", job }
      : { state: "unresolved", job, unresolved };
  }

  /**
   * Moves a job that has not started. Provider-side scheduled posts are cancelled first;
   * the job moves only after every provider confirms, so an uncertain cancellation can
   * never leave two scheduled copies.
   */
  async reschedule(
    id: string,
    at: ScheduleTime,
    options: ScheduleCallOptions = {},
  ): Promise<RescheduleResult> {
    const key = { scope: scopeOf(options.authorization), id };
    const stored = await this.#store.get(key);

    if (stored === undefined) return { state: "not-found" };

    const { job } = stored;
    await this.#authorizeCaller(job, options, "posts.schedule");
    const now = this.#clock().getTime();

    if (
      job.status === "completed" ||
      job.status === "cancelled" ||
      job.status === "cancel-unresolved"
    )
      return { state: "not-reschedulable", reason: "terminal", job };

    if (hasDispatchedRuntime(job)) return { state: "not-reschedulable", reason: "dispatched", job };

    const nativeSteps = job.lanes
      .filter((lane) => lane.mode === "native")
      .flatMap((lane) => lane.steps);

    if (
      nativeSteps.some((step) => step.state === "dispatching") ||
      (job.lease !== undefined && Date.parse(job.lease.until) > now)
    )
      return { state: "not-reschedulable", reason: "in-flight", job };

    // Only provider copies that are still scheduled can be withdrawn with confirmation.
    if (
      nativeSteps.some(
        (step) =>
          step.state === "dispatched" &&
          step.outcomes.some(
            (outcome) =>
              outcome.state === "published" ||
              (outcome.state !== "scheduled" && !terminal.has(outcome.state)),
          ),
      )
    )
      return { state: "not-reschedulable", reason: "native-state-uncertain", job };

    const fixed = at.kind === "queue" ? undefined : resolveFixedTime(at);

    if (at.kind === "queue") validateQueue(at);

    if (fixed !== undefined && Date.parse(fixed) <= now)
      throw invalid("The scheduled time must be in the future");

    // Revalidate pending work with the stored execution context before removing a block.
    await this.#preflight({ ...job, runAt: fixed ?? job.runAt });

    // A reschedule lease keeps runners off the job while provider cancellations run.
    const fenceOwner = `reschedule:${crypto.randomUUID()}`;

    const fenced = await this.#store.compareAndSet({
      expectedRevision: stored.revision,
      job: {
        ...job,
        lease: { owner: fenceOwner, until: new Date(now + this.#leaseMs).toISOString() },
      },
    });

    if (!fenced.updated) return { state: "not-reschedulable", reason: "in-flight", job };

    if (nativeSteps.some((step) => step.state === "dispatched")) {
      const withdrawn = await this.#cancelProviderWork({
        key,
        job,
        finalize: false,
        leaseOwner: fenceOwner,
        authorization: options.authorization,
      });

      if (withdrawn.unresolved.length > 0) {
        // Some provider copies may still publish, so the job stops instead of moving.
        await this.#mutate(key, (current) => {
          if (current.lease?.owner !== fenceOwner) return undefined;

          const { lease: _released, ...rest } = current;

          return rest;
        });

        const stopped = await this.cancel(id, options);

        return {
          state: "unresolved",
          job: stopped.state === "not-found" ? withdrawn.job : stopped.job,
          unresolved: withdrawn.unresolved,
        };
      }
    }

    const runAt =
      fixed ??
      (at.kind === "queue"
        ? await this.#reserveQueueSlot({ key, at, now, skip: job.runAt })
        : job.runAt);

    const updatedAt = this.#clock().toISOString();

    const moved = await this.#mutate(key, (current) => {
      if (
        current.lease?.owner !== fenceOwner ||
        current.status === "cancelled" ||
        current.status === "cancel-unresolved"
      )
        return undefined;

      // A native lane converted to runtime after a missed window becomes native again.
      const lanes = current.lanes.map(
        (lane): ScheduledLane => ({
          ...lane,
          mode: lane.id === "native" ? "native" : lane.mode,
          revision: lane.revision + 1,
          steps: lane.steps.map(pendingStep),
        }),
      );

      const {
        lease: _released,
        timeZone: _zone,
        queueId: _queue,
        blocked: _block,
        ...rest
      } = current;

      return {
        ...rest,
        status: "scheduled",
        runAt,
        lanes,
        nextRunAt: lanes.some((lane) => lane.mode === "native") ? updatedAt : runAt,
        updatedAt,
        ...definedFields({
          timeZone: at.kind === "instant" ? undefined : at.timeZone,
          queueId: at.kind === "queue" ? at.queueId : undefined,
        }),
      };
    });

    if (moved === undefined || moved.job.lease !== undefined || moved.job.status !== "scheduled")
      return { state: "not-reschedulable", reason: "in-flight", job };

    await this.#wake(moved.job);

    return { state: "rescheduled", job: moved.job };
  }

  /** Claims due jobs and advances each as far as it can go now. */
  async runDue(input: RunDueInput = {}): Promise<RunDueResult> {
    const now = input.now ?? this.#clock();
    const limit = bounded({ value: input.limit, fallback: 25, min: 1, max: 1_000, name: "limit" });

    const concurrency = bounded({
      value: input.concurrency,
      fallback: 4,
      min: 1,
      max: 100,
      name: "concurrency",
    });

    const due = await this.#store.listDue({ now: now.toISOString(), limit });

    const processed = await mapLimited(due, concurrency, (stored) =>
      this.#process({ stored, now, force: false, retry: false }),
    );

    const jobs = processed.flatMap((job) =>
      job === undefined ? [] : [{ scope: job.scope, id: job.id, status: job.status }],
    );

    return { claimed: jobs.length, jobs };
  }

  /** Polls this job's pending outcomes now, even past `maxPolls`, and advances it. */
  async reconcile(
    id: string,
    options: ScheduleCallOptions = {},
  ): Promise<ScheduledJob | undefined> {
    const stored = await this.#store.get({ scope: scopeOf(options.authorization), id });

    if (stored === undefined) return undefined;

    await this.#authorizeCaller(stored.job, options, "posts.getDelivery");

    return this.#process({ stored, now: this.#clock(), force: true, retry: false });
  }

  /**
   * Re-sends destinations whose saved outcome proves nothing is live (retryable failures,
   * `not-submitted`, pre-submission cancellations), then advances the job so a stopped
   * chain can continue. Published and unresolved destinations are never sent again.
   */
  async retryFailed(
    id: string,
    options: ScheduleCallOptions = {},
  ): Promise<ScheduledJob | undefined> {
    const stored = await this.#store.get({ scope: scopeOf(options.authorization), id });

    if (stored === undefined) return undefined;

    await this.#authorizeCaller(stored.job, options, "posts.publish");

    return this.#process({ stored, now: this.#clock(), force: true, retry: true });
  }

  async #authorizeCaller(
    job: ScheduledJob,
    options: ScheduleCallOptions,
    operation: import("../core/types.js").OperationName,
  ): Promise<void> {
    const targets =
      job.work.kind === "publish"
        ? job.work.request.targets
        : job.work.request.items.flatMap((item) => item.targets);

    await this.#social.posts.authorize(
      { targets, content: {} },
      { ...definedFields({ authorization: options.authorization }), operation },
    );
  }

  #nativeRoute(account: ConnectedAccountRef): boolean {
    const manifest = this.#social.capabilities()[account.backend];

    // Like the client, the first declaration matching the platform decides availability.
    const available = (operation: string) =>
      manifest?.capabilities.find(
        (candidate) =>
          candidate.operation === operation &&
          (candidate.platform === "*" || candidate.platform === account.platform),
      )?.availability === "available";

    return (
      available("posts.publish") &&
      available("posts.schedule") &&
      available("posts.cancelScheduled")
    );
  }

  #lanes(work: ScheduleWork, preferNative: boolean): ScheduledLane[] {
    if (work.kind === "publish") {
      if (work.request.targets.length === 0) throw invalid("At least one target is required");

      const native: number[] = [];
      const runtime: number[] = [];

      for (const [index, target] of work.request.targets.entries()) {
        if (preferNative && this.#nativeRoute(target.account)) native.push(index);
        else runtime.push(index);
      }

      const lane = (id: "native" | "runtime", targetIndexes: readonly number[]): ScheduledLane => ({
        id,
        mode: id,
        chained: false,
        revision: 0,
        steps: [{ itemIndex: 0, targetIndexes, state: "pending" }],
      });

      const lanes: ScheduledLane[] = [];

      if (native.length > 0) lanes.push(lane("native", native));

      if (runtime.length > 0) lanes.push(lane("runtime", runtime));

      return lanes;
    }

    const { items } = work.request;

    if (items.length === 0 || items.length > 100)
      throw invalid("A sequence needs from 1 through 100 items");

    if (work.request.replyToPrevious !== true)
      return [
        {
          id: "items",
          mode: "runtime",
          chained: false,
          revision: 0,
          steps: items.map((item, itemIndex) => ({
            itemIndex,
            targetIndexes: item.targets.map((_target, index) => index),
            state: "pending",
          })),
        },
      ];

    const destinations = (items[0]?.targets ?? []).map((target) => accountKey(target.account));

    if (destinations.length === 0 || new Set(destinations).size !== destinations.length)
      throw invalid("A reply chain needs distinct destination accounts");

    for (const [itemIndex, item] of items.entries()) {
      const keys = item.targets.map((target) => accountKey(target.account));

      if (keys.length !== destinations.length || keys.some((key) => !destinations.includes(key)))
        throw invalid("Every item of a reply chain must target the same destination accounts");

      if (
        itemIndex > 0 &&
        (item.replyTo !== undefined || item.targets.some((target) => target.replyTo !== undefined))
      )
        throw invalid("Items after the first in a reply chain cannot set replyTo");
    }

    // One lane per destination: each chain advances on its own published parents.
    return destinations.map((destination, laneIndex) => ({
      id: `d${laneIndex}`,
      mode: "runtime",
      chained: true,
      revision: 0,
      steps: items.map((item, itemIndex) => ({
        itemIndex,
        targetIndexes: [
          item.targets.findIndex((target) => accountKey(target.account) === destination),
        ],
        state: "pending",
      })),
    }));
  }

  /**
   * Prepares and authorizes every pending step, with a placeholder parent for chained
   * replies, so a route that rejects replies fails before any root post is sent.
   */
  async #preflight(job: ScheduledJob): Promise<void> {
    const issues: PreparationIssue[] = [];
    const options = definedFields({ authorization: job.authorization });

    for (const lane of job.lanes)
      for (const step of lane.steps) {
        if (step.state !== "pending") continue;

        const account = stepRequest({ job, lane, step }).targets[0]?.account;

        const parent: PlatformPostRef | undefined =
          lane.chained && step.itemIndex > 0 && account !== undefined
            ? {
                kind: "platform-post",
                version: 1,
                backend: account.backend,
                platform: account.platform,
                accountId: account.accountId,
                postId: "preflight",
              }
            : undefined;

        const request = stepRequest({ job, lane, step, ...definedFields({ parent }) });
        const plan = this.#social.posts.prepare(request);

        for (const issue of plan.issues)
          issues.push({
            ...issue,
            path: `items[${step.itemIndex}]${issue.path === undefined ? "" : `.${issue.path}`}`,
            ...definedFields({
              targetIndex:
                issue.targetIndex === undefined ? undefined : step.targetIndexes[issue.targetIndex],
            }),
          });

        if (plan.ok) await this.#social.posts.authorize(request, options);
      }

    if (issues.some((issue) => issue.severity === "error"))
      throw invalid("Scheduled work failed preparation; nothing was stored or sent", issues);
  }

  async #reserveQueueSlot(input: {
    readonly key: JobKey;
    readonly at: Extract<ScheduleTime, { readonly kind: "queue" }>;
    readonly now: number;
    readonly skip?: string;
  }): Promise<string> {
    const { scope, id } = input.key;

    const after = Math.max(
      input.now,
      input.at.notBefore === undefined
        ? 0
        : Date.parse(parseInstant(input.at.notBefore, "notBefore")),
    );

    let attempts = 0;

    for (const candidate of queueSlotInstants({
      timeZone: input.at.timeZone,
      slots: input.at.slots,
      after,
      horizonDays: 366,
    })) {
      if (++attempts > 1_000) break;

      if (candidate === input.skip) continue;

      if (
        await this.#store.reserveSlot({
          scope,
          queueId: input.at.queueId,
          at: candidate,
          jobId: id,
        })
      )
        return candidate;
    }

    throw invalid("No free queue slot was found in the next 366 days");
  }

  async #create(job: ScheduledJob): Promise<ScheduledJob> {
    const created = await this.#store.create(job);

    if (!created.created) throw invalid(`A scheduled job with id ${job.id} already exists`);

    await this.#wake(job);

    return job;
  }

  async #wake(job: ScheduledJob): Promise<void> {
    if (this.#jobRunner === undefined || job.nextRunAt === undefined) return;

    try {
      await this.#jobRunner.enqueue({
        type: "social-sdk.schedule.run-due",
        runAt: job.nextRunAt,
        payload: { jobId: job.id },
      });
    } catch {
      // Hints are advisory; the next periodic runDue still finds the job in the store.
    }
  }

  /** Applies a mutation with compare-and-set, re-reading and re-applying on conflict. */
  async #mutate(key: JobKey, mutation: Mutation): Promise<StoredScheduledJob | undefined> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const stored = await this.#store.get(key);

      if (stored === undefined) return undefined;

      const next = mutation(stored.job);

      if (next === undefined) return stored;

      const result = await this.#store.compareAndSet({
        expectedRevision: stored.revision,
        job: next,
      });

      if (result.updated) return { job: next, revision: result.revision };
    }

    throw new SocialError({
      code: "upstream_failure",
      operation: "schedule.store",
      message: "The scheduled job kept changing; try again",
    });
  }

  /** Mutates only while this process holds the job's lease. */
  #leased(key: LeaseKey, mutation: Mutation): Mutation {
    return (job) => (job.lease?.owner === key.leaseOwner ? mutation(job) : undefined);
  }

  /**
   * Asks providers to cancel scheduled copies and records what they confirmed. With
   * `finalize`, the job becomes `cancelled` or `cancel-unresolved`.
   */
  async #cancelProviderWork(input: {
    readonly key: JobKey;
    readonly job: ScheduledJob;
    readonly finalize: boolean;
    readonly leaseOwner?: string;
    /** The caller asking for the cancellation; provider calls act with this context. */
    readonly authorization: AuthorizationContext | undefined;
  }): Promise<{
    readonly job: ScheduledJob;
    readonly unresolved: readonly UnresolvedCancellation[];
  }> {
    const unresolved: UnresolvedCancellation[] = [];
    const confirmed = new Map<string, DeliveryOutcome>();
    const observedAt = this.#clock().toISOString();
    const options = definedFields({ authorization: input.authorization });

    for (const lane of input.job.lanes)
      for (const [stepIndex, step] of lane.steps.entries()) {
        if (step.state === "dispatching") {
          for (const targetIndex of step.targetIndexes)
            unresolved.push({ itemIndex: step.itemIndex, targetIndex, reason: "in-flight" });
          continue;
        }

        if (step.state !== "dispatched") continue;

        for (const outcome of step.outcomes) {
          if (terminal.has(outcome.state)) continue;

          const entry = { itemIndex: step.itemIndex, targetIndex: outcome.targetIndex };

          if (outcome.state !== "scheduled") {
            unresolved.push({ ...entry, reason: "not-cancellable-state" });
            continue;
          }

          try {
            await this.#social.posts.cancelScheduled(outcome.job, options);
            confirmed.set(`${lane.id}/${stepIndex}/${outcome.targetIndex}`, {
              state: "cancelled",
              targetIndex: outcome.targetIndex,
              account: outcome.account,
              observedAt,
              reason: "schedule-cancelled",
              ...definedFields({ delivery: outcome.delivery }),
            });
          } catch (error) {
            unresolved.push({
              ...entry,
              reason:
                error instanceof SocialError && error.code === "unsupported_capability"
                  ? "cancel-unsupported"
                  : "cancel-failed",
            });
          }
        }
      }

    const updated = await this.#mutate(input.key, (current) => {
      if (input.leaseOwner !== undefined && current.lease?.owner !== input.leaseOwner)
        return undefined;

      const lanes = current.lanes.map((lane) => ({
        ...lane,
        steps: lane.steps.map((step, stepIndex) =>
          step.state === "dispatched"
            ? {
                ...step,
                outcomes: step.outcomes.map(
                  (outcome) =>
                    confirmed.get(`${lane.id}/${stepIndex}/${outcome.targetIndex}`) ?? outcome,
                ),
              }
            : step,
        ),
      }));

      if (!input.finalize) return { ...current, lanes, updatedAt: observedAt };

      return {
        ...current,
        lanes,
        status: unresolved.length === 0 ? "cancelled" : "cancel-unresolved",
        cancellation: { requestedAt: current.cancellation?.requestedAt ?? observedAt, unresolved },
        updatedAt: observedAt,
      };
    });

    return { job: updated?.job ?? input.job, unresolved };
  }

  /**
   * Leases a job, advances it, and releases it. `force` runs a job that is not due and
   * polls past `maxPolls`; `retry` first re-sends failed destinations.
   */
  async #process(input: {
    readonly stored: StoredScheduledJob;
    readonly now: Date;
    readonly force: boolean;
    readonly retry: boolean;
  }): Promise<ScheduledJob | undefined> {
    const nowMs = input.now.getTime();
    const { job } = input.stored;

    if (job.lease !== undefined && Date.parse(job.lease.until) > nowMs) {
      if (!input.force) return undefined;

      throw new SocialError({
        code: "rate_limited",
        operation: "schedule.run",
        message: "Another runner holds this job; try again after its lease expires",
        retryDisposition: { kind: "after-delay", delayMs: Date.parse(job.lease.until) - nowMs },
      });
    }

    if (job.status === "cancelled") return input.force ? job : undefined;

    // An explicit retry may clear a block that the retry itself can resolve.
    const { blocked: _cleared, ...unblocked } = job;

    const leaseOwner = `${this.#owner}:${crypto.randomUUID()}`;

    const claimed = await this.#store.compareAndSet({
      expectedRevision: input.stored.revision,
      job: {
        ...(input.retry ? unblocked : job),
        lease: { owner: leaseOwner, until: new Date(nowMs + this.#leaseMs).toISOString() },
      },
    });

    if (!claimed.updated) return undefined;

    const key: LeaseKey = { scope: job.scope, id: job.id, leaseOwner };
    const touched = new Set<string>();

    try {
      if (job.status === "cancel-unresolved") {
        // Cancellation fences new submissions, but durable claims can still supply the
        // references needed to cancel provider work after a runner crashed.
        for (const lane of job.lanes)
          for (const [stepIndex, step] of lane.steps.entries())
            if (step.state === "dispatching") await this.#recover({ key, job, lane, stepIndex });

        await this.#poll({ key, now: nowMs, force: input.force, touched });
      } else {
        if (input.retry) await this.#retrySteps(key);

        for (let round = 0; round < 3; round++) {
          const advanced = await this.#advance({ key, now: nowMs, touched });
          const polled = await this.#poll({ key, now: nowMs, force: input.force, touched });

          if (!advanced && !polled) break;
        }
      }
    } finally {
      // Releasing records the next due time even if a provider call threw.
      await this.#release({ key, now: nowMs, force: input.force });
    }

    return (await this.#store.get(key))?.job;
  }

  async #retrySteps(key: LeaseKey): Promise<void> {
    const stored = await this.#store.get(key);

    if (stored === undefined || stored.job.lease?.owner !== key.leaseOwner) return;

    const options = definedFields({ authorization: stored.job.authorization });

    for (const lane of stored.job.lanes)
      for (const [stepIndex, step] of lane.steps.entries()) {
        if (
          step.state !== "dispatched" ||
          !step.outcomes.some(
            (outcome) => outcome.state !== "published" && terminal.has(outcome.state),
          )
        )
          continue;

        let result: Awaited<ReturnType<SchedulerClient["posts"]["retryFailed"]>>;

        if ((await this.#store.get(key))?.job.lease?.owner !== key.leaseOwner) return;

        try {
          result = await this.#social.posts.retryFailed(step.request, options);
        } catch (cause) {
          // A step the client refuses to retry (for example a native time that has passed)
          // keeps its outcomes; other steps are still retried.
          if (!(cause instanceof SocialError)) throw cause;
          continue;
        }

        if (result.retried.length === 0) continue;

        await this.#mutate(
          key,
          this.#leased(key, (current) =>
            withStep({
              job: current,
              laneId: lane.id,
              stepIndex,
              update: (saved) =>
                saved.state === "dispatched"
                  ? {
                      ...pendingStep(saved),
                      state: "dispatched",
                      request: saved.request,
                      outcomes: remap(result.outcomes, saved),
                      polls: 0,
                    }
                  : undefined,
            }),
          ),
        );
      }
  }

  /** Dispatches every step that is due and unblocked. Returns whether anything changed. */
  async #advance(input: {
    readonly key: LeaseKey;
    readonly now: number;
    readonly touched: Set<string>;
  }): Promise<boolean> {
    const { key, now, touched } = input;
    let changed = false;
    let preflighted = false;

    for (let guard = 0; guard < 1_000; guard++) {
      const stored = await this.#store.get(key);

      if (stored === undefined || stored.job.lease?.owner !== key.leaseOwner) return changed;

      const { job } = stored;

      if (
        job.status === "cancelled" ||
        job.status === "cancel-unresolved" ||
        job.blocked !== undefined
      )
        return changed;

      let acted = false;

      for (const lane of job.lanes) {
        const progress = laneProgress({ job, lane, now });

        if (progress.kind === "convert-native") {
          // Nothing reached the provider before the time arrived, so runtime dispatch is safe.
          await this.#mutate(
            key,
            this.#leased(key, (current) => ({
              ...current,
              lanes: current.lanes.map((candidate) =>
                candidate.id === lane.id ? { ...candidate, mode: "runtime" } : candidate,
              ),
            })),
          );
          acted = true;
          break;
        }

        if (progress.kind === "recover") {
          await this.#recover({ key, job, lane, stepIndex: progress.stepIndex });
          acted = true;
          break;
        }

        if (progress.kind !== "dispatch") continue;

        if (!preflighted) {
          preflighted = true;
          const blocked = await this.#preflightBlock(job);

          if (blocked !== undefined) {
            await this.#mutate(
              key,
              this.#leased(key, (current) => ({ ...current, blocked })),
            );

            return true;
          }
        }

        const step = lane.steps[progress.stepIndex];

        if (step === undefined) continue;

        const request = stepRequest({
          job,
          lane,
          step,
          ...definedFields({ parent: progress.parent }),
        });

        // Recording the exact request before sending is the dispatch fence: a cancel that
        // lands first makes this write fail, and a crash after it is recovered from the
        // idempotency claim instead of being sent again.
        const marked = await this.#mutate(
          key,
          this.#leased(key, (current) =>
            current.status === "cancelled" || current.status === "cancel-unresolved"
              ? undefined
              : withStep({
                  job: current,
                  laneId: lane.id,
                  stepIndex: progress.stepIndex,
                  update: (saved) =>
                    saved.state === "pending"
                      ? { ...pendingStep(saved), state: "dispatching", request }
                      : undefined,
                }),
          ),
        );

        const markedStep = marked?.job.lanes.find((candidate) => candidate.id === lane.id)?.steps[
          progress.stepIndex
        ];

        if (
          marked?.job.lease?.owner !== key.leaseOwner ||
          marked.job.status === "cancelled" ||
          marked.job.status === "cancel-unresolved" ||
          markedStep?.state !== "dispatching" ||
          stableSerialize(markedStep.request) !== stableSerialize(request)
        )
          return changed;

        let outcomes: DeliveryOutcome[];
        let error: { readonly code: string; readonly message: string } | undefined;

        try {
          const result = await this.#social.posts.publish(
            request,
            definedFields({ authorization: job.authorization }),
          );

          outcomes = remap(result.outcomes, step);
        } catch (cause) {
          // A non-SocialError leaves the step dispatching; the next lease holder recovers it.
          if (!(cause instanceof SocialError)) throw cause;

          outcomes = refusedOutcomes({
            request,
            step,
            error: cause,
            observedAt: new Date(now).toISOString(),
          });

          error = { code: cause.code, message: cause.message };
        }

        touched.add(`${lane.id}/${progress.stepIndex}`);
        await this.#mutate(
          key,
          this.#leased(key, (current) =>
            withStep({
              job: current,
              laneId: lane.id,
              stepIndex: progress.stepIndex,
              update: (saved) =>
                saved.state === "dispatching"
                  ? {
                      ...pendingStep(saved),
                      state: "dispatched",
                      request: saved.request,
                      outcomes,
                      polls: 0,
                      ...definedFields({ error }),
                    }
                  : undefined,
            }),
          ),
        );
        acted = true;
        break;
      }

      if (!acted) return changed;

      changed = true;
    }

    return changed;
  }

  async #preflightBlock(
    job: ScheduledJob,
  ): Promise<{ readonly code: string; readonly message: string } | undefined> {
    try {
      await this.#preflight(job);

      return undefined;
    } catch (error) {
      if (!(error instanceof SocialError)) throw error;

      return { code: error.code, message: error.message };
    }
  }

  /** A step an earlier lease holder marked dispatching: read its claim, never resend. */
  async #recover(input: {
    readonly key: LeaseKey;
    readonly job: ScheduledJob;
    readonly lane: ScheduledLane;
    readonly stepIndex: number;
  }): Promise<void> {
    const step = input.lane.steps[input.stepIndex];

    if (step?.state !== "dispatching") return;

    let outcomes: DeliveryOutcome[];

    try {
      const result = await this.#social.posts.reconcile(
        step.request,
        definedFields({ authorization: input.job.authorization }),
      );

      outcomes = remap(result.outcomes, step);
    } catch (cause) {
      if (!(cause instanceof SocialError)) throw cause;

      await this.#mutate(
        input.key,
        this.#leased(input.key, (current) => ({
          ...current,
          blocked: { code: cause.code, message: cause.message },
        })),
      );

      return;
    }

    await this.#mutate(
      input.key,
      this.#leased(input.key, (current) =>
        withStep({
          job: current,
          laneId: input.lane.id,
          stepIndex: input.stepIndex,
          update: (saved) =>
            saved.state === "dispatching"
              ? {
                  ...pendingStep(saved),
                  state: "dispatched",
                  request: saved.request,
                  outcomes,
                  polls: 0,
                }
              : undefined,
        }),
      ),
    );
  }

  /** Reconciles dispatched steps with unresolved outcomes. Returns whether any state changed. */
  async #poll(input: {
    readonly key: LeaseKey;
    readonly now: number;
    readonly force: boolean;
    readonly touched: Set<string>;
  }): Promise<boolean> {
    const stored = await this.#store.get(input.key);

    if (stored === undefined || stored.job.lease?.owner !== input.key.leaseOwner) return false;

    const { job } = stored;
    let changed = false;

    for (const lane of job.lanes)
      for (const [stepIndex, step] of lane.steps.entries()) {
        const id = `${lane.id}/${stepIndex}`;

        if (step.state !== "dispatched" || !hasUnresolved(step) || input.touched.has(id)) continue;

        if (!input.force && step.polls >= this.#maxPolls) continue;

        // A provider-scheduled post does not change before its time.
        if (!input.force && lane.mode === "native" && Date.parse(job.runAt) > input.now) continue;

        input.touched.add(id);

        let outcomes: DeliveryOutcome[] | undefined;

        try {
          const result = await this.#social.posts.reconcile(
            step.request,
            definedFields({ authorization: job.authorization }),
          );

          outcomes = remap(result.outcomes, step);
        } catch (cause) {
          // Authorization or capability failures leave outcomes unchanged and count a poll.
          if (!(cause instanceof SocialError)) throw cause;
        }

        await this.#mutate(
          input.key,
          this.#leased(input.key, (current) =>
            withStep({
              job: current,
              laneId: lane.id,
              stepIndex,
              update: (saved) =>
                saved.state === "dispatched"
                  ? {
                      ...saved,
                      // Provider cancellation is saved on the job, while its original
                      // idempotency claim may still report the earlier scheduled state.
                      outcomes: saved.outcomes.map((outcome) =>
                        terminal.has(outcome.state)
                          ? outcome
                          : (outcomes?.find(
                              (polled) => polled.targetIndex === outcome.targetIndex,
                            ) ?? outcome),
                      ),
                      polls: saved.polls + 1,
                    }
                  : undefined,
            }),
          ),
        );

        const before = step.outcomes.map((outcome) => outcome.state).join();

        if (outcomes !== undefined && outcomes.map((outcome) => outcome.state).join() !== before)
          changed = true;
      }

    return changed;
  }

  /** Computes status and the next due time, and drops this process's lease. */
  async #release(input: {
    readonly key: LeaseKey;
    readonly now: number;
    readonly force: boolean;
  }): Promise<void> {
    const { now } = input;

    const released = await this.#mutate(
      input.key,
      this.#leased(input.key, (job) => {
        const { lease: _lease, nextRunAt: _next, ...rest } = job;
        const updatedAt = new Date(now).toISOString();

        if (job.status === "cancelled" || job.status === "cancel-unresolved")
          return { ...rest, updatedAt };

        const due: number[] = [];
        let pending = false;

        for (const lane of job.lanes) {
          const progress = laneProgress({ job, lane, now });

          if (progress.kind !== "done") pending = true;

          if (progress.kind === "wait-time") due.push(Date.parse(job.runAt));

          if (
            progress.kind === "dispatch" ||
            progress.kind === "convert-native" ||
            progress.kind === "recover"
          )
            due.push(now + this.#pollIntervalMs);

          for (const step of lane.steps) {
            if (!hasUnresolved(step)) continue;

            pending = true;

            if (step.state === "dispatched" && step.polls >= this.#maxPolls) continue;

            due.push(
              lane.mode === "native"
                ? Math.max(Date.parse(job.runAt), now + this.#pollIntervalMs)
                : now + this.#pollIntervalMs,
            );
          }
        }

        const next = job.blocked === undefined && due.length > 0 ? Math.min(...due) : undefined;

        const status: ScheduledJobStatus = !pending
          ? "completed"
          : next === undefined
            ? "blocked"
            : hasDispatchedRuntime(job)
              ? "running"
              : "scheduled";

        return next === undefined
          ? { ...rest, status, updatedAt }
          : { ...rest, status, updatedAt, nextRunAt: new Date(next).toISOString() };
      }),
    );

    if (released !== undefined && released.job.lease === undefined) await this.#wake(released.job);
  }
}
