import { setTimeout as sleep } from "node:timers/promises";
import {
  createSocial,
  type ConnectedAccountRef,
  type DeliveryOutcome,
  type DeliveryRef,
  type PlatformPostRef,
} from "@opencoredev/social-sdk";
import {
  buffer,
  bufferAuthorizationUrl,
  createBufferPkce,
  exchangeBufferCode,
  refreshBufferToken,
  type BufferAccessToken,
  type BufferCodeExchangeOptions,
} from "@opencoredev/social-sdk/cloud/buffer";

/** Call on your server with a Buffer API key or OAuth access token. */
export function createBufferSocial(apiKey: string, organizationId?: string) {
  return createSocial({
    backend: buffer({ apiKey, ...definedOrganization(organizationId) }),
  });
}

export type BufferSocial = ReturnType<typeof createBufferSocial>;

function definedOrganization(organizationId: string | undefined) {
  return organizationId === undefined ? {} : { organizationId };
}

/** Publish a text post immediately with Buffer `shareNow`. */
export async function publishNow(
  social: BufferSocial,
  account: ConnectedAccountRef,
  tenantId: string,
) {
  const result = await social.posts.publish(
    { targets: [{ account }], content: { text: "We just shipped dark mode." } },
    { authorization: { tenantId } },
  );

  return result.outcomes[0];
}

/** Schedule a public HTTPS image. Buffer has no upload endpoint. */
export async function scheduleImage(
  social: BufferSocial,
  account: ConnectedAccountRef<"instagram">,
  tenantId: string,
  at: string,
) {
  const result = await social.posts.publish(
    {
      targets: [{ account, options: { shareToFeed: true } }],
      content: {
        text: "Behind the scenes at the launch.",
        media: [
          {
            kind: "image",
            source: { kind: "https-url", url: "https://cdn.example/launch.jpg" },
            mimeType: "image/jpeg",
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

/** Buffer has no webhooks, so poll a delivery until it leaves the waiting states. */
export async function waitForDelivery(
  social: BufferSocial,
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
    case "scheduled":
    case "processing":
    case "accepted":
      return true;
    case "published":
    case "failed":
    case "cancelled":
    case "not-submitted":
    case "unknown":
      return false;
  }
}

/** Cancel a post that is still scheduled. Buffer deletes the record. */
export async function cancelScheduled(
  social: BufferSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "scheduled") return undefined;

  const cancellation = await social.posts.cancelScheduled(outcome.job, {
    authorization: { tenantId },
  });

  return cancellation.backendRecord;
}

/** Read post metrics after Buffer marks the post sent. */
export async function readPostMetrics(
  social: BufferSocial,
  outcome: DeliveryOutcome,
  tenantId: string,
) {
  if (outcome.state !== "published") return [];

  const post: PlatformPostRef = outcome.post;

  return social.analytics.getPostMetrics(post, { authorization: { tenantId } });
}

interface OAuthSession {
  bufferState?: string | undefined;
  bufferVerifier?: string | undefined;
}

export function startOAuth(session: OAuthSession, clientId: string, redirectUri: string): string {
  const pkce = createBufferPkce();
  session.bufferState = crypto.randomUUID();
  session.bufferVerifier = pkce.codeVerifier;

  return bufferAuthorizationUrl({
    clientId,
    redirectUri,
    state: session.bufferState,
    codeChallenge: pkce.codeChallenge,
  });
}

export async function finishOAuth(
  session: OAuthSession,
  code: string,
  options: Omit<BufferCodeExchangeOptions, "code" | "codeVerifier">,
): Promise<BufferAccessToken> {
  if (!session.bufferVerifier) throw new Error("Missing PKCE verifier.");

  return exchangeBufferCode({
    ...options,
    code,
    codeVerifier: session.bufferVerifier,
  });
}

export function refreshOAuth(
  clientId: string,
  refreshToken: string,
  clientSecret?: string,
): Promise<BufferAccessToken> {
  return refreshBufferToken({ clientId, refreshToken, ...definedSecret(clientSecret) });
}

function definedSecret(clientSecret: string | undefined) {
  return clientSecret === undefined ? {} : { clientSecret };
}
