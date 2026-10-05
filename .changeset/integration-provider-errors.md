---
"@opencoredev/social-sdk": patch
---

Provider failures now retain bounded, validated recovery information without exposing provider prose or raw bodies. Zernio post conflicts return a safe existing-post ID or a delay for a request still in progress. Google quota errors return `rate_limited`; X usage caps return `billing_required` with no retry, including during media processing, and recognized X video-duration failures return `media_error`. TikTok rejection bodies are byte-limited and cancelled on size limits or deadlines. Unknown failures keep status-based handling, and writes are never automatically replayed.

YouTube account lookup now continues through channel pages until it finds the configured channel, with repeated-page and traversal guards. Sequence guidance distinguishes returned outcomes from thrown failures. Inspect error codes and retry instructions, and reconcile uncertain writes before submitting again.
