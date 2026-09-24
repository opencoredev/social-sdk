---
"@opencoredev/social-sdk": patch
---

`social-sdk validate` decodes the JSON publish request before preparing it instead of casting it.

- A structurally malformed request now exits 2 with a message naming the field path, such as `Invalid publish request: targets[0].account.kind must be "connected-account".` Values are never echoed. This covers a wrong account or reply reference kind or version, non-string text or identifiers, `null` in optional fields, non-object `options`, and media or thumbnails with an unsupported kind. Some of these previously reached `prepare` and exited 1 with a diagnostic issue.
- Semantic problems such as an empty target list, an unknown backend, or a past schedule still exit 1 with preparation issues.
