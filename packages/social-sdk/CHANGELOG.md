# @opencoredev/social-sdk

## 0.6.0

### Minor Changes

- 9a02d09: Managed backends now reject requests that could publish with unintended privacy, use expired media, or lose delivery information. PostFast rejects private TikTok Direct Posts, keeps explicit interaction and disclosure choices, selects ordinary YouTube videos, and limits schedules to one year. Zernio protects post retries with the provider's idempotency key, preserves duplicate-create delivery references through the public publishing facade, reports destination-specific cancellation and publication times, and requires reconciliation for unconfirmed comment or message writes.

  Post for Me checks account ownership before reporting pending delivery, retains public feed media, and reads X reposts and Facebook reactions and views correctly. Its uploaded media expires after 24 hours and can be submitted only once. Postiz keeps confirmed acceptance when a status read fails and rejects unsupported image types, storage paths, and custom thumbnails.

  Migration: Discard older persisted Post for Me uploads and upload fresh media for each submission; caller-owned HTTPS URLs remain reusable. Custom media stores must implement `claimSingleUse(mediaId, claimedAt)` as a durable atomic operation that rejects expired or consumed records and saves consumption before dispatch across all processes sharing the store. Use supported Postiz assets instead of AVIF, BMP, TIFF, or custom thumbnails, or choose another backend.

- b737f77: Bluesky now enforces the 2,000,000-byte image limit, preserves declared image types and dimensions, validates quote and reply text, and retains balanced parentheses in links. Quote validation errors identify the quote operation. Author feeds preserve nested quotes and supported nested embeds, facets, labels, reply references, and repost information while omitting fields outside the public allowlist. List edits check the version read before writing and clear obsolete annotations when descriptions change. Connection checks now use authenticated account status, and native reads default to one attempt.

  OAuth requests now require an egress policy and an address-pinned transport. Nonce challenge inspection has a timeout and observes caller cancellation while preserving the original response. Authenticated account reads retain the handle verified in the OAuth session and fall back to the DID when that handle is absent, ignoring unverified configured handles. Nonce failures retain response evidence for reconciliation, and failed session saves trigger one best-effort revocation. The guide explains saved connections, video, chat, lists, deletion, and notifications, including the transitional chat scope dependency.

  Migration: Supply both `assertEgressAllowed` and an address-pinned `fetch` for connection, refresh, and resource requests. Use canonical OAuth URL authorities without explicit default HTTPS ports; hostname case and non-default redirect ports remain supported. Replace explicit link cards with URLs in post text. Set retry limits explicitly when native reads need more than one attempt.

- d6bd057: TikTok publishing options now require explicit `aiGenerated` and `draft` booleans, matching the existing preparation checks.

  Migration: Add both fields to every `TikTokPublishOptions` value. Take the choices from the creator preview, using `draft: false` for Direct Post or `draft: true` for inbox transfer.

- 1f181a1: LinkedIn replies now accept activity, share, and ugcPost comment references. A comments-collection 404 returns an empty page only after a fresh parent-post check confirms the post is still readable; a deleted post returns `not_found`. Capability declarations use author-specific social-feed and parent-post read permissions and identify unimplemented article, profile-edit, and partner messaging operations.

  Organization reports keep total page-view keys unchanged and now return nested unique counts under dotted keys such as `allPageViews.uniquePageViews`. Custom-button click arrays and their dimensions are kept in `rawClicks`, also on breakdown rows. Reports forward supported report queries and reject unsupported filters. Image uploads validate size before initialization, honor the operation deadline and report expired uploads as `timeout`, and enforce single-image alt-text limits. Image-storage rate limits return `rate_limited` and preserve valid `Retry-After` delays without automatically retrying uploads.

  Migration: Read nested unique page-view counts from the dotted keys (for example `allPageViews.uniquePageViews`) instead of the parent key. Use `DAY` or `MONTH` for page and share report intervals; `WEEK` remains supported for follower statistics. Grant member or organization social-feed permissions for comments (both feed read and write grants for replies), plus the separate post-read permission needed for the parent check.

