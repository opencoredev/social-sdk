---
"@opencoredev/social-sdk": patch
---

Instagram now sends correct hashtag requests, follows Tags cursors, resumes Reel and Story publishing, maps carousel share-to-feed choices, and validates image alt text. Business discovery requests public fields, and capability declarations match each login flavor's scopes and availability. The guide explains authorization, durable publishing, webhook formats, and hashtag pagination. Existing callers need no changes.

Confirmed Instagram publications retain their published post reference and workflow delivery even when the final workflow save fails. The `PUBLISHED_WORKFLOW_SAVE_FAILED` backend state explicitly signals that storage needs reconciliation. Repair the stored workflow from that outcome instead of repeating publication.
