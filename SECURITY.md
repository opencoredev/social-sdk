# Security policy

## Supported versions

Social SDK is pre-1.0. Security fixes go into the latest minor release of `@opencoredev/social-sdk` on npm. Upgrade to that release to receive them; older minor versions are not patched.

## Report a vulnerability

Do not open a public issue, pull request, or discussion for a security problem.

Report it privately in one of two ways:

- [Open a private vulnerability report](https://github.com/opencoredev/social-sdk/security/advisories/new) from the repository's Security tab.
- Email [leo@social-sdk.dev](mailto:leo@social-sdk.dev) with "Security" in the subject.

Include:

- the package version and runtime (Node.js or Bun, and its version)
- the adapter, backend, or CLI command involved
- the steps or smallest code sample that shows the problem
- what an attacker could do with it

Leave out real access tokens, refresh tokens, OAuth codes, webhook secrets, signed URLs, and private account or message data. If a token was exposed while you found the problem, revoke it with the platform first.

## What happens next

We aim to confirm receipt within a few business days. We then confirm or rule out the issue, agree a disclosure date with you, and ship a fix in a release whose changelog entry credits you unless you prefer otherwise. Please keep the details private until that release is out.

## Scope

In scope: the `@opencoredev/social-sdk` package, its CLI, and the code in this repository. That includes authorization bypasses, such as one tenant reaching another tenant's connected accounts, even when the attacker holds valid credentials of their own.

Out of scope: vulnerabilities in the social platforms or managed providers themselves (report those to the provider), and actions a credential already legitimately allows. For how the SDK expects credentials, authorization, and webhooks to be handled, see the [security reference](https://social-sdk.dev/docs/reference/security).
