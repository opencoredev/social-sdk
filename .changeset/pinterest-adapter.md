---
"@opencoredev/social-sdk": minor
---

Add a direct Pinterest adapter at `@opencoredev/social-sdk/pinterest` (Pinterest API v5). `posts.publish` creates image Pins and carousels of 2 to 5 images from HTTPS URLs, or from JPEG and PNG Blobs as base64 with `imageBase64: true`, and video Pins from a Blob through the media upload flow. A video that is still processing returns a `processing` outcome that `posts.getDelivery` continues from a `PinterestWorkflowStore`. `posts.removeFromPlatform` deletes a Pin, `accounts.list` and `accounts.get` read the user account, and `native.listBoards` lists public and protected boards for the required `boardId` option. Set `sandbox: true` to use `api-sandbox.pinterest.com`, which cannot create video Pins. The CLI lists the adapter as `pinterest` for offline capability checks.
