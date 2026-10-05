---
"@opencoredev/social-sdk": patch
---

Instagram and Threads token refresh now retains granted scopes when the provider omits them, while honoring explicitly returned scopes. OAuth response readers cancel stalled streams on timeout or caller cancellation without waiting for stream cleanup. The Postiz polling example returns drafts immediately because they need scheduling before publication.
