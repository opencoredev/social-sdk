import { setTimeout as sleep } from "node:timers/promises";
import {
  createSocial,
  type AdapterOperationContext,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type PlatformPostRef,
} from "@opencoredev/social-sdk";
import {
  exchangePostizCode,
  postiz,
  postizAuthorizationUrl,
  type PostizAccessToken,
  type PostizCodeExchangeOptions,
} from "@opencoredev/social-sdk/cloud/postiz";

/** Call on your server with the API key from Postiz Settings. */
export function createPostizSocial(apiKey: string) {
  return createSocial({ backend: postiz({ apiKey }) });
}

/** A self-hosted Postiz instance serves the public API under `/api/public/v1`. */
export function createSelfHostedPostizSocial(apiKey: string, host: string) {
  return createSocial({ backend: postiz({ apiKey, baseUrl: `https://${host}/api/public/v1` }) });
}

export type PostizSocial = ReturnType<typeof createPostizSocial>;

/** Publish a text post now. Postiz returns the delivery while its worker posts it. */
export async function publishNow(
  social: PostizSocial,
  account: ConnectedAccountRef,
  tenantId: string,
) {
  const result = await social.posts.publish(
    { targets: [{ account }], content: { text: "We just shipped dark mode." } },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Upload an image to Postiz storage and schedule it to Instagram. */
export async function scheduleImage(
  social: PostizSocial,
  account: ConnectedAccountRef<"instagram">,
  image: Blob,
  tenantId: string,
  at: string,
) {
  const result = await social.posts.publish(
    {
      targets: [{ account }],
      content: {
        text: "Behind the scenes at the launch.",
        media: [
          {
            kind: "image",
            source: { kind: "blob", blob: image, fingerprint: "launch-photo-v1" },
            mimeType: "image/jpeg",
            filename: "launch.jpg",
            altText: "The team around a laptop",
          },
        ],
      },
      schedule: { at },
    },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Postiz webhooks are unsigned, so poll a delivery until it leaves the waiting states. */
export async function waitForDelivery(
  social: PostizSocial,
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
    case "processing": // due, the Postiz worker is posting it
      return true;
    case "accepted": // a draft waits in Postiz until someone schedules it
    case "published":
    case "failed":
    case "cancelled":
    case "not-submitted":
    case "unknown": // reconcile in Postiz before retrying
      return false;
  }
}

/** Cancel a post that is still scheduled. Postiz deletes the record. */
export async function cancelScheduled(
  social: PostizSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "scheduled") return undefined;

  const cancellation = await social.posts.cancelScheduled(outcome.job, {
    authorization: { tenantId },
  });

  return cancellation.backendRecord; // "deleted"
}

/** Read post metrics. Use the post reference from a published outcome. */
export async function readPostMetrics(
  social: PostizSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "published") return [];

  const post: PlatformPostRef = outcome.post; // carries the Postiz record ID

  return social.analytics.getPostMetrics(post, { authorization: { tenantId } });
}

/** Create an OAuth link that connects a LinkedIn page to your Postiz workspace. */
export async function createConnectLink(social: PostizSocial, tenantId: string) {
  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: crypto.randomUUID(),
    retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
    authorization: { tenantId },
  };

  const native = social.native("default", { acknowledgeUnsafe: true });

  const { url } = await native.createConnectLink({ provider: "linkedin-page" }, context);

  return url;
}

/** Your Postiz OAuth app. Load both values from server-side configuration. */
export type PostizOAuthApp = Pick<PostizCodeExchangeOptions, "clientId" | "clientSecret" | "fetch">;

/** Whatever your framework uses for server-side session state. */
export interface PostizOAuthSession {
  postizState?: string | undefined;
}

/** Redirect the person to this URL. Postiz asks which workspace to connect. */
export function startPostizAuthorization(app: PostizOAuthApp, session: PostizOAuthSession) {
  const state = crypto.randomUUID();

  session.postizState = state;

  return postizAuthorizationUrl({ clientId: app.clientId, state });
}

/** Handle the request Postiz sends to your Redirect URL and return the workspace token. */
export async function finishPostizAuthorization(
  app: PostizOAuthApp,
  session: PostizOAuthSession,
  callback: URL,
): Promise<PostizAccessToken> {
  const expected = session.postizState;

  session.postizState = undefined; // each state value works once

  const state = callback.searchParams.get("state");
  const code = callback.searchParams.get("code");

  if (!expected || state !== expected) throw new Error("The Postiz callback state does not match.");

  if (callback.searchParams.get("error") === "access_denied")
    throw new Error("The person declined the Postiz authorization.");

  if (!code) throw new Error("The Postiz callback has no authorization code.");

  return exchangePostizCode({ ...app, code });
}

/** Store the token with the tenant, then build that tenant's client from it. */
export function createTenantPostizSocial(token: PostizAccessToken) {
  return createPostizSocial(token.accessToken);
}
