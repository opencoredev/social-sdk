import {
  acceptWebhook,
  decodeWebhook,
  verifyPostForMeWebhook,
  verifyZernioWebhook,
  type EventInbox,
} from "@opencoredev/social-sdk/server";

export async function receiveWebhook(input: {
  provider: "zernio" | "post-for-me";
  backend: string;
  endpointId: string;
  secret: string;
  headers: Headers;
  rawBody: Uint8Array;
  inbox: EventInbox;
  resolveTenants: (backend: string, accountIds: readonly string[]) => Promise<readonly string[]>;
}) {
  const verify = input.provider === "zernio" ? verifyZernioWebhook : verifyPostForMeWebhook;
  await verify({ secret: input.secret, headers: input.headers, body: input.rawBody });

  const event = await decodeWebhook({
    provider: input.provider,
    backend: input.backend,
    body: input.rawBody,
  });

  return await acceptWebhook({
    event,
    endpointId: input.endpointId,
    inbox: input.inbox,
    // Return [] for unknown mappings so the SDK quarantines instead of guessing ownership.
    resolveTenants: input.resolveTenants,
  });
}
