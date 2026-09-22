import {
  SocialError,
  connectedAccountRef,
  defineAdapter,
  platformPostRef,
  type AccountRecord,
  type AdapterOperationContext,
  type AuthorizationPolicy,
  type CapabilityManifest,
  type CommentRef,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type IdempotencyClaim,
  type IdempotencyClaimInput,
  type IdempotencyStore,
  type JsonPrimitive,
  type SocialAdapter,
} from "../core/index.js";

export type MockScenario =
  | "immediate-text-success"
  | "media-processing-then-success"
  | "mixed-success-failure"
  | "expired-permission"
  | "reconnect-required"
  | "unsupported-feature"
  | "account-selection-cancellation"
  | "rate-limited"
  | "accepted-response-lost"
  | "duplicate-webhook"
  | "out-of-order-event"
  | "invalid-webhook"
  | "no-metric-available"
  | "provider-state-unknown"
  | "failed-upload-finalization"
  | "expired-media-url"
  | "cancelled-polling"
  | "shared-account-membership";

export interface MockHistoryEntry {
  readonly sequence: number;
  readonly operation: string;
  readonly backend: string;
  readonly account?: ConnectedAccountRef;
  readonly idempotencyKey?: string;
}

export interface MockController {
  history(): readonly MockHistoryEntry[];
  reset(): void;
  advanceProcessing(): void;
  setScenario(scenario: MockScenario): void;
  readonly webhookFixtures: readonly MockWebhookFixture[];
}

