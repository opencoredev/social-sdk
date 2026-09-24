import type { WebhooksAdapter } from "../core/adapter.js";
import type { AdapterOperationContext, CapabilityDeclaration, JsonObject } from "../core/types.js";
import {
  decodePlatformWebhook,
  type DirectWebhookPlatform,
  type VerifiedWebhook,
} from "../server/webhooks.js";

/** Shared adapter wiring for direct-platform webhook verification and decoding. */
export function directWebhooks(
  platform: DirectWebhookPlatform,
  verify: (input: {
    readonly headers: Headers;
    readonly body: Uint8Array;
  }) => Promise<VerifiedWebhook>,
  now: () => string,
): WebhooksAdapter {
  return {
    async verify(input) {
      // Throws `unauthorized` on any failure, matching the managed adapters.
      await verify(input);

      return { valid: true, method: "hmac" };
    },
    async decode(input, context: AdapterOperationContext): Promise<JsonObject> {
      return {
        ...(await decodePlatformWebhook({
          platform,
          backend: context.backendInstance,
          body: input.body,
          receivedAt: now(),
        })),
      };
    },
  };
}

export function webhookCapability(
  platform: DirectWebhookPlatform,
  notes: string,
): CapabilityDeclaration {
  return { platform, operation: "webhooks.verify", availability: "available", notes };
}
