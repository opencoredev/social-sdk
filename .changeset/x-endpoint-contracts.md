---
"@opencoredev/social-sdk": patch
---

X now validates endpoint-specific pagination and authentication, requests supported list-member fields, preserves timeline and message expansions, and reads current and legacy metric fields. Conversation messages may contain only an attachment. Pinned-list reads reject pagination options that the endpoint does not support.

Post video uploads now accept up to 16 GiB locally, subject to X's account-specific attachment limits. Image uploads use the same error handling as other media. Interrupted APPEND, FINALIZE, and STATUS requests retain the media ID for reconciliation; normalized failed or unknown publish outcomes expose the opaque upload ID as `mediaId`; usage caps retain terminal billing instructions. Omit pagination options for pinned-list reads and reconcile interrupted uploads before starting another. Stream connection interruptions expose `stream-connection-interrupted` as their upstream code. Stream examples reconnect after transient interruptions while stopping on malformed responses, billing, or authorization failures. Headerless stream rate limits advise a one-minute delay. Video examples hash incrementally, use a file-backed Blob, and configure an explicit elapsed budget for large uploads.
