/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-conditional-empty-object-spread -- this example parses JSON requests and provider events at explicit boundaries. */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createSocial,
  SocialError,
  type DeliveryOutcome,
  type PlatformPostRef,
  type JsonObject,
  type PublishResult,
  type SocialAdapter,
  type SocialClient,
} from "@opencoredev/social-sdk";
import type {
  ConnectionManager,
  ConnectionProvider,
  SocialEvent,
} from "@opencoredev/social-sdk/server";
import {
  mockBackend,
  type MockSocialAdapter,
  type MockScenario,
} from "@opencoredev/social-sdk/testing";
import {
  DrizzleEventInbox,
  DrizzlePublicationStore,
  openExampleDatabase,
  PostgresIdempotencyStore,
  type ExampleDatabase,
} from "./storage.js";

type Stores = {
  readonly idempotency: PostgresIdempotencyStore;
  readonly inbox: DrizzleEventInbox;
  readonly publications: DrizzlePublicationStore;
};

type Session = { readonly principal: string; readonly tenantId: string };

type MembershipSource = (session: Session, accountId: string) => Promise<boolean> | boolean;

export type ExampleOptions = {
  readonly backend?: SocialAdapter<unknown>;
  readonly backendName?: string;
  readonly session?: Session;
  readonly membership?: MembershipSource;
  /** Defaults to a fresh in-memory PGlite database, opened on the first request. */
  readonly database?: ExampleDatabase | Promise<ExampleDatabase>;
  readonly connection?: {
    manager: ConnectionManager;
    provider: ConnectionProvider;
    redirectUri: string;
    platforms: readonly string[];
  };
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
};

export interface ExampleHandler {
  handle(request: Request): Promise<Response>;
  client: SocialClient;
  /** Closes the in-memory database the handler opened itself. A database passed in `options` stays open. */
  close(): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const json = (value: unknown, status = 200) => Response.json(value, { status });

const fail = (message: string, status = 400): never => {
  throw new Response(message, { status });
};

const required = (input: Record<string, unknown>, key: string): string =>
  typeof input[key] === "string" && input[key].length > 0 ? input[key] : fail(`${key} is required`);

async function bytes(request: Request, limit = 1_000_000): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length"));

  if (Number.isFinite(declared) && declared > limit) fail("Request body too large", 413);

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      length += chunk.value.length;

      if (length > limit) fail("Request body too large", 413);
      chunks.push(chunk.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await bytes(request);
  let value: unknown;

  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return fail("Malformed JSON");
  }

  return record(value) ? value : fail("JSON object required");
}