- 2042ce8: Add a Postiz managed backend at `@opencoredev/social-sdk/cloud/postiz`. It works with Postiz Cloud and with self-hosted instances through `baseUrl`. It lists connected channels, uploads media, publishes now or on a schedule, reads delivery state, cancels scheduled posts, deletes failed or draft records, reads post analytics, and creates connect links through `native.createConnectLink`. `postizAuthorizationUrl` and `exchangePostizCode` let your server connect other people's Postiz workspaces through your own Postiz OAuth app; the returned `pos_` token is used as the adapter's `apiKey`. The offline CLI diagnostics recognize the `postiz` adapter and `POSTIZ_API_KEY`.
- f42a964: X graph, deletion, and native engagement writes now require provider confirmation before reporting completion. Pending follows and malformed or unconfirmed responses require reconciliation before another attempt.

  Migration: Inspect confirmation flags on native write responses. Reconcile pending or unconfirmed results with X before retrying instead of assuming the write completed.

### Patch Changes

- 728de14: Replies can now target another author's post on the acting account's backend and platform. The SDK still authorizes the acting account, and each adapter validates the parent post. Existing callers need no changes.
- 728de14: Delivery reconciliation now rejects references with an unsupported kind or version before authorization or provider requests. Pass a delivery reference returned by the SDK when checking an outcome.
- 728de14: Instagram OAuth now accepts granted permissions as either comma-separated text or an array and keeps those permissions when long-lived token exchange omits them. Existing connection code needs no changes.
- 728de14: Instagram publishing now uses the professional account ID when discovery also returns an app-scoped ID. Token identity checks accept either discovered ID. Existing connection code needs no changes.
- 728de14: Instagram Login comment and live-comment webhooks now normalize to `comment.received` when their fields appear directly on entries. Facebook Login's nested change format remains supported. Existing webhook handlers need no changes.
- 728de14: Instagram and Threads token refresh now retains granted scopes when the provider omits them, while honoring explicitly returned scopes. OAuth response readers cancel stalled streams on timeout or caller cancellation without waiting for stream cleanup. The Postiz polling example returns drafts immediately because they need scheduling before publication.
- 728de14: Zernio webhook decoding now reports a missing event ID as invalid input instead of an authentication failure. Handle this as a malformed delivery rather than a reason to change signing credentials.
- 728de14: YouTube OAuth account discovery now reads all channel pages, requesting up to 50 channels per page. Repeated page tokens and traversal beyond 100 pages fail instead of returning an incomplete account picker. Pass the optional OAuth `signal` to cancel token requests and discovery; existing callers need no changes.
- 87d1887: Instagram now sends correct hashtag requests, follows Tags cursors, resumes Reel and Story publishing, maps carousel share-to-feed choices, and validates image alt text. Business discovery requests public fields, and capability declarations match each login flavor's scopes and availability. The guide explains authorization, durable publishing, webhook formats, and hashtag pagination. Existing callers need no changes.

  Confirmed Instagram publications retain their published post reference and workflow delivery even when the final workflow save fails. The `PUBLISHED_WORKFLOW_SAVE_FAILED` backend state explicitly signals that storage needs reconciliation. Repair the stored workflow from that outcome instead of repeating publication.

- 728de14: Provider failures now retain bounded, validated recovery information without exposing provider prose or raw bodies. Zernio post conflicts return a safe existing-post ID or a delay for a request still in progress. Google quota errors return `rate_limited`; X usage caps return `billing_required` with no retry, including during media processing, and recognized X video-duration failures return `media_error`. TikTok rejection bodies are byte-limited and cancelled on size limits or deadlines. Unknown failures keep status-based handling, and writes are never automatically replayed.

  YouTube account lookup now continues through channel pages until it finds the configured channel, with repeated-page and traversal guards. Sequence guidance distinguishes returned outcomes from thrown failures. Inspect error codes and retry instructions, and reconcile uncertain writes before submitting again.

