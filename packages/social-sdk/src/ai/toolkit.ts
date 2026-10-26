import {
  decodePublishContent,
  decodePublishRequestValue,
  decodePublishTarget,
  decodeReplyReference,
  PublishRequestInputError,
} from "../cli-request.js";
import type { AuthorizationPolicy } from "../core/adapter.js";
import type { PublishCallOptions, SocialClient } from "../core/client.js";
import { withPreflightParents } from "../core/client-support.js";
import { createConcurrencyLimiter } from "../core/concurrency.js";
import { SocialError, type SocialErrorCode } from "../core/errors.js";
import { definedFields } from "../core/fields.js";
import type {
  AdapterOperationContext,
  AuthorizationContext,
  CapabilityDeclaration,
  CapabilityManifest,
  ConnectedAccountRef,
  JsonObject,
  JsonValue,
  OperationName,
  PreparationIssue,
  PreparedPublishTarget,
  PublishPreparation,
  PublishRequest,
  PublishSequenceRequest,
  RetryBudget,
  RetryDisposition,
} from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { isJsonArray } from "../transport/validation.js";
import {
  commentAt,
  connectedAccountAt,
  conversationAt,
  deliveryAt,
  messageTextAt,
  objectAt,
  optionalBooleanAt,
  optionalPositiveIntegerAt,
  optionalTextAt,
  optionalTextListAt,
  platformPostAt,
  removableAt,
  textAt,
  textListAt,
  toolArguments,
  ToolInputError,
  type RemovableRef,
} from "./decode.js";
import {
  backendPostSchema,
  commentSchema,
  confirmWriteSchema,
  connectedAccountSchema,
  conversationSchema,
  cursorSchema,
  deliverySchema,
  limitSchema,
  messageTextSchema,
  objectSchema,
  platformPostSchema,
  publishRequestSchema,
  publishSequenceSchema,
  scheduledJobSchema,
} from "./schemas.js";

/** Built-in tool names, in the order the registry lists them. */
export const socialToolNames = [
  "social_capabilities",
  "social_doctor",
  "social_validate",
  "social_plan_publish",
  "social_list_accounts",
  "social_get_account",
  "social_list_posts",
  "social_get_post",
  "social_search_posts",
  "social_get_delivery",
  "social_publish",
  "social_publish_sequence",
  "social_delete_post",
  "social_post_metrics",
  "social_account_metrics",
  "social_analytics_report",
  "social_list_comments",
  "social_reply_comment",
  "social_list_conversations",
  "social_list_messages",
  "social_send_message",
  "social_list_notifications",
] as const;

export type BuiltInSocialToolName = (typeof socialToolNames)[number];

/** Native actions register as `social_native_<name>` tools. */
export type SocialToolName = BuiltInSocialToolName | `social_native_${string}`;

/**
 * `local` tools read configuration and run local validation only. `read` and
 * `write` tools reach the configured backend through the client facade.
 */
export type SocialToolAccess = "local" | "read" | "write";

/**
 * `confirm` (default) previews every write until the call sets `confirmWrite: true`.
 * `preview` never executes writes. `allow` executes writes without confirmation;
 * use it only when your application has its own approval step.
 */
export type SocialWriteMode = "confirm" | "preview" | "allow";

export type SocialToolAnnotations = {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
};

export type SocialToolDefinition = {
  readonly name: SocialToolName;
  readonly title: string;
  readonly description: string;
  /** JSON Schema for the tool arguments. Always an object schema. */
  readonly inputSchema: JsonObject;
  readonly annotations: SocialToolAnnotations;
  readonly access: SocialToolAccess;
  /** Declared operations that enable this tool. Empty for local and native tools. */
  readonly operations: readonly OperationName[];
};

export type SocialToolIssue = {
  readonly code: string;
  readonly message: string;
  readonly severity: "error" | "warning";
  readonly targetIndex?: number;
  readonly path?: string;
};

export type SocialToolError = {
  readonly code: SocialErrorCode;
  readonly message: string;
  readonly operation?: string;
  readonly retryDisposition?: RetryDisposition;
  readonly issues?: readonly SocialToolIssue[];
  readonly correlationId?: string;
  readonly upstreamStatus?: number;
};

/** Every call resolves to one of these; tool calls never throw. */
export type SocialToolResult =
  | {
      readonly ok: true;
      readonly tool: SocialToolName;
      readonly status: "completed";
      readonly data: JsonValue;
    }
  | {
      readonly ok: true;
      readonly tool: SocialToolName;
      readonly status: "dry-run";
      readonly data: JsonValue;
      /** What the agent must do before anything is sent. */
      readonly confirmation: string;
    }
  | { readonly ok: false; readonly tool: string; readonly error: SocialToolError };

export interface NativeToolInput {
  readonly account: ConnectedAccountRef;
  /** Arguments as sent by the agent. Validate them before use. */
  readonly args: JsonObject;
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  readonly authorization?: AuthorizationContext;
}

/**
 * A provider-native call exposed as an agent tool. The toolkit authorizes the
 * account with your policy (operation `native`), applies write confirmation and
 * a per-backend concurrency limit, then calls `run`.
 */
