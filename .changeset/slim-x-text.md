---
"@opencoredev/social-sdk": patch
---

Check X's weighted post length with a built-in counter instead of `twitter-text`. The package now has no runtime dependencies, so installs no longer pull in the deprecated `core-js@2`. Source maps and declaration maps are no longer published; they pointed at source files that were never in the package.
