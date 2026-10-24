---
"@opencoredev/social-sdk": minor
---

Add injected SQL and Redis stores for connections, credentials, refresh locks, and publication idempotency. Add AES-256-GCM credential encryption, expiry-aware credential resolution, and Web Request/Response OAuth and Meta callback handlers.

Publication results now report warnings when an idempotency outcome cannot be persisted. Applications can also receive a sanitized diagnostic callback while keeping the provider's known delivery outcome.

Durable storage and encryption keys remain application-owned. Existing memory stores and direct OAuth providers remain available. No database driver, Redis client, hosted service, or live endpoint is required by the package.

Migration: `CredentialManager.rotate` now persists refresh progress and applies the configured refresh deadline. An uncertain failure blocks another rotation until the application reconnects or explicitly saves a reconciled credential. Custom credential codecs must retain `refreshState`. Custom stores used with `CredentialManager.revoke` must implement the optional atomic `deleteIfRevision` method; revocation fails before contacting the provider when it is unavailable. The included memory, durable, and supported encrypted stores provide this operation.
