import { setTimeout as sleep } from "node:timers/promises";
import {
  createSocial,
  type AdapterOperationContext,
  type BackendPostRef,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type PlatformPostRef,
} from "@opencoredev/social-sdk";
import { postfast } from "@opencoredev/social-sdk/cloud/postfast";

/** Call on your server with the API key from your environment or secret store. */
export function createPostFastSocial(apiKey: string) {
  return createSocial({ backend: postfast({ apiKey }) });
}

export type PostFastSocial = ReturnType<typeof createPostFastSocial>;

/** Schedule a text post. PostFast requires a future schedule time on every post. */
export async function scheduleText(
  social: PostFastSocial,
  account: ConnectedAccountRef,
  tenantId: string,
  at: string,
) {
  const result = await social.posts.publish(
    {
      targets: [{ account }],
      content: { text: "Launching next week." },
      schedule: { at },
    },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Upload a video once, then schedule it to YouTube with the returned media reference. */
export async function scheduleUploadedVideo(
  social: PostFastSocial,
  account: ConnectedAccountRef<"youtube">,
  video: Blob,
  tenantId: string,
  at: string,
) {
  const authorization = { tenantId };

  const media = await social.media.upload(
    {
      kind: "video",
      source: { kind: "blob", blob: video, fingerprint: "product-demo-v1" },
      mimeType: "video/mp4",
      filename: "product-demo.mp4",
    },
    account,
    { authorization },
  );

  const result = await social.posts.publish(
    {
      targets: [
        {
          account,
          options: { title: "Product demo", visibility: "public", madeForKids: false },
        },
      ],
      content: {
        text: "A short demo of the new editor.",
        media: [
          { kind: "video", source: { kind: "media-ref", ref: media }, mimeType: "video/mp4" },
        ],
      },
      schedule: { at },
    },
    { authorization },
  );

  return result.outcomes[0];
}

/** PostFast sends no webhooks. Poll a delivery until it leaves the waiting states. */
export async function waitForDelivery(
  social: PostFastSocial,
  delivery: DeliveryRef,
  tenantId: string,
  { intervalMs = 60_000, maxChecks = 30 } = {},
): Promise<DeliveryOutcome> {
  let outcome = await social.posts.getDelivery(delivery, { authorization: { tenantId } });

  for (let check = 1; check < maxChecks; check++) {
    if (!isWaiting(outcome)) return outcome;
    await sleep(intervalMs);
    outcome = await social.posts.getDelivery(delivery, { authorization: { tenantId } });
  }

  return outcome;
}

function isWaiting(outcome: DeliveryOutcome): boolean {
  switch (outcome.state) {
    case "scheduled": // due later
    case "accepted": // SCHEDULED/PENDING_APPROVAL: waiting for approval in PostFast
    case "processing":
      return true;
    case "published":
    case "failed":
    case "cancelled":
    case "not-submitted":
    case "unknown": // reconcile in PostFast before retrying
      return false;
  }
}

/** Cancel a post that is still scheduled. PostFast deletes the record. */
export async function cancelScheduled(
  social: PostFastSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "scheduled") return undefined;

  const cancellation = await social.posts.cancelScheduled(outcome.job, {
    authorization: { tenantId },
  });

  return cancellation.backendRecord; // "deleted"
}

/** Delete the PostFast record of a failed post. */
export async function deleteFailedRecord(
  social: PostFastSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "failed" || outcome.delivery === undefined) return false;

  const record: BackendPostRef = {
    kind: "backend-post",
    version: 1,
    backend: outcome.delivery.backend,
    platform: outcome.delivery.platform,
    accountId: outcome.delivery.accountId,
    recordId: outcome.delivery.deliveryId,
  };

  await social.posts.deleteBackendRecord(record, { authorization: { tenantId } });

  return true;
}

/** Read post metrics. Use the post reference from a published outcome. */
export async function readPostMetrics(
  social: PostFastSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "published") return [];

  const post: PlatformPostRef = outcome.post; // carries the PostFast record ID

  return social.analytics.getPostMetrics(post, { authorization: { tenantId } });
}

/** Create a hosted connect link for someone outside your PostFast workspace. */
export async function createConnectLink(
  social: PostFastSocial,
  externalId: string,
  tenantId: string,
) {
  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: crypto.randomUUID(),
    retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
    authorization: { tenantId },
  };

  const native = social.native("default", { acknowledgeUnsafe: true });

  const { url } = await native.createConnectLink(
    { platforms: ["X", "LINKEDIN"], expiryDays: 7, externalId },
    context,
  );

  return url;
}
