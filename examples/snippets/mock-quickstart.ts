import { createSocial } from "@opencoredev/social-sdk";
import { MemoryIdempotencyStore, mockBackend } from "@opencoredev/social-sdk/testing";

const backend = mockBackend({ scenario: "immediate-text-success" });

const social = createSocial({
  backend,
  idempotencyStore: new MemoryIdempotencyStore(),
});

const result = await social.posts.publish({
  targets: [
    {
      account: {
        kind: "connected-account",
        version: 1,
        backend: "default",
        platform: "x",
        accountId: "mock-account-1",
      },
    },
  ],
  content: { text: "Hello from a deterministic local Social SDK mock." },
  idempotencyKey: "mock-quickstart-1",
});

console.log(result.outcomes);
