---
"@opencoredev/social-sdk": patch
---

Every JavaScript entry point in the package `exports` map (every subpath except `./package.json`, which exports the package metadata file) now has a `default` condition after `import`, pointing at the same ES module. Tools that resolve through `default` instead of `import` no longer fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The package is still ESM-only; there is no CommonJS build.
