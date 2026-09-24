import {
  createSocial,
  SocialError,
  type AdapterOperationContext,
  type ConnectedAccountRef,
  type ConversationRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type JsonValue,
  type PlatformPostRef,
} from "@opencoredev/social-sdk";
import { zernio } from "@opencoredev/social-sdk/cloud/zernio";
import {
  acceptWebhook,
  decodeWebhook,
  verifyZernioWebhook,
  type EventInbox,
} from "@opencoredev/social-sdk/server";

/** Call on your server with the API key from your environment or secret store. */
export function createZernioSocial(apiKey: string) {
  return createSocial({ backend: zernio({ apiKey }) });
}

export type ZernioSocial = ReturnType<typeof createZernioSocial>;

/** Publish one video to YouTube and Instagram now. The adapter uploads the bytes to Zernio. */
export async function publishVideo(
  social: ZernioSocial,
  accounts: {
    youtube: ConnectedAccountRef<"youtube">;
    instagram: ConnectedAccountRef<"instagram">;
  },
  video: Blob,
  tenantId: string,
) {
  const result = await social.posts.publish(
    {
      targets: [
        {
          account: accounts.youtube,
          options: { title: "Release walkthrough", visibility: "unlisted", madeForKids: false },
        },
        { account: accounts.instagram, options: { shareToFeed: true } },
      ],
      content: {
        text: "A two-minute tour of the new release.",
        media: [
          {
            kind: "video",
            source: { kind: "blob", blob: video, fingerprint: "release-walkthrough-v1" },
            mimeType: "video/mp4",
            filename: "release-walkthrough.mp4",
          },
        ],
      },
      idempotencyKey: "release-walkthrough-v1",
    },
    { authorization: { tenantId } },
  );

  // One outcome per target. Store each delivery reference to check it later.
  return result.outcomes;
}

/** Schedule one post and return the delivery reference to store. */
export async function schedulePost(
  social: ZernioSocial,
  account: ConnectedAccountRef,
  tenantId: string,
  at: string,
) {
  const result = await social.posts.publish(
    {
      targets: [{ account }],
      content: { text: "Office hours start at 10:00." },
      schedule: { at, timeZone: "Europe/Berlin" },
    },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Read one delivery and decide what to do next. */
export async function checkDelivery(social: ZernioSocial, delivery: DeliveryRef, tenantId: string) {
  const outcome = await social.posts.getDelivery(delivery, { authorization: { tenantId } });

  return nextStep(outcome);
}

export function nextStep(outcome: DeliveryOutcome): string {
  switch (outcome.state) {
    case "published":
      return `published ${outcome.url ?? outcome.post.postId}`;
    case "scheduled":
      return `scheduled as ${outcome.job.jobId}; check again after the scheduled time`;
    case "accepted":
    case "processing":
      return "Zernio is still working; check again later";
    case "failed":
      return outcome.retryDisposition.kind === "after-reconnect"
        ? "ask the account owner to reconnect, then publish again"
        : `failed with ${outcome.code}`;
    case "cancelled":
      return "cancelled";
    case "not-submitted":
      return `not submitted: ${outcome.reason}`;
    case "unknown":
      return "state is unclear; reconcile before retrying";
  }
}

/** Cancel a future scheduled post. Zernio deletes the record. */
export async function cancelScheduled(
  social: ZernioSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "scheduled") return undefined;

  const cancellation = await social.posts.cancelScheduled(outcome.job, {
    authorization: { tenantId },
  });

  return cancellation.backendRecord; // "deleted" on Zernio
}

/** Remove a published post from the platform through Zernio. */
export async function removePublished(
  social: ZernioSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "published") return false;
  // outcome.post carries the Zernio record ID that removal needs.
  await social.posts.removeFromPlatform(outcome.post, { authorization: { tenantId } });

  return true;
}

/** Read post and account metrics. */
export async function readMetrics(social: ZernioSocial, post: PlatformPostRef, tenantId: string) {
  const authorization = { tenantId };
  const postMetrics = await social.analytics.getPostMetrics(post, { authorization });

  const accountMetrics = await social.analytics.getAccountMetrics(
    {
      kind: "connected-account",
      version: 1,
      backend: post.backend,
      platform: post.platform,
      accountId: post.accountId,
    },
    { authorization },
  );

  return { postMetrics, accountMetrics };
}

/** Reply to the newest comment on a published post. */
export async function replyToFirstComment(
  social: ZernioSocial,
  post: PlatformPostRef,
  tenantId: string,
) {
  const authorization = { tenantId };
  const comments = await social.comments.list(post, { limit: 20, authorization });
  const commentId = comments.items[0]?.["id"];

  if (!isString(commentId)) return undefined;

  return social.comments.reply(
    { ...post, kind: "comment", commentId },
    { text: "Thanks for watching." },
    { authorization },
  );
}

/** Read the first conversation and send a reply in it. */
export async function answerFirstConversation(
  social: ZernioSocial,
  account: ConnectedAccountRef,
  tenantId: string,
) {
  const authorization = { tenantId };

  const conversations = await social.messages.listConversations(account, {
    limit: 20,
    authorization,
  });

  const conversationId = conversations.items[0]?.["id"];

  if (!isString(conversationId)) return undefined;

  const conversation: ConversationRef = { ...account, kind: "conversation", conversationId };
  const messages = await social.messages.listMessages(conversation, { limit: 50, authorization });

  const sent = await social.messages.send(
    conversation,
    { text: "Thanks, we are on it." },
    {
      authorization,
    },
  );

  return { messages: messages.items.length, sent: sent["state"] };
}

/** A fetch-style route for Zernio webhooks. */
export function zernioWebhookRoute(input: {
  secret: string;
  endpointId: string;
  inbox: EventInbox;
  resolveTenants: (backend: string, accountIds: readonly string[]) => Promise<readonly string[]>;
}) {
  return async (request: Request): Promise<Response> => {
    const body = new Uint8Array(await request.arrayBuffer());

    try {
      await verifyZernioWebhook({ secret: input.secret, headers: request.headers, body });
    } catch (error) {
      if (error instanceof SocialError && error.code === "unauthorized")
        return new Response("unauthorized", { status: 401 });

      throw error;
    }

    const event = await decodeWebhook({ provider: "zernio", backend: "default", body });

    const result = await acceptWebhook({
      event,
      endpointId: input.endpointId,
      inbox: input.inbox,
      resolveTenants: input.resolveTenants,
    });

    return new Response(result.state, { status: 202 });
  };
}

/** Start a hosted Zernio connection flow for one profile. */
export async function connectAccount(social: ZernioSocial, redirectUrl: string, tenantId: string) {
  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: crypto.randomUUID(),
    retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
    authorization: { tenantId },
  };

  const native = social.native("default", { acknowledgeUnsafe: true });
  const profiles = await native.listProfiles(context);
  const profileId = profiles[0]?.["_id"];

  if (!isString(profileId)) return undefined;

  const { url } = await native.createConnection({ platform: "x", profileId, redirectUrl }, context);

  return url;
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