- b58dfc8: The npm README now links to the hosted documentation, installation guide, capability matrix, and CLI reference. It also shows how to run the local `social-sdk` command with `npm exec` or `bun run`. Existing SDK callers need no changes.
- 4c13c8e: Threads now uses correct reply IDs and pagination, requests supported post metrics, and reports account clicks from link totals. Carousels accept up to twenty items, videos accept MOV, and text validation counts emoji as UTF-8 bytes. Reply permission declarations now include the publishing scope. Grant `threads_content_publish` alongside `threads_basic` when sending replies.
- d6bd057: TikTok now preserves HTTP 429 and validated provider codes, caps rate-limit delays, and never automatically repeats publishing requests. Rejection bodies are byte-limited and cancelled when oversized or interrupted; a stalled body keeps an already-received HTTP 429 rejection. Structured rate-limit responses honor valid Retry-After headers within the same delay cap. Cancelling a read during its retry wait preserves the cancellation result. Branded Direct Posts reject private visibility, photo posts honor refreshed comment restrictions, missing field scopes produce permission errors, and metrics fail when the requested video is absent.

  The guide clarifies creator previews, drafts, scopes, media transfer, and delivery status. Use fresh creator choices and inspect per-destination outcomes before retrying uncertain submissions.

- 90f0e59: Requests now work on Cloudflare Workers. The SDK sends `redirect: "manual"` instead of `redirect: "error"`, which workerd rejects, and still refuses redirects: a 301, 302, 303, 307 or 308 response fails the request as before. The one exception is YouTube resumable uploads, which now receive the provider's `308 Resume Incomplete` response (a 308 without a `Location` header) with the built-in `fetch` in Node.js and Bun. Existing callers need no changes; a custom `fetch` now sees `redirect: "manual"`.
- f42a964: X now validates endpoint-specific pagination and authentication, requests supported list-member fields, preserves timeline and message expansions, and reads current and legacy metric fields. Conversation messages may contain only an attachment. Pinned-list reads reject pagination options that the endpoint does not support.

  Post video uploads now accept up to 16 GiB locally, subject to X's account-specific attachment limits. Image uploads use the same error handling as other media. Interrupted APPEND, FINALIZE, and STATUS requests retain the media ID for reconciliation; normalized failed or unknown publish outcomes expose the opaque upload ID as `mediaId`; usage caps retain terminal billing instructions. Omit pagination options for pinned-list reads and reconcile interrupted uploads before starting another. Stream connection interruptions expose `stream-connection-interrupted` as their upstream code. Stream examples reconnect after transient interruptions while stopping on malformed responses, billing, or authorization failures. Headerless stream rate limits advise a one-minute delay. Video examples hash incrementally, use a file-backed Blob, and configure an explicit elapsed budget for large uploads.

- f42a964: X video and GIF uploads now use 4 MiB segments. This keeps the full 16 GiB local video limit within X's APPEND segment range. Existing callers need no changes; account-specific attachment size and duration limits still apply.
- 8682b7a: YouTube now checks comment-reply and video-deletion ownership, uses correct playlist update IDs and parts, and sends supported video, subscription, and live-broadcast fields. Caption replacement and downloads are bounded, resumed uploads and status checks honor the operation deadline, descriptions reject angle brackets, and channel upload caps return quota errors.

  Video updates support writable snippet and status fields. Set optional fields to `null` to clear them while keeping title and categoryId present. Playlist writes replace only supplied parts. The guide includes OAuth setup, operation scopes, quota rules, and complete native examples.

- 8682b7a: Cancel caption response streams when a download times out or is aborted, including responses arriving after the deadline. Return the selected YouTube channel before validating unused next-page tokens, and stop unresolved account lookups after 100 pages.

  Preserve existing video tags during unrelated edits and stop reply lookup when the provider repeats a page token.

  Reject caption updates locally when they supply neither replacement media nor an explicit draft-status change.

  Reject unsupported caption-update metadata instead of silently discarding it, and honor the caller's remaining elapsed budget for upload status probes. Clarify how to persist credentials and grant access only for the selected YouTube channel.

- 8682b7a: YouTube replies now find their parent through video-filtered comment-thread pages and match the top-level comment ID, rather than using the legacy thread-ID filter. The guide clarifies default search quota and the cost of each page request. Existing callers need no changes.

## 0.5.0

### Minor Changes

- 59fd2f7: Add a PostFast managed backend at `@opencoredev/social-sdk/cloud/postfast`. It lists connected accounts, uploads media, schedules posts, reads delivery state, cancels scheduled posts, deletes failed records, reads post analytics, and creates connect links through `native.createConnectLink`. PostFast only accepts scheduled posts, so every target needs a future `schedule`. The offline CLI diagnostics recognize the `postfast` adapter and `POSTFAST_API_KEY`.

## 0.4.0

### Minor Changes

