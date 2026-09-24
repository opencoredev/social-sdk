---
"@opencoredev/social-sdk": patch
---

Declare Threads `profiles.search` and `graph.read` as `unsupported-by-platform` in the capability manifest, with notes explaining why. Threads profile discovery only matches an exact username (already covered by `profiles.read`), and the Threads API has no followers or following list endpoint. The client already rejected these calls with `unsupported_capability`; the manifest now states the platform reason instead of omitting them.