export function createExampleHandler(options: ExampleOptions = {}): ExampleHandler {
  const backendName = options.backendName ?? "default";
  const backend = options.backend ?? mockBackend({ backendInstance: backendName });
  const simulated = backend.id === "mock";
  const session = options.session ?? { principal: "demo-user", tenantId: "demo-tenant" };

  if (!simulated && (!options.session || !options.membership))
    throw new Error("A real backend requires authenticated session and membership handlers");

  const membership =
    options.membership ??
    ((s, id) => s.tenantId === "demo-tenant" && ["mock-account-1", "mock-account-2"].includes(id));

  let owned: Promise<ExampleDatabase> | undefined;
  let opened: Promise<Stores> | undefined;

  function stores(): Promise<Stores> {
    if (opened) return opened;
    const database = options.database ? Promise.resolve(options.database) : openExampleDatabase();

    if (!options.database) owned = database;

    const opening = database.then(
      ({ db }) => ({
        idempotency: new PostgresIdempotencyStore(db),
        inbox: new DrizzleEventInbox(db),
        publications: new DrizzlePublicationStore(db),
      }),
      (error: unknown) => {
        // Let the next request retry a failed open, unless a newer attempt already replaced this one.
        if (opened === opening) opened = undefined;

        if (owned === database) owned = undefined;

        throw error;
      },
    );

    opened = opening;

    return opening;
  }

  async function close(): Promise<void> {
    const database = owned;
    opened = owned = undefined;

    if (database)
      await database.then(
        (open) => open.close(),
        () => {},
      );
  }

  const authorization = { tenantId: session.tenantId, principalId: session.principal };

  const allowedHosts = new Set(
    options.allowedHosts ?? ["localhost:3030", "127.0.0.1:3030", "[::1]:3030"],
  );

  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      "http://localhost:3030",
      "http://127.0.0.1:3030",
      "http://[::1]:3030",
    ],
  );

  const social = createSocial({
    backends: { [backendName]: backend },
    idempotencyStore: {
      claim: async (input) => (await stores()).idempotency.claim(input),
      saveOutcome: async (input) => (await stores()).idempotency.saveOutcome(input),
    },
    authorization: {
      async authorizeTargets({ accounts, context }) {
        return Promise.all(
          accounts.map(async (account) => ({
            account,
            allowed:
              context.authorization?.tenantId === session.tenantId &&
              context.authorization?.principalId === session.principal &&
              account.backend === backendName &&
              (await membership(session, account.accountId)),
          })),
        );
      },
    },
  });

  async function accounts() {
    return (await social.accounts.list({ backend: backendName, authorization })).items;
  }

  async function authorizedAccount(id: string, platform?: string) {
    const account = (await accounts()).find(
      (item) =>
        item.ref.accountId === id && (platform === undefined || item.ref.platform === platform),
    );

    return account?.ref ?? fail("Account is not authorized for this tenant", 403);
  }

  async function post(input: Record<string, unknown>): Promise<PlatformPostRef> {
    const account = await authorizedAccount(
      required(input, "accountId"),
      required(input, "platform"),
    );

    return { ...account, kind: "platform-post", postId: required(input, "postId") };
  }

  async function reconcile(
    previous: PublishResult,
    includePublished = false,
  ): Promise<PublishResult> {
    const outcomes: DeliveryOutcome[] = [];

    for (const outcome of previous.outcomes) {
      if (
        !(
          ["scheduled", "accepted", "processing", "unknown"].includes(outcome.state) ||
          (includePublished && outcome.state === "published")
        ) ||
        !outcome.delivery
      ) {
        outcomes.push(outcome);
        continue;
      }

      const fresh = await social.posts.getDelivery(outcome.delivery, { authorization });
      outcomes.push({ ...fresh, targetIndex: outcome.targetIndex });
    }

    return {
      ...previous,
      outcomes,
      status: outcomes.every((outcome) => outcome.state === "published")
        ? "complete"
        : outcomes.every((outcome) =>
              ["scheduled", "accepted", "processing"].includes(outcome.state),
            )
          ? "pending"
          : "partial",
    };
  }

  async function handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;

    try {
      const host = request.headers.get("host") ?? new URL(request.url).host;

      if (!host || !allowedHosts.has(host))
        return new Response("Misdirected request", { status: 421 });

      if (request.method === "POST") {
        const origin = request.headers.get("origin");

        if (
          (origin && !allowedOrigins.has(origin)) ||
          request.headers.get("sec-fetch-site") === "cross-site"
        )
          return fail("Cross-origin mutations are not allowed", 403);
      }

      if (request.method === "GET" && ["/", "/example.js"].includes(path))
        return new Response(
          await readFile(
            new URL(
              path === "/" ? "../public/index.html" : "../dist/ui-client.js",
              import.meta.url,
            ),
            "utf8",
          ),
          {
            headers: {
              "content-type":
                path === "/" ? "text/html; charset=utf-8" : "text/javascript; charset=utf-8",
              "content-security-policy":
                "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
            },
          },
        );

      if (request.method === "POST" && path === "/api/mock/advance") {
        if (!simulated || !("testing" in backend))
          return fail("Mock controls are unavailable", 404);
        // SAFETY: The `testing` capability check above narrows this adapter to the mock implementation.
        (backend as MockSocialAdapter).testing.advanceProcessing();

        return json({ simulated: true, advanced: true });
      }

      if (request.method === "POST" && path === "/api/mock/scenario") {
        if (!simulated || !("testing" in backend))
          return fail("Mock controls are unavailable", 404);
        const scenario = required(await body(request), "scenario");

        if (
          ![
            "immediate-text-success",
            "mixed-success-failure",
            "media-processing-then-success",
            "accepted-response-lost",
          ].includes(scenario)
        )
          return fail("Unsupported mock scenario");
        // SAFETY: The scenario allowlist above proves this value is a supported mock scenario.
        (backend as MockSocialAdapter).testing.setScenario(scenario as MockScenario);

        return json({ simulated: true });
      }

      // Static assets and mock controls work without the database.
      const { inbox, publications } = await stores();

      if (request.method === "GET" && path === "/api/accounts")
        return json({
          authenticatedPrincipal: session.principal,
          accounts: await accounts(),
          simulated,
        });

      if (request.method === "GET" && path === "/api/connect/start") {
        const connection = options.connection;

        if (!connection)
          return json({ simulated, accounts: await accounts(), mode: "select-existing-account" });

        return json(
          await connection.manager.begin({
            backend: backendName,
            tenantId: session.tenantId,
            principalId: session.principal,
            platforms: connection.platforms,
            redirectUri: connection.redirectUri,
            allowedRedirectUris: [connection.redirectUri],
            provider: connection.provider,
          }),
        );
      }

      if (request.method === "POST" && path === "/api/connect/callback") {
        const input = await body(request);
        const connection = options.connection;

        if (!connection)
          return json({
            simulated,
            selected: await authorizedAccount(required(input, "accountId")),
            mode: "select-existing-account",
          });

        return json({
          accounts: await connection.manager.discover({
            attemptId: required(input, "attemptId"),
            callbackUrl: required(input, "callbackUrl"),
            returnedState: required(input, "returnedState"),
            tenantId: session.tenantId,
            principalId: session.principal,
            allowedRedirectUris: [connection.redirectUri],
            provider: connection.provider,
          }),
        });
      }

      if (request.method === "POST" && path === "/api/connect/select") {
        const input = await body(request);

        if (!options.connection) return fail("OAuth is not configured", 501);
        const ids = input["accountIds"];

        if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
          return fail("accountIds must be strings");

        return json({
          grants: await options.connection.manager.select({
            attemptId: required(input, "attemptId"),
            tenantId: session.tenantId,
            principalId: session.principal,
            selectedAccountIds: ids,
          }),
        });
      }

      if (request.method === "POST" && ["/api/prepare", "/api/publish"].includes(path)) {
        const input = await body(request);
        const text = required(input, "text");
        const ids = input["accountIds"];

        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 20 ||
          !ids.every((id) => typeof id === "string") ||
          new Set(ids).size !== ids.length
        )
          return fail("Choose 1-20 distinct accounts from /api/accounts");
        const optionsByAccount = input["optionsByAccount"];

        if (optionsByAccount !== undefined && !record(optionsByAccount))
          return fail("optionsByAccount must be an object");
        const targets = [];

        for (const id of ids) {
          const choices = record(optionsByAccount) ? optionsByAccount[id] : undefined;

          if (choices !== undefined && !record(choices))
            return fail("Per-account options must be objects");

          // SAFETY: `choices` passed the record boundary check immediately above.
          const options = choices as JsonObject | undefined;

          targets.push({
            account: await authorizedAccount(id),
            ...(options === undefined ? {} : { options }),
          });
        }

        if (input["format"] !== undefined && !["text", "video"].includes(String(input["format"])))
          return fail("format must be text or video");

        const content =
          input["format"] === "video"
            ? {
                text,
                media: [
                  {
                    kind: "video" as const,
                    source: { kind: "https-url" as const, url: required(input, "mediaUrl") },
                    mimeType: required(input, "mediaMime"),
                  },
                ],
              }
            : { text };

        if (path === "/api/prepare")
          return json({ preparation: social.posts.prepare({ targets, content }) });
        const key = required(input, "idempotencyKey");

        if (key.length > 200) return fail("idempotencyKey must be at most 200 characters");

        const result = await social.posts.publish(
          { targets, content, idempotencyKey: key },
          { authorization },
        );

        // Replaying a publish key may return its original processing observation.
        // Preserve the separately reconciled projection once stored.
        if (
          result.outcomes.some(
            (outcome) =>
              outcome.state === "not-submitted" && outcome.reason === "idempotency-conflict",
          )
        )
          return json({ idempotencyKey: key, result }, 409);
        const saved = await publications.get(session.tenantId, key);

        if (!saved) await publications.save(session.tenantId, key, result);

        return json({ simulated, idempotencyKey: key, result: saved ?? result });
      }

      if (request.method === "POST" && path === "/api/reconcile") {
        const input = await body(request);
        const key = required(input, "idempotencyKey");
        const previous = await publications.get(session.tenantId, key);

        if (!previous) return fail("Unknown publication", 404);
        const result = await reconcile(previous);
        await publications.save(session.tenantId, key, result);

        return json({
          idempotencyKey: key,
          result: (await publications.get(session.tenantId, key)) ?? result,
        });
      }

      if (request.method === "POST" && path === "/api/events/reports") {
        const key = required(await body(request), "idempotencyKey");

        if (!(await publications.get(session.tenantId, key)))
          return fail("Unknown publication", 404);

        return json({ reports: await publications.removalReports(session.tenantId, key) });
      }

      if (request.method === "POST" && path === "/api/metrics")
        return json({
          metrics: await social.analytics.getPostMetrics(await post(await body(request)), {
            authorization,
          }),
        });

      if (request.method === "POST" && path === "/api/comments/list")
        return json(await social.comments.list(await post(await body(request)), { authorization }));

      if (request.method === "POST" && path === "/api/comments/reply") {
        const input = await body(request);
        const parent = await post(input);

        if (!backend.comments)
          return fail("Comment replies are not supported by this backend", 501);

        return json({
          comment: await social.comments.reply(
            { ...parent, kind: "comment", commentId: required(input, "commentId") },
            { text: required(input, "text") },
            { authorization },
          ),
        });
      }

      if (request.method === "POST" && path === "/api/events") {
        const raw = await bytes(request);

        const context = {
          backendInstance: backendName,
          correlationId: randomUUID(),
          retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
        };

        if (!backend.webhooks) return fail("Webhooks are not supported", 501);

        const verified = await backend.webhooks.verify(
          { headers: request.headers, body: raw },
          context,
        );

        if (!verified.valid) return fail("Invalid webhook authentication", 401);

        const decoded = await backend.webhooks.decode(
          { headers: request.headers, body: raw },
          context,
        );

        if (!simulated) {
          // SAFETY: The selected backend decoder returns the normalized event contract for non-simulated requests.
          // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the decoder's JsonObject must cross into the normalized event contract.
          const event = decoded as unknown as SocialEvent;

          if (
            event.version !== 1 ||
            event.backend !== backendName ||
            !Array.isArray(event.accountIds)
          )
            return fail("Malformed normalized event");

          const mapped =
            event.accountIds.length > 0 &&
            (await Promise.all(event.accountIds.map((id) => membership(session, id)))).every(
              Boolean,
            );

          const key =
            mapped && event.backendRecordId
              ? await publications.findByDelivery(
                  session.tenantId,
                  backendName,
                  event.backendRecordId,
                  event.accountIds,
                )
              : undefined;

          const quarantined =
            !key ||
            !["publication.updated", "post.removed", "backend-record.deleted"].includes(event.type);

          return json({
            state: await inbox.accept(
              JSON.stringify([1, event.provider, backendName, "/api/events", event.id]),
              { tenantId: session.tenantId, publicationKey: key, event },
              quarantined,
            ),
            quarantined,
          });
        }

        const eventId = required(decoded, "eventId");
        const key = typeof decoded["publicationKey"] === "string" ? decoded["publicationKey"] : "";
        const accountId = typeof decoded["accountId"] === "string" ? decoded["accountId"] : "";
        const publication = await publications.get(session.tenantId, key);

        const quarantined =
          !publication ||
          !(await membership(session, accountId)) ||
          !publication.outcomes.some((outcome) => outcome.account.accountId === accountId);

        return json({
          state: await inbox.accept(
            JSON.stringify([backendName, eventId]),
            { tenantId: session.tenantId, publicationKey: key, event: decoded },
            quarantined,
          ),
          quarantined,
        });
      }

      if (request.method === "POST" && path === "/api/events/process") {
        let applied = 0;

        for (const entry of await inbox.pending()) {
          if (
            !record(entry.payload) ||
            entry.payload["tenantId"] !== session.tenantId ||
            typeof entry.payload["publicationKey"] !== "string"
          )
            continue;
          const key = entry.payload["publicationKey"];
          const previous = await publications.get(session.tenantId, key);

          if (!previous) continue;

          if (
            !(
              await Promise.all(
                previous.outcomes.map((outcome) => membership(session, outcome.account.accountId)),
              )
            ).every(Boolean)
          )
            continue;
          const event = record(entry.payload["event"]) ? entry.payload["event"] : {};

          const removal =
            event["type"] === "post.removed" || event["type"] === "backend-record.deleted";

          // Native-removal webhooks are observations, not proof of permanent deletion.
          // Keep the publication history and flag the report for explicit verification.
          const result = removal
            ? previous
            : await reconcile(previous, event["originalType"] === "post.tiktok.url_resolved");

          if (
            await publications.applyEvent(
              session.tenantId,
              key,
              result,
              entry.eventKey,
              removal ? { state: "removal-reported", event } : undefined,
            )
          )
            applied++;
        }

        return json({ applied, pending: await inbox.pendingCount() });
      }

      if (request.method === "POST" && path === "/api/events/replay")
        return json({ pending: await inbox.pendingCount() });

      return new Response("Not found", { status: 404 });
    } catch (error) {
      if (error instanceof Response) return error;

      if (error instanceof SocialError) {
        const statusByCode: Partial<Record<SocialError["code"], number>> = {
          rate_limited: 429,
          upstream_failure: 502,
          timeout: 504,
          not_found: 404,
          invalid_input: 400,
        };

        return json(
          { error: error.code, message: error.message },
          statusByCode[error.code] ??
            (error.code === "unauthorized"
              ? 403
              : error.code === "idempotency_conflict"
                ? 409
                : 400),
        );
      }

      return json({ error: "Request failed" }, 500);
    }
  }

  return { handle, client: social, close };
}

export const defaultExampleHandler = createExampleHandler();

export const handleExample = defaultExampleHandler.handle;