export interface NativeToolAction {
  /** Lowercase letters, digits and underscores; the tool is `social_native_<name>`. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /** Backend instance key whose accounts this action accepts. */
  readonly backend: string;
  readonly access: "read" | "write";
  /** JSON Schema for `args`. Defaults to any object. */
  readonly argsSchema?: JsonObject;
  run(input: NativeToolInput): Promise<JsonValue>;
}

/** Identity helper that keeps a native action's literal types. */
export function defineNativeTool<const Action extends NativeToolAction>(action: Action): Action {
  return action;
}

export type SocialDoctorCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export interface SocialToolkitOptions {
  readonly writes?: SocialWriteMode;
  /** Default authorization context. A per-call context replaces it. */
  readonly authorization?: AuthorizationContext;
  /**
   * The same policy you passed to `createSocial`. Plans and write previews
   * report its decisions, and native tools require it.
   */
  readonly policy?: AuthorizationPolicy;
  /** Expose only these tools. Tools the backends do not declare stay hidden either way. */
  readonly tools?: readonly SocialToolName[];
  /**
   * The cap on any `limit` an agent requests. Default 50. When an agent omits `limit`,
   * the toolkit asks for 20, or this cap when it is smaller.
   */
  readonly maxPageSize?: number;
  /** Per-toolkit budgets. Exhausted budgets fail with `rate_limited`. */
  readonly limits?: { readonly maxCalls?: number; readonly maxWrites?: number };
  readonly retryBudget?: RetryBudget;
  readonly nativeTools?: readonly NativeToolAction[];
  /** Concurrent native calls per backend. Default 4. */
  readonly nativeConcurrency?: number;
  /** Extra application checks reported by `social_doctor`. Never return secret values. */
  readonly checks?: () => readonly SocialDoctorCheck[];
}

export interface SocialToolCallOptions {
  readonly authorization?: AuthorizationContext;
  readonly signal?: AbortSignal;
}

export interface SocialToolkit {
  readonly tools: readonly SocialToolDefinition[];
  /** Run a tool with JSON arguments. Never throws; failures resolve to `ok: false`. */
  call(
    name: string,
    args: JsonValue | undefined,
    options?: SocialToolCallOptions,
  ): Promise<SocialToolResult>;
}

type ToolOutcome =
  | { readonly status: "completed"; readonly data: JsonValue }
  | { readonly status: "dry-run"; readonly data: JsonValue; readonly confirmation: string };

interface ToolRun {
  readonly args: JsonObject;
  readonly options: PublishCallOptions;
  readonly correlationId: string;
}

interface ToolSpec {
  readonly definition: SocialToolDefinition;
  run(input: ToolRun): Promise<ToolOutcome>;
}

type AuthorizationState = "allowed" | "denied" | "not-checked";

/** Serialize an SDK result into plain JSON, dropping `undefined` fields. */
export function toJsonValue<Value>(value: Value): JsonValue {
  const text = JSON.stringify(value);

  if (text === undefined) return null;
  const parsed: unknown = JSON.parse(text);

  if (!isJsonValue(parsed)) throw new TypeError("Tool results must serialize to JSON");

  return parsed;
}

function accountJson(account: ConnectedAccountRef): JsonObject {
  return {
    kind: account.kind,
    version: account.version,
    backend: account.backend,
    platform: account.platform,
    accountId: account.accountId,
  };
}

function accountOf(ref: {
  readonly backend: string;
  readonly platform: string;
  readonly accountId: string;
}): ConnectedAccountRef {
  return {
    kind: "connected-account",
    version: 1,
    backend: ref.backend,
    platform: ref.platform,
    accountId: ref.accountId,
  };
}

function accountKey(account: ConnectedAccountRef): string {
  return JSON.stringify([account.backend, account.platform, account.accountId]);
}

function issueJson(issue: PreparationIssue): SocialToolIssue {
  return {
    code: issue.code,
    message: issue.message,
    severity: issue.severity,
    ...definedFields({ targetIndex: issue.targetIndex, path: issue.path }),
  };
}

/** Describes prepared content without echoing post text, URLs or media sources. */
function contentJson(target: PreparedPublishTarget): JsonObject {
  return {
    textLength: target.content.text?.length ?? 0,
    mediaCount: target.content.media?.length ?? 0,
    hasLink: target.content.link !== undefined,
    scheduledAt: target.schedule?.at ?? null,
    isReply: target.replyTo !== undefined,
  };
}

function preparationJson(preparation: PublishPreparation): JsonObject {
  return {
    ok: preparation.ok,
    targets: preparation.targets.map((target) => ({
      targetIndex: target.targetIndex,
      account: accountJson(target.account),
      ...contentJson(target),
    })),
    issues: preparation.issues.map(issueJson),
  };
}

function capabilityJson(declaration: CapabilityDeclaration | undefined): JsonObject {
  if (declaration === undefined) return { availability: "undeclared" };

  return {
    operation: declaration.operation,
    availability: declaration.availability,
    ...definedFields({
      surface: declaration.surface,
      formats: declaration.formats,
      notes: declaration.notes,
      constraints:
        declaration.constraints === undefined ? undefined : toJsonValue(declaration.constraints),
    }),
  };
}