- 01971d4: Add AT Protocol OAuth for Bluesky to `@opencoredev/social-sdk/server`. `blueskyOAuth` works with `ConnectionManager` and handles handle and DID resolution, PDS and authorization server discovery, pushed authorization requests, PKCE, DPoP-bound tokens, the `iss` callback check, and identity verification. If the token response fails validation or identity verification fails after tokens are issued, it makes one best-effort request to revoke them when the authorization server advertises a revocation endpoint. Every request is checked against an HTTPS-only egress guard that rejects `localhost` and non-public IP-literal hosts, handle redirects are followed manually for at most three hops, and an optional `assertEgressAllowed` hook lets servers add DNS-aware checks. Authorization server responses without a `DPoP-Nonce` header are rejected. `blueskyOAuthClientMetadata` publishes only EC P-256 public keys and rejects private or symmetric key material. `blueskyOAuthTransport` turns a stored session into the Bluesky adapter's `session`, and `refreshBlueskyOAuthSession` refreshes it with rotated refresh tokens. `blueskyOAuthClientMetadata`, `blueskyOAuthPublicJwk`, `blueskyLoopbackClientId`, and `parseBlueskyOAuthSession` cover client metadata and stored sessions. No runtime dependencies are added.

  `ConnectionManager.begin` and `ConnectionProvider.start` accept an optional `loginHint`. A provider can set `providerStateSecret: true` on its `start` result to keep `providerState` out of the attempt that `begin` returns. The Bluesky provider does this because its state holds the DPoP private key. Other providers still return `providerState` as before.

- e711a88: Add Bluesky video publishing. `media.upload` sends an MP4 to the Bluesky video service and returns a media reference that holds the processing job ID. The new `native.getVideoJobStatus` and `native.getVideoUploadLimits` operations read job state and daily limits, so the caller controls polling. `posts.publish` with the video reference reads the job once and writes an `app.bsky.embed.video` record when processing is complete. If the job is still processing, the target fails with `media_error` and no post is created. The new `pdsDid` and `videoService` options set the upload token audience and the video service origin.
- bcc36a3: Add native `deleteComment` and a `comments.delete` capability to the YouTube, Threads, Bluesky, X, and LinkedIn adapters. X, Threads, and Bluesky can only delete the authenticated account's own replies. YouTube and LinkedIn follow each platform's permission checks.
- bcc36a3: Add native reply hiding for X and Bluesky, and declare `comments.moderate` for LinkedIn.

  - X: `native.hideReply({ account, replyId, hidden, context })` calls `PUT /2/tweets/{id}/hidden` with a user-context token and returns the hidden state X reports.
  - Bluesky: `native.hideReply({ account, replyUri, hidden, context })` adds or removes the reply in the root post's threadgate `hiddenReplies` list. It creates a threadgate without reply rules when none exists and updates an existing one with `swapRecord`.
  - LinkedIn: `comments.moderate` is declared `unsupported-by-platform` because the Comments API has no hide operation.