export interface MockWebhookFixture {
  readonly name: "valid" | "duplicate" | "out-of-order" | "invalid";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface MockNative {
  scenario(): MockScenario;
}

export interface MockSocialAdapter extends SocialAdapter<MockNative> {
  readonly testing: MockController;
}

export interface MockBackendOptions {
  readonly scenario?: MockScenario;
  readonly backendInstance?: string;
  readonly clock?: () => Date;
}

const encoder = new TextEncoder();

const decoder = new TextDecoder();

function mockManifest(): CapabilityManifest {
  return {
    schemaVersion: 1,
    backend: "mock",
    apiRevision: "mock-v1",
    runtime: ["node", "bun"],
    capabilities: [
      { operation: "accounts.read", platform: "*", availability: "available" },
      { operation: "posts.status", platform: "*", availability: "available" },
      {
        operation: "posts.publish",
        platform: "*",
        availability: "available",
        formats: ["text", "image", "video"],
      },
      { operation: "comments.read", platform: "*", availability: "available" },
      { operation: "comments.write", platform: "*", availability: "available" },
      { operation: "analytics.read", platform: "*", availability: "available" },
      { operation: "webhooks.verify", platform: "*", availability: "available" },
    ],
  };
}

function fixture(
  name: MockWebhookFixture["name"],
  eventId: string,
  occurredAt: string,
): MockWebhookFixture {
  return {
    name,
    headers: { "x-mock-signature": name === "invalid" ? "invalid" : "valid" },
    body: encoder.encode(JSON.stringify({ version: 1, eventId, type: "post.updated", occurredAt })),
  };
}

export function mockBackend(options: MockBackendOptions = {}): MockSocialAdapter {
  let scenario = options.scenario ?? "immediate-text-success";
  const backend = options.backendInstance ?? "default";
  const clock = options.clock ?? (() => new Date("2026-01-01T00:00:00.000Z"));
  const accountOne = connectedAccountRef({ backend, platform: "x", accountId: "mock-account-1" });

  const accountTwo = connectedAccountRef({
    backend,
    platform: "threads",
    accountId: "mock-account-2",
  });

  const accounts: readonly AccountRecord[] = [
    { ref: accountOne, displayName: "Mock Creator", handle: "mock.creator", status: "connected" },
    {
      ref: accountTwo,
      displayName: "Mock Studio",
      handle: "mock.studio",
      status: scenario === "reconnect-required" ? "reconnect-required" : "connected",
    },
  ];

  let sequence = 0;
  let deliverySequence = 0;
  const deliveries = new Map<string, DeliveryOutcome>();
  let processingAdvanced = false;
  const historyEntries: MockHistoryEntry[] = [];

  const webhooks = [
    fixture("valid", "event-1", "2026-01-01T00:00:02.000Z"),
    fixture("duplicate", "event-1", "2026-01-01T00:00:02.000Z"),
    fixture("out-of-order", "event-0", "2026-01-01T00:00:01.000Z"),
    fixture("invalid", "event-invalid", "2026-01-01T00:00:03.000Z"),
  ] as const;

  function record(
    operation: string,
    context: AdapterOperationContext,
    account?: ConnectedAccountRef,
  ): void {
    historyEntries.push({
      sequence: ++sequence,
      operation,
      backend: context.backendInstance,
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(account === undefined ? {} : { account }),
      // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
      ...(context.targetIdempotencyKey === undefined
        ? {}
        : { idempotencyKey: context.targetIdempotencyKey }),
    });
  }

  const testing: MockController = {
    setScenario(next) {
      scenario = next;
      processingAdvanced = false;
    },
    history: () => historyEntries.map((entry) => ({ ...entry })),
    reset: () => {
      historyEntries.length = 0;
      sequence = 0;
      processingAdvanced = false;
    },
    advanceProcessing: () => {
      processingAdvanced = true;
    },
    webhookFixtures: webhooks,
  };

  const adapter = defineAdapter({
    id: "mock",
    capabilities: mockManifest(),
    testing,
    accounts: {
      async list(_input, context) {
        record("accounts.list", context);

        if (scenario === "account-selection-cancellation") return { items: [] };

        return { items: accounts };
      },
      async get(ref, context) {
        record("accounts.get", context, ref);
        const found = accounts.find((account) => account.ref.accountId === ref.accountId);

        if (found === undefined) {
          throw new SocialError({
            code: "invalid_input",
            operation: "accounts.get",
            message: "Mock account was not found",
            account: ref,
          });
        }

        return found;
      },
    },
    posts: {
      prepareTarget(target) {
        if (scenario === "unsupported-feature") {
          return [
            {
              code: "mock.unsupported",
              message: "This scenario does not support publishing",
              severity: "error",
              targetIndex: target.targetIndex,
            },
          ];
        }

        if (
          scenario === "expired-media-url" &&
          target.content.media?.some(
            (media) => media.source.kind === "https-url" && media.source.url.includes("expired"),
          )
        ) {
          return [
            {
              code: "media.url_expired",
              message: "The mock media URL has expired",
              severity: "error",
              targetIndex: target.targetIndex,
            },
          ];
        }

        return [];
      },
      async publishTarget(target, context) {
        const deliveryNumber = ++deliverySequence;

        const execute = async (): Promise<DeliveryOutcome> => {
          record("posts.publishTarget", context, target.account);

          const base = {
            targetIndex: target.targetIndex,
            account: target.account,
            observedAt: clock().toISOString(),
            delivery: {
              kind: "delivery" as const,
              version: 1 as const,
              backend,
              platform: target.account.platform,
              accountId: target.account.accountId,
              deliveryId: `delivery-${deliveryNumber}`,
            },
          };

          if (scenario === "accepted-response-lost") {
            throw new SocialError({
              code: "ambiguous_outcome",
              operation: "posts.publish",
              message: "The mock backend accepted the request but the response was lost",
              account: target.account,
              retryDisposition: { kind: "reconcile-first" },
            });
          }

          if (scenario === "reconnect-required") {
            throw new SocialError({
              code: "reconnect_required",
              operation: "posts.publish",
              message: "Reconnect the mock account",
              account: target.account,
              retryDisposition: { kind: "after-reconnect" },
            });
          }

          if (scenario === "mixed-success-failure" && target.targetIndex % 2 === 1) {
            return {
              ...base,
              state: "failed",
              code: "mock.rejected",
              message: "Mock target rejected",
              retryDisposition: { kind: "never" },
            };
          }

          if (scenario === "expired-permission") {
            return {
              ...base,
              state: "failed",
              code: "missing_permission",
              message: "Mock permission expired",
              retryDisposition: { kind: "after-reconnect" },
            };
          }

          if (scenario === "rate-limited") {
            return {
              ...base,
              state: "failed",
              code: "rate_limited",
              message: "Mock rate limit",
              retryDisposition: { kind: "after-delay", delayMs: 1_000 },
            };
          }

          if (scenario === "provider-state-unknown") {
            return {
              ...base,
              state: "unknown",
              reason: "unmapped-state",
              backendState: "FUTURE_STATE",
              diagnostic: "Unmapped mock provider state",
            };
          }

          if (scenario === "failed-upload-finalization") {
            return {
              ...base,
              state: "failed",
              code: "media_error",
              message: "Mock upload finalization failed",
              retryDisposition: { kind: "never" },
            };
          }

          if (scenario === "media-processing-then-success" && !processingAdvanced) {
            return { ...base, state: "processing", backendState: "PROCESSING_MEDIA" };
          }

          return {
            ...base,
            state: "published",
            post: platformPostRef({
              backend,
              platform: target.account.platform,
              accountId: target.account.accountId,
              postId: `post-${deliveryNumber}`,
            }),
            url: `https://social.example.invalid/${target.account.platform}/post-${deliveryNumber}`,
          };
        };

        const outcome = await execute();

        if (outcome.delivery) deliveries.set(outcome.delivery.deliveryId, structuredClone(outcome));

        return outcome;
      },
      async getDelivery(ref, context) {
        record(
          "posts.getDelivery",
          context,
          connectedAccountRef({
            backend: ref.backend,
            platform: ref.platform,
            accountId: ref.accountId,
          }),
        );

        if (scenario === "cancelled-polling" && context.signal?.aborted) {
          throw new SocialError({
            code: "cancelled",
            operation: "posts.getDelivery",
            message: "Mock polling was cancelled",
          });
        }

        const saved = deliveries.get(ref.deliveryId);

        if (
          !saved ||
          saved.account.accountId !== ref.accountId ||
          saved.account.platform !== ref.platform ||
          saved.account.backend !== ref.backend
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "posts.getDelivery",
            message: "Mock delivery does not belong to this account.",
          });

        if (saved.state !== "processing" || !processingAdvanced) return structuredClone(saved);

        const next: DeliveryOutcome = {
          ...saved,
          state: "published",
          observedAt: clock().toISOString(),
          post: platformPostRef({
            ...saved.account,
            postId: ref.deliveryId.replace(/^delivery-/, "post-"),
          }),
        };

        deliveries.set(ref.deliveryId, next);

        return structuredClone(next);
      },
    },
    comments: {
      async list(post, _input, context) {
        record("comments.list", context, connectedAccountRef(post));

        if (
          !accounts.some(
            (account) =>
              account.ref.accountId === post.accountId && account.ref.platform === post.platform,
          )
        )
          throw new SocialError({
            code: "unauthorized",
            operation: "comments.read",
            message: "Mock account is not authorized",
          });

        return {
          items: [{ id: "comment-1", text: "Can you share more about this?", postId: post.postId }],
        };
      },
      async reply(comment, content, context): Promise<CommentRef> {
        if (
          comment.commentId !== "comment-1" ||
          !content.text.trim() ||
          !accounts.some(
            (account) =>
              account.ref.accountId === comment.accountId &&
              account.ref.platform === comment.platform,
          )
        )
          throw new SocialError({
            code: "invalid_input",
            operation: "comments.write",
            message: "Select the returned mock comment and provide reply text",
          });
        record("comments.reply", context, connectedAccountRef(comment));

        return { ...comment, commentId: `mock-reply-${sequence}` };
      },
    },
    analytics: {
      async getPostMetrics(post, context) {
        record("analytics.getPostMetrics", context, connectedAccountRef(post));

        if (scenario === "no-metric-available") return [];

        return [
          {
            name: "views",
            value: 42,
            unit: "count",
            period: "lifetime",
            measuredAt: clock().toISOString(),
            source: "mock",
          },
        ];
      },
    },
    webhooks: {
      async verify(input, context) {
        record("webhooks.verify", context);

        return {
          valid: input.headers.get("x-mock-signature") === "valid",
          method: "mock",
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
          ...(input.headers.get("x-mock-signature") === "valid"
            ? {}
            : { reason: "Invalid mock signature" }),
        };
      },
      async decode(input, context) {
        record("webhooks.decode", context);
        const parsed: unknown = JSON.parse(decoder.decode(input.body));

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new SocialError({
            code: "invalid_input",
            operation: "webhooks.decode",
            message: "Invalid mock webhook body",
          });
        }

        const entries: [string, JsonPrimitive][] = [];

        for (const [key, value] of Object.entries(parsed)) {
          if (
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            typeof value === "string" ||
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            typeof value === "number" ||
            // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
            typeof value === "boolean" ||
            value === null
          ) {
            entries.push([key, value]);
          }
        }

        return Object.fromEntries(entries);
      },
    },
    native: { scenario: () => scenario },
  });

  return adapter;
}

