import {
  connectedAccountRef,
  createSocial,
  type AuthorizationPolicy,
} from "@opencoredev/social-sdk";
import { MemoryIdempotencyStore, mockBackend } from "@opencoredev/social-sdk/testing";

const account = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
});

const authorization: AuthorizationPolicy = {
  async authorizeTargets({ accounts, context }) {
    if (context.authorization?.tenantId !== "tenant_demo") {
      return accounts.map((candidate) => ({
        account: candidate,
        allowed: false,
        reason: "tenant is not authorized",
      }));
    }

    return accounts.map((candidate) => ({
      account: candidate,
      allowed: candidate.accountId === account.accountId,
    }));
  },
};

const social = createSocial({
  backend: mockBackend(),
  authorization,
  idempotencyStore: new MemoryIdempotencyStore(),
});

export const result = await social.posts.publish(
  { content: { text: "Hello from the Social SDK" }, targets: [{ account }] },
  { authorization: { tenantId: "tenant_demo", principalId: "user_demo" } },
);