- bd91f18: Verify and decode webhooks sent directly by Instagram, Threads, X, YouTube, TikTok, and LinkedIn. `@opencoredev/social-sdk/server` adds `verifyMetaWebhook`, `verifyXWebhook`, `verifyYouTubeWebhook`, and `verifyTikTokWebhook` for signed POST deliveries, `answerMetaWebhookChallenge`, `answerXWebhookChallenge`, and `answerYouTubeWebhookChallenge` for the GET handshakes, and `decodePlatformWebhook` for normalized events. The five direct adapters accept a `webhookSecret` option and declare `webhooks.verify`. `VerifiedWebhook.signedTimestamp` is now a `boolean` and may include `signedAt`, and `SocialEvent.provider` includes the direct platform names. LinkedIn deliveries use `verifyLinkedInWebhook` and `answerLinkedInWebhookChallenge`, the LinkedIn adapter accepts `webhookSecret`, and it declares `webhooks.verify` as `approval-dependent` because LinkedIn enables webhooks only for approved apps. The Bluesky adapter declares `webhooks.verify` as `unsupported-by-platform` because Bluesky has no webhooks.
- d567532: Instagram `mentions.read` now works with Instagram Login. `listMentions`, `mentions`, and `listTaggedMedia` read `GET /{ig-user-id}/tags` on `graph.instagram.com` with `instagram_business_basic` and `instagram_business_manage_comments`, and the capability manifest declares `mentions.read` as available for both login flavors. `mentionedMedia` and `mentionedComment` still require Facebook Login and now raise a clearer `unsupported_capability` error with Instagram Login.
- 7ea7d23: Add `accounts.list` and `accounts.get` to the direct LinkedIn adapter. A member author reads the OpenID Connect `userinfo` endpoint (`openid` and `profile` scopes) and must match `urn:li:person:{sub}`. An organization author reads `/rest/organizations/{id}`, which needs `rw_organization_admin` and an approved `ADMINISTRATOR` role. A `403` reports `missing_permission` with the required scopes, and a mismatched identity reports `unauthorized`. The native module adds `listAdministeredOrganizations`, which pages through the member's approved administrator roles from `organizationAcls`.
- f2137e6: Add LinkedIn document posts. `social.media.upload` now accepts a `document` attachment (PDF, PPT, PPTX, DOC or DOCX, up to 100 MB) for the LinkedIn adapter and uploads it through the Documents API. A publish request with one uploaded document creates a document post after the adapter confirms the document is owned by the configured author and `AVAILABLE`. The title comes from the attachment `caption` or `filename`. The LinkedIn native module adds `documentStatus`, which returns `id`, `owner` and `status` without the signed download URL. `posts.document` is now `available` in the LinkedIn manifest.

  `MediaAttachment.kind` and the capability `formats` union gain `"document"`. Code that switches exhaustively on `MediaAttachment["kind"]` needs a `document` branch. Other adapters reject document attachments.

- f2137e6: Add LinkedIn multi-image posts to the direct adapter. `posts.publish` now accepts 2 to 20 uploaded image references and sends them as Posts API `multiImage` content, with optional per-image alt text. Preparation rejects more than 20 images and multi-image alt text over 4,086 characters. Before the post is created, every image is checked for author ownership and `AVAILABLE` status, and no post is created if any check fails. A single image still uses `content.media`. The `posts.multi-image` capability is now `available`, and `posts.publish` advertises the `carousel` format.
- 7ea7d23: Add `notifications.read` for LinkedIn organization accounts. `social.notifications.list` and `iterate` pull organization social-action notifications from `organizationalEntityNotifications` with offset paging. Member accounts declare the capability as `account-ineligible`, and `notifications.seen` is `unsupported-by-platform` because LinkedIn has no seen state.

  X, Threads, Instagram, YouTube, and TikTok now declare `notifications.read` as `unsupported-by-platform` with a reason, since none of their official APIs offers a notifications feed. Calls still raise `unsupported_capability` as before.

- f2137e6: Add LinkedIn video posts. `media.upload` now accepts one MP4 Blob (75 KB to 500 MB), uploads the parts LinkedIn returns, and finalizes the video without waiting for processing. The new native `videoStatus` helper reads the processing status once per call, and the opt-in native `waitForVideo` helper rereads it at a fixed interval, bounded by a check limit, the operation's elapsed budget, and its abort signal. Publishing reads the status once and creates a post only when the video is `AVAILABLE`; a video that is still processing returns a `failed` outcome with an `after-delay` retry disposition and no post. A non-blank attachment `caption` is sent as the optional video title. The native `registerVideo` method is deprecated and still throws `unsupported_capability`.
- e711a88: Add `updatePost` to the X native module. It edits the text of a recent post through `POST /2/tweets` with `edit_options.previous_post_id` and returns a reference to the new version, since X assigns each edit a new post ID. A response without a new ID, or a server failure after dispatch, raises `ambiguous_outcome` with `reconcile-first`. The X manifest now declares `posts.update` as available. Threads, Bluesky, Instagram, and TikTok declare `posts.update` as `unsupported-by-platform`, with the documented reason in each manifest entry.
- bcc36a3: Add `comments.list` to the direct X adapter. It lists replies to a post through recent search with `conversation_id:<postId>`, pages with X's `next_token`, and drops the root post. X recent search limits apply: replies from the last 7 days only, page limits from 10 through 100, and a user token with `tweet.read` and `users.read` or an app bearer token. The X capability manifest now declares `comments.read`.
- d567532: Add X filtered stream support. The X native module now exposes `stream`, an async iterable over `GET /2/tweets/search/stream` that opens one connection per iteration, stops on `break` or `context.signal`, raises `timeout` when no data or keep-alive arrives within `stallTimeoutMs`, and never reconnects on its own. `listStreamRules`, `addStreamRules`, and `deleteStreamRules` manage filtered-stream rules, with `dryRun` support and per-rule errors preserved. All four use the app-only `appBearerToken`. The `streams.read` capability for X is now `available`.
- c4cefa8: Add `posts.cancelScheduled` to the direct YouTube adapter. It reads the video, confirms it is private with a future `status.publishAt`, then calls `videos.update` with `part=status` to clear `publishAt` while resending the other status fields it read. The video stays uploaded and private and is not deleted, so the result is `{ state: "cancelled", backendRecord: "retained" }`. The call needs the `https://www.googleapis.com/auth/youtube` scope and costs 51 quota units. A lost or unconfirmed update raises `ambiguous_outcome` with `reconcile-first`.

  Scheduled YouTube uploads now report the `scheduled` outcome with a `job` reference (the video ID) instead of `processing` or `published`, so a caller can pass it to `posts.cancelScheduled`. `getDelivery` reports `published` once the publish time has passed and the video is processed. Code that treated a scheduled YouTube upload's `published` state as success should check for `scheduled` too.

