# Social SDK

Social SDK is a TypeScript toolkit for adding social-platform features to an application. It is designed for direct platform integrations and optional managed backends, with explicit account references, capability checks, and per-destination outcomes.

The selected local implementation passes the deterministic release gate. Live provider verification remains dependent on approved accounts and credentials. The package is publishable through the guarded release workflow; no publication is performed unless the owner enables the release authorization setting.

## Workspace

```text
apps/docs/                 Blume documentation and replaceable minimal home
packages/social-sdk/       SDK, adapters, testing backend, and diagnostic CLI
packages/config/           Shared strict TypeScript configuration
planning/                  Internal decisions, requirement status, and evidence
```

Install dependencies and run the deterministic checks:

```bash
bun install
bun run release:ci
bun run test:node
```

The default build and test path performs no live social mutations and requires no provider credentials.

## Product direction

The SDK keeps four concerns distinct:

- A platform is the destination network.
- A backend is the route used to execute an operation.
- A content format describes the requested content.
- A capability states what a selected backend and account can do.

A selected account determines its backend route. The SDK does not silently switch providers, retry ambiguous public writes, or treat provider processing as proof that content is published.

Public setup and API documentation lives under `apps/docs/docs/`.
