---
"@opencoredev/social-sdk": patch
---

Every subpath in the package `exports` map now has a `default` condition after `import`, pointing at the same ES module. Tools that resolve through `default` instead of `import` no longer fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is still ESM-only; there is no CommonJS build.
