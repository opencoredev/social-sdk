---
"@opencoredev/social-sdk": minor
---

`SocialEvent["type"]` gains `reaction.removed`, and its union no longer lists `reaction.received` twice. Facebook Page `feed` deliveries with `item: "reaction"` now decode as `reaction.received` for `verb: "add"` and `reaction.removed` for `verb: "remove"`; before, both were `unknown`. `originalType` is unchanged (`feed.reaction.add`, `feed.reaction.remove`), so routing on it keeps working. A changed reaction (`feed.reaction.edit`) stays `unknown`. If you switch exhaustively over `SocialEvent["type"]`, add a `reaction.removed` case.
