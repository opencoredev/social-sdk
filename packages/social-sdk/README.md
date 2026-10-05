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

## Documentation

Full documentation lives at [social-sdk.dev/docs](https://social-sdk.dev/docs). Start with the [installation guide](https://social-sdk.dev/docs/getting-started/installation), then read the [capability matrix](https://social-sdk.dev/docs/reference/capabilities) before choosing an adapter. The matrix lists the normalized operations each adapter implements. It does not replace provider permissions, account eligibility, or live verification with your own accounts.

The package includes an offline `social-sdk` CLI for adapter discovery, capability checks, and request validation. After installing `@opencoredev/social-sdk` in your project, run it from that project directory with `npm exec -- social-sdk adapters --json` or `bun run social-sdk adapters --json`. See the [CLI reference](https://social-sdk.dev/docs/reference/cli).
