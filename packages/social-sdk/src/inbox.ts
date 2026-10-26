import { SocialError } from "./core/errors.js";
import { definedFields } from "./core/fields.js";
import { fingerprint } from "./core/idempotency.js";
import { decodeCursor, encodeCursor } from "./core/pagination.js";
import {
  isNonBlankStringInput,
  isObjectInput,
  inboxSourceScope,
  mapConcurrent,
  targetKey,
} from "./core/client-support.js";
import type {
  InboxEntry,
  InboxListInput,
  InboxPage,
  InboxSource,
  InboxSourceOutcome,
  PublishCallOptions,
} from "./core/client.js";
import type { InboxAggregation } from "./core/extensions.js";
import { isString } from "./transport/validation.js";

/** Per-source cursor state: `null` not yet read, `false` exhausted, a string resumes the source. */
type InboxSourceState = null | false | string;

// At most 50 raw provider cursors, each capped at 16 KiB by the source facade.
// JSON escaping can expand a code unit sixfold; URI escaping is bounded too.
const inboxCursorLimits = { maxValueLength: 5_000_000, maxEncodedLength: 12_000_000 };

function isInboxState(value: unknown): value is readonly InboxSourceState[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry === null ||
        entry === false ||
        (isString(entry) && entry.length > 0 && entry.length <= 16_384),
    )
  );
}

/**
 * Adds `inbox.list`, which reads conversations and comments from several sources in
 * one call: `createSocial({ ..., inbox: inboxAggregation() })`. Each source is
 * authorized through the same checks as `messages.listConversations` and
 * `comments.list`, and a failing source is reported without failing the others.
 */
export function inboxAggregation(): InboxAggregation {
  return ({
    concurrency,
    nextCorrelationId,
    validateAccountRef,
    authorizeRef,
    listConversations,
    listComments,
  }) => ({
    async list(input: InboxListInput, callOptions?: PublishCallOptions): Promise<InboxPage> {
      const invalid = (message: string): never => {
        throw new SocialError({ code: "invalid_input", operation: "inbox.list", message });
      };

      if (!isObjectInput(input)) invalid("Inbox input must be an object");

      const accounts = input.accounts ?? [];
      const posts = input.posts ?? [];

      if (!Array.isArray(accounts) || !Array.isArray(posts))
        invalid("accounts and posts must be arrays");

      const sources: InboxSource[] = [
        ...accounts.map((account): InboxSource => ({ kind: "conversations", account })),
        ...posts.map((post): InboxSource => ({ kind: "comments", post })),
      ];

      if (sources.length === 0 || sources.length > 50) invalid("Select 1 through 50 inbox sources");

      const limit = input.limit ?? 20;

      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        invalid("Inbox page limit must be an integer from 1 through 100");

      const keys = sources.map((source) => {
        if (source.kind === "conversations") {
          validateAccountRef(source.account, "inbox.list");

          return JSON.stringify(["conversations", targetKey(source.account)]);
        }

        const post = source.post;

        if (
          !isObjectInput(post) ||
          post.kind !== "platform-post" ||
          post.version !== 1 ||
          !isNonBlankStringInput(post.backend) ||
          !isNonBlankStringInput(post.platform) ||
          !isNonBlankStringInput(post.accountId) ||
          !isNonBlankStringInput(post.postId)
        )
          invalid("Inbox posts must be version 1 platform-post references");

        return JSON.stringify([
          "comments",
          JSON.stringify([post.backend, post.platform, post.accountId]),
          post.postId,
        ]);
      });

      if (new Set(keys).size !== keys.length) invalid("Inbox sources must not repeat");

      const scope = await fingerprint([
        "inbox.list",
        callOptions?.authorization?.tenantId ?? null,
        keys,
        limit,
      ]);

      let states: readonly InboxSourceState[] = sources.map(() => null);

      if (input.cursor !== undefined) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(decodeCursor(scope, input.cursor, inboxCursorLimits));
        } catch (error) {
          if (error instanceof SocialError) throw error;
          parsed = undefined;
        }

        if (!isInboxState(parsed) || parsed.length !== sources.length)
          invalid("Cursor does not belong to these inbox sources");
        else states = parsed;
      }

      const sourceOptions: PublishCallOptions = definedFields({
        signal: callOptions?.signal,
        authorization: callOptions?.authorization,
        retryBudget: callOptions?.retryBudget,
      });

      const read = async (
        index: number,
      ): Promise<{
        readonly outcome: InboxSourceOutcome;
        readonly entries: readonly InboxEntry[];
        readonly state: InboxSourceState;
      }> => {
        const source = sources[index];
        const state = states[index] ?? null;

        if (source === undefined) throw new Error("Inbox source index was lost");

        const sourceScope = inboxSourceScope(
          source,
          callOptions?.authorization?.tenantId ?? null,
          limit,
        );

        const pageOptions: PublishCallOptions & { limit: number; cursor?: string } = {
          ...sourceOptions,
          limit,
        };

        if (state !== null && state !== false)
          pageOptions.cursor = encodeCursor(sourceScope, state);

        try {
          if (source.kind === "conversations") {
            if (state === false) {
              await authorizeRef(
                "messages.read",
                source.account,
                sourceOptions,
                nextCorrelationId(),
              );

              return { outcome: { state: "exhausted", source }, entries: [], state };
            }

            const page = await listConversations(source.account, pageOptions);

            return {
              outcome: {
                state: "read",
                source,
                itemCount: page.items.length,
                hasMore: page.nextCursor !== undefined,
              },
              entries: page.items.map((record) => ({
                kind: "conversation",
                sourceIndex: index,
                account: source.account,
                record,
              })),
              state:
                page.nextCursor === undefined ? false : decodeCursor(sourceScope, page.nextCursor),
            };
          }

          if (state === false) {
            await authorizeRef(
              "comments.read",
              {
                kind: "connected-account",
                version: 1,
                backend: source.post.backend,
                platform: source.post.platform,
                accountId: source.post.accountId,
              },
              sourceOptions,
              nextCorrelationId(),
            );

            return { outcome: { state: "exhausted", source }, entries: [], state };
          }

          const page = await listComments(source.post, pageOptions);

          return {
            outcome: {
              state: "read",
              source,
              itemCount: page.items.length,
              hasMore: page.nextCursor !== undefined,
            },
            entries: page.items.map((record) => ({
              kind: "comment",
              sourceIndex: index,
              post: source.post,
              record,
            })),
            state:
              page.nextCursor === undefined ? false : decodeCursor(sourceScope, page.nextCursor),
          };
        } catch (error) {
          const failure =
            error instanceof SocialError
              ? error
              : new SocialError({
                  code: "upstream_failure",
                  operation: "inbox.list",
                  message: "The inbox source could not be read",
                });

          return {
            outcome: {
              state: "failed",
              source,
              code: failure.code,
              message: failure.message,
              retryDisposition: failure.retryDisposition,
            },
            entries: [],
            state,
          };
        }
      };

      const results = await mapConcurrent(sources.length, concurrency, read);
      const nextStates = results.map((result) => result.state);

      const page: InboxPage = {
        entries: results.flatMap((result) => result.entries),
        sources: results.map((result) => result.outcome),
      };

      return nextStates.every((state) => state === false)
        ? page
        : {
            ...page,
            nextCursor: encodeCursor(scope, JSON.stringify(nextStates), inboxCursorLimits),
          };
    },
  });
}