- c4cefa8: Add `profile.update` for YouTube through `native.updateProfile`, which writes a channel's `brandingSettings.channel` fields or `localizations` with `channels.update`. The adapter reads the current part first and merges your fields, because YouTube deletes omitted properties; a `null` field removes a property or localization.

  Declare `profile.update` for the other direct adapters: `unsupported-by-platform` for X, Threads, Instagram, and TikTok, which have no documented profile write, and `approval-dependent` for LinkedIn, whose Profile Edit API is limited to approved developers and is not implemented.

### Patch Changes

- 0b03bf4: `social-sdk validate` decodes the JSON publish request before preparing it instead of casting it.

  - A structurally malformed request now exits 2 with a message naming the field path, such as `Invalid publish request: targets[0].account.kind must be "connected-account".` Values are never echoed. This covers a wrong account or reply reference kind or version, non-string text or identifiers, `null` in optional fields, non-object `options`, and media or thumbnails with an unsupported kind. Some of these previously reached `prepare` and exited 1 with a diagnostic issue.
  - Semantic problems such as an empty target list, an unknown backend, or a past schedule still exit 1 with preparation issues.

- c4cefa8: Declare `posts.schedule` in the X, Threads, Bluesky, Instagram, TikTok and LinkedIn capability manifests. None of these publishing APIs holds a post for later publication, so the direct adapters keep rejecting `schedule` during preparation. X is marked `not-implemented-by-adapter` because its only scheduler is the separate Ads API; the others are `unsupported-by-platform`. Behavior is unchanged.
- cf68a4f: Fix Blob uploads, Threads profile lookup field handling, and Instagram media deletion behavior.
- 0b03bf4: Decode provider responses and publish options as JSON at the adapter boundary instead of casting them.

  - `YouTubeNative.resumeUpload` and `queryUpload` now return `Promise<YouTubeUploadStatus>`, and `YouTubeUploadStatus.video` is a `JsonObject`.
  - `stableSerialize` and `fingerprint` are generic over their input instead of taking `unknown`. Existing calls compile unchanged.
  - Native publish options that are not JSON (functions, symbols, bigints, `NaN`, `Infinity`, class instances such as `Date`, or cycles) are rejected with an `invalid-response` error instead of being passed through or silently changed by serialization.
  - LinkedIn `organizationAnalytics` throws `invalid-response` on an empty upstream body instead of returning `null`.
  - Threads `comments.list` skips entries that are not objects.

- c4cefa8: Declare Threads `profiles.search` and `graph.read` as `unsupported-by-platform` in the capability manifest, with notes explaining why. Threads profile discovery only matches an exact username (already covered by `profiles.read`), and the Threads API has no followers or following list endpoint. The client already rejected these calls with `unsupported_capability`; the manifest now states the platform reason instead of omitting them.
- f2137e6: Uploads of streams without a declared size now fail with `invalid-response` when storage answers before the stream ends, instead of reporting a partial upload as complete. Bluesky preparation rejects document attachments, and LinkedIn rejects a video status read that returns a different video.
- c4cefa8: Declare X `posts.schedule` as `not-implemented-by-adapter` and `profile.update` as `unsupported-by-platform` in the X capability manifest. The notes cite the X docs: X API v2 has no scheduling or profile write endpoint, and X Ads API scheduled Tweets require OAuth 1.0a, which this OAuth 2.0 adapter does not implement. The preparation message for a scheduled X target now says that X API v2 cannot schedule posts.

