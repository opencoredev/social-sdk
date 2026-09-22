import { createSocial } from "@opencoredev/social-sdk";
import { mockBackend } from "@opencoredev/social-sdk/testing";

const social = createSocial({ backend: mockBackend() });

const controller = new AbortController();

for await (const account of social.accounts.iterate({
  backend: "default",
  limit: 25,
  maxPages: 10,
  maxItems: 100,
  signal: controller.signal,
})) {
  console.log(account.displayName);
}
