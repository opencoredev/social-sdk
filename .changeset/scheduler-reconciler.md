---
"@opencoredev/social-sdk": minor
---

Add `SocialScheduler`, `ScheduleStore`, `MemoryScheduleStore`, and key-value store adapters for
durable scheduled publications and sequences, exported from the root and `/server`. Jobs resolve
UTC instants, IANA local times, and queue slots, reject skipped daylight-saving times, and avoid
duplicate slots. `runDue` claims jobs with compare-and-set leases, submits early to routes that
declare native scheduling, runs per-destination reply chains only under published parents, and
recovers interrupted steps from their idempotency claim instead of resending them. Cancellation and
rescheduling require provider confirmation before native posts count as withdrawn.

Add `posts.reconcile`, `posts.retryFailed`, and `posts.authorize` to the client, plus
`OutcomeReconciler`. Recovery takes the full original request, saves validated poll results into
the original idempotency claim, and re-sends only destinations whose outcome proves nothing is live.

`IdempotencyStore` gains an optional `compareAndSetOutcome`. Existing stores still compile;
recovery requires it and fails with `invalid_config` without it. Configure it for scheduler recovery.
`MemoryIdempotencyStore` implements it, and `createKeyValueIdempotencyStore` provides a durable one.
The mock backend's processed deliveries now return a well-formed `platform-post` reference.

Optional `createSocial({ jobRunner })` wake hooks are inherited by the scheduler. Scheduler reads
and mutations reauthorize callers, retries persist unique attempt identities, and worker claims
use distinct lease tokens. The generic KV schedule adapter uses bounded authoritative scans
(10,000 records by default); larger queues can supply an indexed `ScheduleStore`.
