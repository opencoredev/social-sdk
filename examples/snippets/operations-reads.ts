import { createSocial } from "@opencoredev/social-sdk";
import { mockBackend } from "@opencoredev/social-sdk/testing";

const social = createSocial({
  backend: mockBackend({ scenario: "media-processing-then-success" }),
});

const page = await social.accounts.list({ backend: "default" });

for (const account of page.items) console.log(account.ref.platform, account.ref.accountId);

const account = page.items[0]?.ref;

if (!account) throw new Error("Mock account missing");

const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Read a saved delivery" },
});

const ref = result.outcomes[0]?.delivery;

if (!ref) throw new Error("Mock delivery missing");

console.log((await social.posts.getDelivery(ref)).state);