function toolError<Failure>(error: Failure): SocialToolError {
  if (error instanceof SocialError)
    return {
      code: error.code,
      message: error.message,
      operation: error.operation,
      retryDisposition: error.retryDisposition,
      ...definedFields({
        issues: error.issues?.map(issueJson),
        correlationId: error.correlationId,
        upstreamStatus: error.upstreamStatus,
      }),
    };

  // Decoder messages name a path or rule and never repeat submitted values.
  if (error instanceof ToolInputError || error instanceof PublishRequestInputError)
    return { code: "invalid_input", message: error.message };

  return {
    code: "upstream_failure",
    message: "The tool failed before returning a result. Check server logs for details.",
  };
}

function budgetExhausted(operation: string, message: string): SocialError {
  return new SocialError({
    code: "rate_limited",
    operation,
    message,
    retryDisposition: { kind: "never" },
  });
}

const nativeNamePattern = /^[a-z][a-z0-9_]{0,47}$/;

function invalidConfig(message: string): SocialError {
  return new SocialError({ code: "invalid_config", operation: "createSocialToolkit", message });
}

/**
 * Build agent tools over a configured client. The registry lists only tools
 * whose operations at least one backend declares `available`, so agents never
 * see a tool the configuration cannot run. Every backend call goes through the
 * client facade, which applies its authorization policy, capability checks and
 * concurrency limits.
 */
