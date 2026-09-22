import { SocialError } from "../core/errors.js";
import type { AdapterOperationContext, ConnectedAccountRef } from "../core/types.js";
import { managedHttp } from "../cloud/common.js";

/** Credential-ready helper. Applications must authorize the acting account before calling. */
export interface XEngagementOptions {
  readonly userId: string;
  readonly accessToken: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface XEngagementResult {
  readonly liked: boolean;
  readonly tweetId: string;
  readonly userId: string;
}

async function mutate(
  action: "like" | "unlike",
  tweetId: string,
  account: ConnectedAccountRef,
  options: XEngagementOptions,
  context: AdapterOperationContext,
): Promise<XEngagementResult> {
  if (
    account.kind !== "connected-account" ||
    account.version !== 1 ||
    account.backend !== context.backendInstance ||
    account.platform !== "x" ||
    account.accountId !== options.userId
  )
    throw new SocialError({
      code: "unauthorized",
      operation: `x.${action}`,
      message: "Account reference does not belong to this X authorization and backend.",
    });

  if (!/^\d+$/.test(tweetId))
    throw new SocialError({
      code: "invalid_input",
      operation: `x.${action}`,
      message: "Provide a native numeric X post ID.",
    });

  const request = managedHttp("https://api.x.com", {
    apiKey: options.accessToken,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const result = await request(
    `/2/users/${encodeURIComponent(options.userId)}/likes${action === "unlike" ? `/${tweetId}` : ""}`,
    context,
    action === "like" ? { tweet_id: tweetId } : undefined,
    {},
    action === "like" ? "POST" : "DELETE",
  );

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
  const data = result && typeof result === "object" && "data" in result ? result.data : undefined;

  if (
    !data ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    typeof data !== "object" ||
    !("liked" in data) ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
    typeof data.liked !== "boolean" ||
    data.liked !== (action === "like")
  )
    throw new SocialError({
      code: "ambiguous_outcome",
      operation: `x.${action}`,
      message: "X did not confirm the requested reaction state. Reconcile before retrying.",
      retryDisposition: { kind: "reconcile-first" },
    });

  return { liked: data.liked, tweetId, userId: options.userId };
}

/** Requires like.write, tweet.read, users.read and the app's current API access. Never retries writes. */
export function xLike(
  tweetId: string,
  account: ConnectedAccountRef,
  options: XEngagementOptions,
  context: AdapterOperationContext,
): Promise<XEngagementResult> {
  return mutate("like", tweetId, account, options, context);
}

/** Deletes only the authenticated user's like; it does not delete the target post. */
export function xUnlike(
  tweetId: string,
  account: ConnectedAccountRef,
  options: XEngagementOptions,
  context: AdapterOperationContext,
): Promise<XEngagementResult> {
  return mutate("unlike", tweetId, account, options, context);
}
