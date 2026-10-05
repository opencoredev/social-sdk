---
"@opencoredev/social-sdk": patch
---

Cancel caption response streams when a download times out or is aborted, including responses arriving after the deadline. Return the selected YouTube channel before validating unused next-page tokens, and stop unresolved account lookups after 100 pages.

Preserve existing video tags during unrelated edits and stop reply lookup when the provider repeats a page token.

Reject caption updates locally when they supply neither replacement media nor an explicit draft-status change.