export function createSocialToolkit(
  social: SocialClient,
  options: SocialToolkitOptions = {},
): SocialToolkit {
  const writes = options.writes ?? "confirm";
  const maxPageSize = options.maxPageSize ?? 50;

  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 1000)
    throw invalidConfig("maxPageSize must be an integer from 1 through 1000");

  // Adapter defaults reach 100, above the cap, so an omitted limit is set explicitly. 20
  // is a size every built-in list operation accepts: TikTok allows at most 20, and some X
  // searches need at least 10.
  const defaultPageSize = Math.min(20, maxPageSize);

  for (const [name, value] of Object.entries(options.limits ?? {}))
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw invalidConfig(`limits.${name} must be a nonnegative integer`);

  const manifests = new Map<string, CapabilityManifest>(Object.entries(social.capabilities()));
  const available = new Set<string>();

  for (const manifest of manifests.values())
    for (const declaration of manifest.capabilities)
      if (declaration.availability === "available") available.add(declaration.operation);

  const nativeTools = options.nativeTools ?? [];

  if (nativeTools.length > 0 && options.policy === undefined)
    throw invalidConfig("Native tools require the authorization policy given to createSocial");
  const nativeNames = new Set<string>();

  for (const action of nativeTools) {
    if (!nativeNamePattern.test(action.name) || nativeNames.has(action.name))
      throw invalidConfig(
        "Native tool names must be unique lowercase identifiers of up to 48 characters",
      );

    if (!manifests.has(action.backend))
      throw invalidConfig(`Native tool ${action.name} names an unknown backend`);
    nativeNames.add(action.name);
  }

  const nativeConcurrency = options.nativeConcurrency ?? 4;

  if (!Number.isSafeInteger(nativeConcurrency) || nativeConcurrency < 1 || nativeConcurrency > 100)
    throw invalidConfig("nativeConcurrency must be an integer from 1 through 100");

  const nativeLimiters = new Map(
    [...manifests.keys()].map((backend) => [
      backend,
      createConcurrencyLimiter({ maxActive: nativeConcurrency, maxQueued: 100, backend }),
    ]),
  );

  let callCount = 0;
  let writeCount = 0;

  function declarationFor(
    backend: string,
    operations: readonly OperationName[],
    platform: string,
  ): CapabilityDeclaration | undefined {
    const manifest = manifests.get(backend);

    if (manifest === undefined) return undefined;

    for (const operation of operations) {
      const found = manifest.capabilities.find(
        (candidate) =>
          candidate.operation === operation &&
          (candidate.platform === "*" || candidate.platform === platform),
      );

      if (found !== undefined) return found;
    }

    return undefined;
  }

  async function authorize(
    operation: OperationName,
    accounts: readonly ConnectedAccountRef[],
    run: ToolRun,
  ): Promise<readonly AuthorizationState[]> {
    if (options.policy === undefined) return accounts.map(() => "not-checked");

    const context: AdapterOperationContext = {
      backendInstance: "*",
      correlationId: run.correlationId,
      retryBudget: run.options.retryBudget ?? { maxAttempts: 1, maxElapsedMs: 30_000 },
      ...definedFields({
        authorization: run.options.authorization,
        signal: run.options.signal,
      }),
    };

    const decisions = await options.policy.authorizeTargets({ operation, accounts, context });

    const allowed = new Set(
      decisions.filter((item) => item.allowed).map((item) => accountKey(item.account)),
    );

    return accounts.map((account) => (allowed.has(accountKey(account)) ? "allowed" : "denied"));
  }

  function shouldExecute(confirmWrite: boolean | undefined): boolean {
    return writes === "allow" || (writes === "confirm" && confirmWrite === true);
  }

  function dryRun(data: JsonObject): ToolOutcome {
    return {
      status: "dry-run",
      data: { ...data, writes },
      confirmation:
        writes === "preview"
          ? "Nothing was sent. This toolkit only previews writes."
          : "Nothing was sent. Show this preview to the user and call again with confirmWrite: true only after they approve it.",
    };
  }

  async function executeWrite<Result>(
    operation: string,
    work: () => Promise<Result>,
  ): Promise<Result> {
    const maxWrites = options.limits?.maxWrites;

    if (maxWrites !== undefined && writeCount >= maxWrites)
      throw budgetExhausted(operation, "The toolkit write budget is exhausted");
    writeCount += 1;

    return work();
  }

  function completed(data: JsonValue): ToolOutcome {
    return { status: "completed", data };
  }

  function pageOptions(args: JsonObject, run: ToolRun) {
    const limit = optionalPositiveIntegerAt(args["limit"], "limit");

    return {
      ...run.options,
      ...definedFields({
        cursor: optionalTextAt(args["cursor"], "cursor"),
        limit: limit === undefined ? defaultPageSize : Math.min(limit, maxPageSize),
      }),
    };
  }

  function confirmWrite(args: JsonObject): boolean | undefined {
    return optionalBooleanAt(args["confirmWrite"], "confirmWrite");
  }

  function publishRequestAt(args: JsonObject): PublishRequest {
    return decodePublishRequestValue(objectAt(args["request"], "request"));
  }

  function sequenceAt(args: JsonObject): PublishSequenceRequest {
    const input = objectAt(args["request"], "request");
    const items = input["items"];

    if (!isJsonArray(items) || items.length === 0)
      throw new ToolInputError("Invalid tool input: request.items must be a nonempty array.");

    return {
      items: items.map((value, index) => {
        const path = `request.items[${index}]`;
        const item = objectAt(value, path);
        const targets = item["targets"];
        const replyTo = item["replyTo"];

        if (!isJsonArray(targets))
          throw new ToolInputError(`Invalid tool input: ${path}.targets must be an array.`);

        return {
          targets: targets.map((target, targetIndex) =>
            decodePublishTarget(target, `${path}.targets[${targetIndex}]`),
          ),
          content: decodePublishContent(item["content"], `${path}.content`),
          ...definedFields({
            replyTo:
              replyTo === undefined ? undefined : decodeReplyReference(replyTo, `${path}.replyTo`),
          }),
        };
      }),
      idempotencyKey: textAt(input["idempotencyKey"], "request.idempotencyKey"),
      ...definedFields({
        stopOnFailure: optionalBooleanAt(input["stopOnFailure"], "request.stopOnFailure"),
        replyToPrevious: optionalBooleanAt(input["replyToPrevious"], "request.replyToPrevious"),
      }),
    };
  }

  /** Mirrors `publishSequence` preflight, including each chained target's placeholder parent. */
  function prepareSequence(request: PublishSequenceRequest): readonly PublishPreparation[] {
    return request.items.map((item, index) =>
      social.posts.prepare(
        request.replyToPrevious === true && index > 0
          ? { targets: withPreflightParents(item.targets), content: item.content }
          : {
              targets: item.targets,
              content: item.content,
              ...definedFields({ replyTo: item.replyTo }),
            },
      ),
    );
  }

  async function writePreview(
    operation: OperationName,
    account: ConnectedAccountRef,
    run: ToolRun,
    details: JsonObject,
  ): Promise<ToolOutcome> {
    const [authorization] = await authorize(operation, [account], run);

    return dryRun({
      operation,
      account: accountJson(account),
      capability: capabilityJson(declarationFor(account.backend, [operation], account.platform)),
      authorization: authorization ?? "not-checked",
      ...details,
    });
  }

  function define(input: {
    readonly name: SocialToolName;
    readonly title: string;
    readonly description: string;
    readonly access: SocialToolAccess;
    readonly operations?: readonly OperationName[];
    readonly properties?: { readonly [name: string]: JsonObject };
    readonly required?: readonly string[];
    readonly destructive?: boolean;
  }): SocialToolDefinition {
    const write = input.access === "write";

    const properties =
      write && input.properties !== undefined
        ? { ...input.properties, confirmWrite: confirmWriteSchema }
        : (input.properties ?? {});

    return {
      name: input.name,
      title: input.title,
      description: input.description,
      inputSchema: objectSchema(properties, input.required),
      access: input.access,
      operations: input.operations ?? [],
      annotations: {
        title: input.title,
        readOnlyHint: !write,
        destructiveHint: input.destructive === true,
        idempotentHint: !write,
        openWorldHint: input.access !== "local",
      },
    };
  }

  const pageProperties = { cursor: cursorSchema, limit: limitSchema };

  const outcomeGuidance =
    "Per-target outcomes are authoritative: scheduled, accepted, processing and unknown are not published. Reconcile unknown outcomes with social_get_delivery before retrying.";

  const specs: readonly ToolSpec[] = [
    {
      definition: define({
        name: "social_capabilities",
        title: "List capabilities",
        description:
          "List the operations each configured backend declares, with availability, formats, scopes and constraints. Call this before planning work. It makes no provider request.",
        access: "local",
        properties: {
          backend: { type: "string" },
          platform: { type: "string" },
          operation: { type: "string" },
          availableOnly: { type: "boolean" },
        },
      }),
      async run({ args }) {
        const backend = optionalTextAt(args["backend"], "backend");
        const platform = optionalTextAt(args["platform"], "platform");
        const operation = optionalTextAt(args["operation"], "operation");
        const availableOnly = optionalBooleanAt(args["availableOnly"], "availableOnly") === true;

        const backends = [...manifests].flatMap(([key, manifest]) =>
          backend !== undefined && key !== backend
            ? []
            : {
                backend: key,
                adapter: manifest.backend,
                apiRevision: manifest.apiRevision,
                runtime: manifest.runtime,
                capabilities: toJsonValue(
                  manifest.capabilities.filter(
                    (declaration) =>
                      (platform === undefined ||
                        declaration.platform === "*" ||
                        declaration.platform === platform) &&
                      (operation === undefined || declaration.operation === operation) &&
                      (!availableOnly || declaration.availability === "available"),
                  ),
                ),
              },
        );

        return completed({
          backends,
          verification:
            "Declared adapter capabilities. Account permissions, platform approval and live behavior are not checked.",
        });
      },
    },
    {
      definition: define({
        name: "social_doctor",
        title: "Check toolkit configuration",
        description:
          "Report configured backends, the write policy, enabled tools and budgets. It makes no provider request and prints no credential values.",
        access: "local",
      }),
      async run() {
        const checks = options.checks?.() ?? [];

        return completed({
          backends: [...manifests].map(([key, manifest]) => ({
            backend: key,
            adapter: manifest.backend,
            apiRevision: manifest.apiRevision,
            availableOperations: manifest.capabilities.filter(
              (declaration) => declaration.availability === "available",
            ).length,
            declaredOperations: manifest.capabilities.length,
          })),
          writes,
          authorizationContext: options.authorization !== undefined,
          authorizationPolicy: options.policy !== undefined,
          tools: registry.map((spec) => spec.definition.name),
          maxPageSize,
          limits: {
            maxCalls: options.limits?.maxCalls ?? null,
            maxWrites: options.limits?.maxWrites ?? null,
            callsUsed: callCount,
            writesUsed: writeCount,
          },
          checks: checks.map((check) => ({
            name: check.name,
            ok: check.ok,
            detail: check.detail,
          })),
          ok: checks.every((check) => check.ok),
          verification:
            "Configuration and declared capabilities only. Credentials, scopes and provider reachability were not checked.",
        });
      },
    },
    {
      definition: define({
        name: "social_validate",
        title: "Validate a publish request",
        description:
          "Validate a publish request locally against each target's adapter rules. Returns issue codes and messages. Nothing is sent.",
        access: "local",
        properties: { request: publishRequestSchema },
        required: ["request"],
      }),
      async run({ args }) {
        const preparation = social.posts.prepare(publishRequestAt(args));

        return completed({
          ok: preparation.ok,
          targetCount: preparation.targets.length,
          issues: preparation.issues.map(issueJson),
        });
      },
    },
    {
      definition: define({
        name: "social_plan_publish",
        title: "Plan a publish",
        description:
          "Dry-run a publish request: validation issues, the capability each target relies on, tenant authorization when a policy is configured, and whether execution needs confirmation. Nothing is sent.",
        access: "local",
        properties: { request: publishRequestSchema },
        required: ["request"],
      }),
      async run(run) {
        const request = publishRequestAt(run.args);
        const preparation = social.posts.prepare(request);
        const operation = request.schedule === undefined ? "posts.publish" : "posts.schedule";

        const decisions = await authorize(
          operation,
          request.targets.map((target) => target.account),
          run,
        );

        const prepared = new Map(
          preparation.targets.map((target) => [target.targetIndex, contentJson(target)]),
        );

        return completed({
          ok: preparation.ok,
          operation,
          writes,
          requiresConfirmation: writes === "confirm",
          executable: writes !== "preview" && preparation.ok && !decisions.includes("denied"),
          targets: request.targets.map((target, targetIndex) => ({
            targetIndex,
            account: accountJson(target.account),
            content: prepared.get(targetIndex) ?? null,
            capability: capabilityJson(
              declarationFor(target.account.backend, ["posts.publish"], target.account.platform),
            ),
            ...definedFields({
              schedule:
                operation === "posts.schedule"
                  ? capabilityJson(
                      declarationFor(
                        target.account.backend,
                        ["posts.schedule"],
                        target.account.platform,
                      ),
                    )
                  : undefined,
            }),
            authorization: decisions[targetIndex] ?? "not-checked",
          })),
          issues: preparation.issues.map(issueJson),
        });
      },
    },
    {
      definition: define({
        name: "social_list_accounts",
        title: "List connected accounts",
        description:
          "List connected accounts the caller may use. Pass backend when several backends are configured. Use the returned ref objects as account arguments.",
        access: "read",
        operations: ["accounts.read"],
        properties: { backend: { type: "string" }, ...pageProperties },
      }),
      async run(run) {
        const page = await social.accounts.list({
          ...pageOptions(run.args, run),
          ...definedFields({ backend: optionalTextAt(run.args["backend"], "backend") }),
        });

        return completed(toJsonValue(page));
      },
    },
    {
      definition: define({
        name: "social_get_account",
        title: "Get a connected account",
        description: "Read one connected account and its connection status.",
        access: "read",
        operations: ["accounts.read"],
        properties: { account: connectedAccountSchema },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        return completed(toJsonValue(await social.accounts.get(account, run.options)));
      },
    },
    {
      definition: define({
        name: "social_list_posts",
        title: "List posts",
        description: "List recent posts for a connected account. Payloads stay provider-shaped.",
        access: "read",
        operations: ["posts.list"],
        properties: { account: connectedAccountSchema, ...pageProperties },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        return completed(toJsonValue(await social.posts.list(account, pageOptions(run.args, run))));
      },
    },
    {
      definition: define({
        name: "social_get_post",
        title: "Get a post",
        description: "Read one platform post by its reference.",
        access: "read",
        operations: ["posts.get", "posts.read"],
        properties: { post: platformPostSchema },
        required: ["post"],
      }),
      async run(run) {
        const post = platformPostAt(run.args["post"], "post");

        return completed(toJsonValue(await social.posts.get(post, run.options)));
      },
    },
    {
      definition: define({
        name: "social_search_posts",
        title: "Search posts",
        description:
          "Search posts through a connected account. Provider query syntax applies; scope selects recent or full-archive search where supported.",
        access: "read",
        operations: ["search.posts"],
        properties: {
          account: connectedAccountSchema,
          query: { type: "string", minLength: 1 },
          startTime: { type: "string" },
          endTime: { type: "string" },
          scope: { type: "string", enum: ["recent", "all"] },
          ...pageProperties,
        },
        required: ["account", "query"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");
        const scope = run.args["scope"];

        if (scope !== undefined && scope !== "recent" && scope !== "all")
          throw new ToolInputError('Invalid tool input: scope must be "recent" or "all".');
        const page = pageOptions(run.args, run);

        return completed(
          toJsonValue(
            await social.search.posts(
              account,
              {
                query: textAt(run.args["query"], "query"),
                ...definedFields({
                  cursor: page.cursor,
                  limit: page.limit,
                  startTime: optionalTextAt(run.args["startTime"], "startTime"),
                  endTime: optionalTextAt(run.args["endTime"], "endTime"),
                  scope,
                }),
              },
              run.options,
            ),
          ),
        );
      },
    },
    {
      definition: define({
        name: "social_get_delivery",
        title: "Reconcile a delivery",
        description:
          "Read the current state of one delivery from a publish outcome. Use it to reconcile accepted, processing or unknown outcomes before any retry.",
        access: "read",
        operations: ["posts.getDelivery", "posts.status"],
        properties: { delivery: deliverySchema },
        required: ["delivery"],
      }),
      async run(run) {
        const delivery = deliveryAt(run.args["delivery"], "delivery");

        return completed(toJsonValue(await social.posts.getDelivery(delivery, run.options)));
      },
    },
    {
      definition: define({
        name: "social_publish",
        title: "Publish or schedule a post",
        description: `Publish or schedule a post to one or more connected accounts. Without confirmWrite: true this returns a dry-run preview and sends nothing. Executing requires an idempotencyKey; reuse it when retrying the same post. ${outcomeGuidance}`,
        access: "write",
        operations: ["posts.publish"],
        properties: { request: publishRequestSchema },
        required: ["request"],
      }),
      async run(run) {
        const request = publishRequestAt(run.args);
        const operation = request.schedule === undefined ? "posts.publish" : "posts.schedule";

        if (!shouldExecute(confirmWrite(run.args))) {
          const decisions = await authorize(
            operation,
            request.targets.map((target) => target.account),
            run,
          );

          return dryRun({
            operation,
            preparation: preparationJson(social.posts.prepare(request)),
            authorization: [...decisions],
            idempotencyKey: request.idempotencyKey !== undefined,
          });
        }

        if (request.idempotencyKey === undefined)
          throw new ToolInputError(
            "Invalid tool input: request.idempotencyKey must be set before executing a publish.",
          );

        return completed(
          toJsonValue(
            await executeWrite(operation, () => social.posts.publish(request, run.options)),
          ),
        );
      },
    },
    {
      definition: define({
        name: "social_publish_sequence",
        title: "Publish a sequence",
        description: `Publish ordered items such as a thread, optionally replying each item to the previous one. Without confirmWrite: true this returns a dry-run preview and sends nothing. ${outcomeGuidance}`,
        access: "write",
        operations: ["posts.publish"],
        properties: { request: publishSequenceSchema },
        required: ["request"],
      }),
      async run(run) {
        const request = sequenceAt(run.args);

        if (!shouldExecute(confirmWrite(run.args))) {
          const accounts = request.items.flatMap((item) =>
            item.targets.map((target) => target.account),
          );

          const decisions = await authorize("posts.publish", accounts, run);

          return dryRun({
            operation: "posts.publishSequence",
            items: prepareSequence(request).map(preparationJson),
            authorization: [...decisions],
          });
        }

        return completed(
          toJsonValue(
            await executeWrite("posts.publishSequence", () =>
              social.posts.publishSequence(request, run.options),
            ),
          ),
        );
      },
    },
    {
      definition: define({
        name: "social_delete_post",
        title: "Delete a post or cancel a schedule",
        description:
          "Remove a platform post (platform-post ref), delete a managed backend record (backend-post ref) or cancel a scheduled job (scheduled-job ref). Without confirmWrite: true this returns a dry-run preview and sends nothing.",
        access: "write",
        destructive: true,
        operations: [
          "posts.removeFromPlatform",
          "posts.deleteBackendRecord",
          "posts.cancelScheduled",
        ],
        properties: {
          ref: { anyOf: [platformPostSchema, backendPostSchema, scheduledJobSchema] },
        },
        required: ["ref"],
      }),
      async run(run) {
        const ref = removableAt(run.args["ref"], "ref");
        const operation = removalOperation(ref);

        if (!shouldExecute(confirmWrite(run.args)))
          return writePreview(operation, accountOf(ref), run, {
            target: toJsonValue(ref),
          });

        return completed(
          await executeWrite(operation, async () => {
            switch (ref.kind) {
              case "platform-post":
                await social.posts.removeFromPlatform(ref, run.options);

                return { operation, removed: true };
              case "backend-post":
                await social.posts.deleteBackendRecord(ref, run.options);

                return { operation, deleted: true };
              case "scheduled-job":
                return {
                  operation,
                  cancellation: toJsonValue(await social.posts.cancelScheduled(ref, run.options)),
                };
            }
          }),
        );
      },
    },
    {
      definition: define({
        name: "social_post_metrics",
        title: "Get post metrics",
        description:
          "Read metrics for one platform post. Each value names its period, unit and source.",
        access: "read",
        operations: ["analytics.read"],
        properties: { post: platformPostSchema },
        required: ["post"],
      }),
      async run(run) {
        const post = platformPostAt(run.args["post"], "post");

        return completed(
          toJsonValue({ metrics: await social.analytics.getPostMetrics(post, run.options) }),
        );
      },
    },
    {
      definition: define({
        name: "social_account_metrics",
        title: "Get account metrics",
        description: "Read account-level metrics such as follower counts.",
        access: "read",
        operations: ["analytics.account.read"],
        properties: { account: connectedAccountSchema },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        return completed(
          toJsonValue({ metrics: await social.analytics.getAccountMetrics(account, run.options) }),
        );
      },
    },
    {
      definition: define({
        name: "social_analytics_report",
        title: "Get an analytics report",
        description:
          "Read a bounded account report for a YYYY-MM-DD date range. Providers may expose fewer metrics or dimensions; check social_capabilities first.",
        access: "read",
        operations: ["analytics.report.read"],
        properties: {
          account: connectedAccountSchema,
          from: { type: "string", description: "Start date, YYYY-MM-DD." },
          to: { type: "string", description: "End date, YYYY-MM-DD." },
          metrics: { type: "array", minItems: 1, items: { type: "string" } },
          dimensions: { type: "array", items: { type: "string" } },
        },
        required: ["account", "from", "to", "metrics"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        const report = await social.analytics.getReport(
          account,
          {
            from: textAt(run.args["from"], "from"),
            to: textAt(run.args["to"], "to"),
            metrics: textListAt(run.args["metrics"], "metrics"),
            ...definedFields({
              dimensions: optionalTextListAt(run.args["dimensions"], "dimensions"),
            }),
          },
          run.options,
        );

        return completed(toJsonValue(report));
      },
    },
    {
      definition: define({
        name: "social_list_comments",
        title: "List comments",
        description: "List comments on a platform post. Use returned comment refs to reply.",
        access: "read",
        operations: ["comments.read"],
        properties: { post: platformPostSchema, ...pageProperties },
        required: ["post"],
      }),
      async run(run) {
        const post = platformPostAt(run.args["post"], "post");

        return completed(toJsonValue(await social.comments.list(post, pageOptions(run.args, run))));
      },
    },
    {
      definition: define({
        name: "social_reply_comment",
        title: "Reply to a comment",
        description:
          "Reply to a comment as the connected account. Without confirmWrite: true this returns a dry-run preview and sends nothing.",
        access: "write",
        operations: ["comments.write"],
        properties: { comment: commentSchema, text: messageTextSchema },
        required: ["comment", "text"],
      }),
      async run(run) {
        const comment = commentAt(run.args["comment"], "comment");
        const text = messageTextAt(run.args["text"], "text");

        if (!shouldExecute(confirmWrite(run.args)))
          return writePreview("comments.write", accountOf(comment), run, {
            target: toJsonValue(comment),
            textLength: text.length,
          });

        return completed(
          toJsonValue(
            await executeWrite("comments.write", () =>
              social.comments.reply(comment, { text }, run.options),
            ),
          ),
        );
      },
    },
    {
      definition: define({
        name: "social_list_conversations",
        title: "List conversations",
        description: "List direct-message conversations for a connected account.",
        access: "read",
        operations: ["messages.read"],
        properties: { account: connectedAccountSchema, ...pageProperties },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        return completed(
          toJsonValue(await social.messages.listConversations(account, pageOptions(run.args, run))),
        );
      },
    },
    {
      definition: define({
        name: "social_list_messages",
        title: "List messages",
        description: "List messages in one conversation.",
        access: "read",
        operations: ["messages.read"],
        properties: { conversation: conversationSchema, ...pageProperties },
        required: ["conversation"],
      }),
      async run(run) {
        const conversation = conversationAt(run.args["conversation"], "conversation");

        return completed(
          toJsonValue(await social.messages.listMessages(conversation, pageOptions(run.args, run))),
        );
      },
    },
    {
      definition: define({
        name: "social_send_message",
        title: "Send a direct message",
        description:
          "Send a direct message in an existing conversation. Without confirmWrite: true this returns a dry-run preview and sends nothing.",
        access: "write",
        operations: ["messages.write"],
        properties: { conversation: conversationSchema, text: messageTextSchema },
        required: ["conversation", "text"],
      }),
      async run(run) {
        const conversation = conversationAt(run.args["conversation"], "conversation");
        const text = messageTextAt(run.args["text"], "text");

        if (!shouldExecute(confirmWrite(run.args)))
          return writePreview("messages.write", accountOf(conversation), run, {
            target: toJsonValue(conversation),
            textLength: text.length,
          });

        return completed(
          toJsonValue(
            await executeWrite("messages.write", () =>
              social.messages.send(conversation, { text }, run.options),
            ),
          ),
        );
      },
    },
    {
      definition: define({
        name: "social_list_notifications",
        title: "List notifications",
        description: "List account notifications such as mentions, replies and follows.",
        access: "read",
        operations: ["notifications.read"],
        properties: { account: connectedAccountSchema, ...pageProperties },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");

        return completed(
          toJsonValue(await social.notifications.list(account, pageOptions(run.args, run))),
        );
      },
    },
    ...nativeTools.map((action) => nativeSpec(action)),
  ];

  function nativeSpec(action: NativeToolAction): ToolSpec {
    const name: SocialToolName = `social_native_${action.name}`;
    const limiter = nativeLimiters.get(action.backend);

    return {
      definition: define({
        name,
        title: action.title ?? `Native ${action.name}`,
        description: `${action.description} Native ${action.access} on backend ${action.backend}; the account must belong to that backend.${action.access === "write" ? " Without confirmWrite: true this returns a dry-run preview and sends nothing." : ""}`,
        access: action.access,
        properties: {
          account: connectedAccountSchema,
          args: action.argsSchema ?? { type: "object" },
        },
        required: ["account"],
      }),
      async run(run) {
        const account = connectedAccountAt(run.args["account"], "account");
        const rawArgs = run.args["args"];
        const args = rawArgs === undefined ? {} : objectAt(rawArgs, "args");

        if (account.backend !== action.backend)
          throw new ToolInputError(
            `Invalid tool input: account.backend must be "${action.backend}" for this action.`,
          );

        const [decision] = await authorize("native", [account], run);

        if (decision !== "allowed")
          throw new SocialError({
            code: "unauthorized",
            operation: "native",
            message: "The account is not authorized for native access",
            correlationId: run.correlationId,
          });

        if (action.access === "write" && !shouldExecute(confirmWrite(run.args)))
          return dryRun({
            operation: "native",
            action: action.name,
            account: accountJson(account),
            authorization: decision,
          });

        if (limiter === undefined) throw invalidConfig("Native tool backend has no limiter");

        const invoke = () =>
          limiter(run.options.signal, "native", () =>
            action.run({
              account,
              args,
              correlationId: run.correlationId,
              ...definedFields({
                signal: run.options.signal,
                authorization: run.options.authorization,
              }),
            }),
          );

        const result =
          action.access === "write" ? await executeWrite("native", invoke) : await invoke();

        return completed(toJsonValue(result));
      },
    };
  }

  const allowlist = options.tools === undefined ? undefined : new Set<string>(options.tools);

  const registry = specs.filter(
    (spec) =>
      (allowlist === undefined || allowlist.has(spec.definition.name)) &&
      (spec.definition.operations.length === 0 ||
        spec.definition.operations.some((operation) => available.has(operation))),
  );

  const byName = new Map<string, ToolSpec>(registry.map((spec) => [spec.definition.name, spec]));

  return {
    tools: registry.map((spec) => spec.definition),
    async call(name, rawArgs, callOptions = {}) {
      const spec = byName.get(name);

      if (spec === undefined)
        return {
          ok: false,
          tool: name,
          error: { code: "invalid_input", message: "Unknown or disabled tool." },
        };

      const maxCalls = options.limits?.maxCalls;

      if (maxCalls !== undefined && callCount >= maxCalls)
        return {
          ok: false,
          tool: name,
          error: toolError(budgetExhausted(name, "The toolkit call budget is exhausted")),
        };
      callCount += 1;

      const authorization = callOptions.authorization ?? options.authorization;

      try {
        const outcome = await spec.run({
          args: toolArguments(rawArgs),
          correlationId: `social-tool-${callCount}`,
          options: definedFields({
            authorization,
            signal: callOptions.signal,
            retryBudget: options.retryBudget,
          }),
        });

        return outcome.status === "completed"
          ? { ok: true, tool: spec.definition.name, status: "completed", data: outcome.data }
          : {
              ok: true,
              tool: spec.definition.name,
              status: "dry-run",
              data: outcome.data,
              confirmation: outcome.confirmation,
            };
      } catch (error) {
        return { ok: false, tool: spec.definition.name, error: toolError(error) };
      }
    },
  };
}

function removalOperation(
  ref: RemovableRef,
): "posts.removeFromPlatform" | "posts.deleteBackendRecord" | "posts.cancelScheduled" {
  switch (ref.kind) {
    case "platform-post":
      return "posts.removeFromPlatform";
    case "backend-post":
      return "posts.deleteBackendRecord";
    case "scheduled-job":
      return "posts.cancelScheduled";
  }
}
