# Social SDK

TypeScript social platform integrations with direct and optional managed backends.

This package is ESM-only. Provider credentials stay on the server. Importing the root or constructing a client makes no network requests.

```ts
import { createSocial, connectedAccountRef } from "@opencoredev/social-sdk";
import { mockBackend } from "@opencoredev/social-sdk/testing";

const social = createSocial({ backend: mockBackend() });
const account = connectedAccountRef({
  backend: "default",
  platform: "x",
  accountId: "mock-account-1",
});
const result = await social.posts.publish({
  targets: [{ account }],
  content: { text: "Hello from the local mock." },
});
console.log(result.outcomes[0]?.state);
```

Run the workspace documentation for setup and capability limits. Live provider verification remains dependent on approved accounts and credentials. Publication is controlled by the guarded release workflow.
