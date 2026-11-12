# Contributing to Social SDK

Bug reports, fixes, documentation improvements, and new adapters are welcome. By taking part you agree to follow the [code of conduct](./CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](./SECURITY.md), not in an issue.

## Before you start

For a bug or small fix, open an issue with the [issue form](https://github.com/opencoredev/social-sdk/issues/new/choose) or go straight to a pull request. For a new adapter or a change to a public API, open an issue first so the design can be agreed before you write it.

## Set up

You need [Bun](https://bun.sh) 1.4.2 and Node.js 22.12 or later.

```sh
git clone https://github.com/opencoredev/social-sdk.git
cd social-sdk
bun install --frozen-lockfile
```

The repository is a Bun workspace:

- `packages/social-sdk`: the published `@opencoredev/social-sdk` package and CLI
- `apps/docs`: the documentation site at social-sdk.dev
- `apps/example`: an example application
- `examples` and `skills`: code samples and agent skills that are type-checked in CI

## Make a change

- Write strict TypeScript. Treat external data as `unknown` and validate it before use. Avoid `any`, type assertions, and ignored type errors; prove a type with a guard or decoder instead.
- Do no work at import time and make no hidden network requests or retries.
- Platform and managed adapters are exported from their own subpaths, never from the package root.
- Tests stay offline and deterministic. Use an injected `fetch` with recorded, redacted fixtures.
- Fix lint errors in the code. Pull requests that add `oxlint-disable` or `eslint-disable` comments or weaken a rule fail CI, and changes to the lint configuration need the maintainer's review.

Adding a platform or backend adapter has its own checklist: see [Contributing an adapter](https://social-sdk.dev/docs/contributing).

## Never commit secrets

Keep access tokens, API keys, OAuth codes, webhook secrets, signed URLs, and real account or message content out of code, fixtures, docs, logs, and pull request text. Live provider checks are not part of CI; say in your pull request if you ran one and what you used.

## Add a changeset

A change that users of the package or CLI will notice needs a changeset:

```sh
bunx changeset
```

Pick an honest bump: patch for fixes, minor for new features and adapters, major for breaking changes. A breaking change needs migration notes in the changeset.

CI fails when files under `packages/social-sdk` change without a changeset. If your change there needs no release, such as a fix to the package README, add an empty one with `bunx changeset --empty`. Changes outside the package, such as the docs site, do not need one.

## Run the checks

Before opening a pull request, run these from the repository root:

```sh
bun install --frozen-lockfile
bun run release:ci
```

`release:ci` runs lint, formatting, type checks, tests, the build, and package checks. To run one at a time, use `bun run lint`, `bun run format:check`, `bun run check-types`, `bun run test`, or `bun run build`. `bun run format:fix` rewrites formatting.

## Open a pull request

Describe what changed and why, link the issue it addresses, and list the checks you ran. Keep each pull request to one change. A maintainer reviews it, and releases are published from `main` through Changesets.
