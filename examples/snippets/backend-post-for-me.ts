import {
  createSocial,
  platformPostRef,
  SocialError,
  type AdapterOperationContext,
  type BackendPostRef,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type JsonValue,
} from "@opencoredev/social-sdk";
import { postForMe } from "@opencoredev/social-sdk/cloud/post-for-me";
import {
  acceptWebhook,
  decodeWebhook,
  verifyPostForMeWebhook,
  type EventInbox,
  type SocialEvent,
} from "@opencoredev/social-sdk/server";

/** Call on your server with the API key from your environment or secret store. */
export function createPostForMeSocial(apiKey: string) {
  return createSocial({ backend: postForMe({ apiKey }) });
}

export type PostForMeSocial = ReturnType<typeof createPostForMeSocial>;

/** Publish one image to X and Instagram now. The adapter uploads the bytes to Post for Me. */
export async function publishImage(
  social: PostForMeSocial,
  accounts: { x: ConnectedAccountRef<"x">; instagram: ConnectedAccountRef<"instagram"> },
  image: Blob,
  tenantId: string,
) {
  const result = await social.posts.publish(
    {
      targets: [
        { account: accounts.x, options: { replySettings: "following" } },
        { account: accounts.instagram, options: { shareToFeed: true } },
      ],
      content: {
        text: "The new dashboard is live.",
        media: [
          {
            kind: "image",
            source: { kind: "blob", blob: image, fingerprint: "dashboard-launch-v1" },
            mimeType: "image/png",
            filename: "dashboard.png",
          },
        ],
      },
      idempotencyKey: "dashboard-launch-v1",
    },
    { authorization: { tenantId } },
  );

  return result.outcomes;
}

/** Schedule one post and return its outcome, which carries the delivery reference to store. */
export async function schedulePost(
  social: PostForMeSocial,
  account: ConnectedAccountRef,
  tenantId: string,
  at: string,
) {
  const result = await social.posts.publish(
    { targets: [{ account }], content: { text: "Maintenance window tonight." }, schedule: { at } },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Read one delivery and decide what to do next. */
export async function checkDelivery(
  social: PostForMeSocial,
  delivery: DeliveryRef,
  tenantId: string,
) {
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
      return "Post for Me is still working; check again later";
    case "failed":
      return `failed with ${outcome.code}`;
    case "cancelled":
      return "cancelled";
    case "not-submitted":
      return `not submitted: ${outcome.reason}`;
    case "unknown":
      return "state is unclear; reconcile before retrying";
  }
}

/** Cancel a future scheduled post, then delete the draft Post for Me keeps. */
export async function cancelAndDelete(
  social: PostForMeSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "scheduled") return false;

  const authorization = { tenantId };
  const cancellation = await social.posts.cancelScheduled(outcome.job, { authorization });

  if (cancellation.backendRecord === "retained") {
    const draft: BackendPostRef = {
      kind: "backend-post",
      version: 1,
      backend: outcome.job.backend,
      platform: outcome.job.platform,
      accountId: outcome.job.accountId,
      recordId: outcome.job.jobId,
    };

    await social.posts.deleteBackendRecord(draft, { authorization });
  }

  return true;
}

/** Read metrics for the latest posts in an account feed. */
export async function recentPostMetrics(
  social: PostForMeSocial,
  account: ConnectedAccountRef,
  tenantId: string,
) {
  const authorization = { tenantId };
  const feed = await social.posts.list(account, { limit: 10, authorization });
  const results = [];

  for (const item of feed.items) {
    const postId = item["platform_post_id"];

    if (!isString(postId)) continue;

    const post = platformPostRef({
      backend: account.backend,
      platform: account.platform,
      accountId: account.accountId,
      postId,
    });

    const metrics = await social.analytics.getPostMetrics(post, { authorization });

    results.push({ postId, metrics });
  }

  return results;
}

/** A fetch-style route for Post for Me webhooks. */
export function postForMeWebhookRoute(input: {
  secret: string;
  endpointId: string;
  inbox: EventInbox;
  resolveTenants: (backend: string, accountIds: readonly string[]) => Promise<readonly string[]>;
}) {
  return async (request: Request): Promise<Response> => {
    const body = new Uint8Array(await request.arrayBuffer());

    try {
      await verifyPostForMeWebhook({ secret: input.secret, headers: request.headers, body });
    } catch (error) {
      if (error instanceof SocialError && error.code === "unauthorized")
        return new Response("unauthorized", { status: 401 });

      throw error;
    }

    const event = await decodeWebhook({ provider: "post-for-me", backend: "default", body });

    const result = await acceptWebhook({
      event,
      endpointId: input.endpointId,
      inbox: input.inbox,
      resolveTenants: input.resolveTenants,
    });

    return new Response(result.state, { status: 202 });
  };
}

/** Worker step: the body is not signed, so read the current state from Post for Me. */
export async function processPostForMeEvent(
  social: PostForMeSocial,
  event: SocialEvent,
  tenantId: string,
  findDelivery: (backendRecordId: string) => Promise<DeliveryRef | undefined>,
) {
  if (event.type !== "publication.updated" || event.backendRecordId === undefined) return undefined;

  const delivery = await findDelivery(event.backendRecordId);

  if (delivery === undefined) return undefined;

  return social.posts.getDelivery(delivery, { authorization: { tenantId } });
}

/** Start a hosted Post for Me connection flow. */
export async function connectAccount(
  social: PostForMeSocial,
  input: { externalId: string; redirectUrl: string },
  tenantId: string,
) {
  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: crypto.randomUUID(),
    retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
    authorization: { tenantId },
  };

  const native = social.native("default", { acknowledgeUnsafe: true });

  const { url } = await native.createConnection(
    {
      platform: "instagram",
      externalId: input.externalId,
      permissions: ["posts", "feeds"],
      redirectUrl: input.redirectUrl,
    },
    context,
  );

  return url;
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}
