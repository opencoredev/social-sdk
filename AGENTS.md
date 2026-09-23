# Social SDK Agent Instructions

These instructions apply to this repository.

## Product boundary

- Public package: `@opencoredev/social-sdk`
- Package directory: `packages/social-sdk`
- Documentation application: `apps/docs`
- Package manager: Bun 1.4.2
- Supported SDK targets begin with Node.js 22.12+, Node.js 24, and Bun.

The SDK supports direct social-platform integrations and optional managed backends. It must not require a hosted Social SDK service, database, queue, UI framework, or telemetry service. Keep platform, backend, content format, and capability as separate concepts.

## Safety and release controls

`@opencoredev/social-sdk` is published on npm. Releases go through Changesets: each user-visible change adds a changeset, the release workflow (`.github/workflows/release.yml`) opens a "chore: version package" PR on `main`, and merging that PR makes the workflow publish to npm with trusted publishing through `bun run release`. The workflow runs only when the repository variable `SOCIAL_SDK_RELEASE_ENABLED` is `true`, and `scripts/publish.ts` refuses to publish without `SOCIAL_SDK_RELEASE_AUTHORIZED=true`.

Agents may prepare release work, such as changesets, version bumps, changelog fixes, and workflow changes. Do not publish, merge a version PR, deploy, change DNS, use paid APIs, or perform live social mutations without the owner's explicit authorization for that task. Do not add package tokens or production project IDs. A green build does not grant that authorization.

Default checks must be offline and deterministic. Live provider checks require dedicated credentials and explicit per-run authorization. Missing credentials are a blocked live-verification result, never a pass.

## Changes and checks

User-visible SDK or CLI changes require a Changeset. Use an honest patch, minor, or major bump and include migration notes for breaking changes.

Run the narrow checks for touched files while working. Before handoff, run:

```bash
bun install --frozen-lockfile
bun run release:ci
bun run test:node
```

Use these commands separately when diagnosing failures:

```bash
bun run lint
bun run format:check
bun run check-types
bun run test
bun run rebrand:check
bun run build
```

`format:check` is non-mutating. Use `format:fix` only when a formatting rewrite is intended.

## Public contracts

Use strict TypeScript. External data starts as `unknown` and is validated before use. Avoid `any`, blanket casts, ignored type errors, import-time work, hidden retries, and hidden network requests.

Keep root imports small. Platform and managed adapters use explicit subpath exports. Advertise an export only after its implementation, documentation, and evidence agree. Do not report accepted or processed work as published. Preserve per-destination outcomes and uncertain writes.

Application authentication and social-account authorization are separate. Enforce tenant grants on the server for reads and mutations. Never include credentials, authorization codes, signed URLs, message content, or private account data in logs, fixtures, documentation, or errors.

## Documentation and evidence

Internal plans and evidence live under `planning/`; public documentation lives under `apps/docs/docs/`. Do not copy private planning notes into public output.

Update `planning/implementation-status.md` as requirements move through documented, implemented, contract-tested, live-verified, approval-dependent, and released states. Claims must point to code, tests, or sanitized evidence. Keep source dates and API revisions with adapter research.

The root page stays small and replaceable. The owner will supply the final marketing design. Do not add unsupported claims, provider pricing promises, sponsor marks, customer proof, or a live operational endpoint that has not been deployed and tested.
