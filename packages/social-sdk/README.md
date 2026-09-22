# Social SDK

TypeScript social platform integrations with direct and optional managed backends.

This package is ESM-only. Provider credentials stay on the server. Importing the root or constructing a client makes no network requests.

Supported runtimes are Node.js 22.12+, Node.js 24, and Bun.

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

The client also exposes capability-checked read surfaces for `social.search.posts` and
`social.search.iteratePosts`, `social.graph` profile and relationship methods,
`social.notifications` including `iterate`, and `social.analytics.getReport`. These methods keep
provider-shaped payloads where platforms differ and fail explicitly when the selected adapter does
not declare the requested capability.

Run the workspace documentation for setup and capability limits. Live provider verification remains dependent on approved accounts and credentials. Publication is controlled by the guarded release workflow.