## 0.3.0

### Minor Changes

- 55993cd: Add X video and GIF chunked upload to the direct adapter. MP4 video (up to 512 MiB) and GIF (up to 15 MiB) Blobs upload via 1 MiB INIT/APPEND/FINALIZE segments with a bounded STATUS poll honoring `check_after_secs`. Chunk rejections (413) and failed processing surface as terminal `media_error`. Processing waits never outlast the operation budget, and cancellation reports `cancelled`. A 403 when attaching a video reports `missing_permission` with a message that names the possible duration limit. `posts.publish` accepts a single video or GIF per post and advertises the `video` format, and the native module adds `uploadVideo` and `uploadGif`.

## 0.2.1

### Patch Changes

- f4d5f8d: Check X's weighted post length with a built-in counter instead of `twitter-text`. The package now has no runtime dependencies, so installs no longer pull in the deprecated `core-js@2`. Source maps and declaration maps are no longer published; they pointed at source files that were never in the package.

## 0.2.0

### Minor Changes

- 38d1a8f: Add the platform features that were missing for launch. X gains user lookup, follower and following lists, likes, mute and block, lists and pinned lists, timelines, mentions, app-only bearer tokens, and working direct messages through both `social.messages` and native access. Bluesky gains follower lists, likes, actor search, lists, moderation reports, unblock, and unmute. Threads gains normalized search, profile reads, and reply hiding. Instagram gains comment hiding and deletion. YouTube gains playlist management, thumbnails, video updates and deletes, captions, subscriptions, search, and comment moderation. LinkedIn gains follower, page, and share statistics.

  Every implemented operation is now declared `available`, with tier, review, and enterprise requirements listed in `requiredScopes` and `notes`, so apps that hold the platform access can call it. Also fixes graph wiring, X search fields, empty result handling, the X DM endpoint, OAuth account persistence, webhook signature case handling, `publishSequence` outcomes, input validation, and the mock backend.

  `posts.removeFromPlatform` now works on X, Bluesky, Threads, Instagram (Facebook Login), YouTube, and LinkedIn. YouTube videos can be scheduled with `publishAt`. Webhook docs now use `verifyZernioWebhook` and `verifyPostForMeWebhook`.

  This release also fixes OAuth for X, TikTok, Instagram, and LinkedIn, Threads container publishing and replies, TikTok publishing states and video listing, YouTube chunked uploads and upload deadlines, Bluesky request headers and facets, X DM fields and follow authorization, Instagram delivery tracking and metrics, cloud backend pagination and analytics, rate-limit handling in the transport, and adapter error mapping in the client. `publishSequence` now checks every item before it starts, requires an `idempotencyKey`, reports thrown item errors with their index in `failures`, and stops a `replyToPrevious` chain when a parent was not published. Package builds now run on `prepack`, and the release workflow checks the built package before it publishes.

  Some features are now declared `not-implemented-by-adapter` because the adapter could not do them correctly: Bluesky video, X video and GIF uploads and filtered streams, LinkedIn multi-image, video, and document posts, and deletion and mentions on Instagram Login.

## 0.1.2

### Patch Changes

- 4b6b3b3: Document the supported Node.js and Bun runtimes in the package README.

## 0.1.1

### Patch Changes

- 75c6634: Run the CLI when invoked through the installed bin symlink. The entry guard now resolves the invoked path before comparing it to the module URL, so `social-sdk` from node_modules/.bin executes instead of exiting silently.

## 0.1.0

### Minor Changes

- dfb0234: Introduce the independent Social SDK prerelease, modular client contracts, deterministic testing backend, direct and managed social integrations, and server-side connection and event helpers. Replace the inherited documentation with Blume.
- dfb0234: Expand direct platform adapters with typed native parity operations for media, engagement, profiles, feeds, captions, playlists, analytics, and platform-specific publishing workflows. Capability manifests and platform documentation now record supported, gated, and unsupported operations.