interface StoredClaim {
  readonly claimId: string;
  readonly fingerprint: string;
  readonly targetKeys: readonly string[];
  readonly outcomes: Record<string, DeliveryOutcome>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #claimsByKey = new Map<string, StoredClaim>();
  readonly #claimsById = new Map<string, StoredClaim>();
  #sequence = 0;

  async claim(input: IdempotencyClaimInput): Promise<IdempotencyClaim> {
    const mapKey = JSON.stringify([input.scope, input.key]);
    const existing = this.#claimsByKey.get(mapKey);

    if (existing !== undefined) {
      if (
        existing.fingerprint !== input.fingerprint ||
        JSON.stringify(existing.targetKeys) !== JSON.stringify(input.targetKeys)
      )
        return { kind: "conflict" };

      return {
        kind: "existing",
        claimId: existing.claimId,
        outcomes: structuredClone(existing.outcomes),
      };
    }

    const claim: StoredClaim = {
      claimId: `mock-claim-${++this.#sequence}`,
      fingerprint: input.fingerprint,
      targetKeys: [...input.targetKeys],
      outcomes: {},
    };

    this.#claimsByKey.set(mapKey, claim);
    this.#claimsById.set(claim.claimId, claim);

    return { kind: "new", claimId: claim.claimId, outcomes: {} };
  }

  async saveOutcome(input: {
    readonly claimId: string;
    readonly targetKey: string;
    readonly outcome: DeliveryOutcome;
  }): Promise<void> {
    const claim = this.#claimsById.get(input.claimId);

    if (claim === undefined) throw new Error(`Unknown idempotency claim: ${input.claimId}`);

    if (!claim.targetKeys.includes(input.targetKey)) {
      throw new Error(`Target does not belong to idempotency claim: ${input.targetKey}`);
    }

    claim.outcomes[input.targetKey] = structuredClone(input.outcome);
  }

  reset(): void {
    this.#claimsByKey.clear();
    this.#claimsById.clear();
    this.#sequence = 0;
  }
}

export function mockSharedAccountAuthorization(input: {
  readonly memberships: Readonly<Record<string, readonly string[]>>;
}): AuthorizationPolicy {
  return {
    async authorizeTargets({ accounts, context }) {
      const tenant = context.authorization?.tenantId;

      return accounts.map((account) => ({
        account,
        allowed:
          tenant !== undefined && (input.memberships[tenant]?.includes(account.accountId) ?? false),
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
        ...(tenant === undefined ? { reason: "A tenant is required" } : {}),
      }));
    },
  };
}
