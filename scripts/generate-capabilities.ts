import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { adapterNames, createDiagnosticAdapter } from "../packages/social-sdk/dist/cli.js";

// The same typed manifests that `social-sdk capabilities --adapter NAME --json` prints.
const manifests = [];

const implementationPaths = new Map<string, readonly string[]>([
  ["accounts.read", ["accounts.list", "accounts.get"]],
  ["posts.publish", ["posts.prepareTarget", "posts.publishTarget"]],
  ["posts.publish.preflight", ["native.creatorInfo"]],
  ["posts.read", ["posts.get"]],
  ["posts.list", ["posts.list"]],
  ["posts.status", ["posts.getDelivery"]],
  ["posts.cancelScheduled", ["posts.cancelScheduled"]],
  ["posts.deleteBackendRecord", ["posts.deleteBackendRecord"]],
  ["posts.removeFromPlatform", ["posts.removeFromPlatform"]],
  ["media.upload", ["media.upload"]],
  ["media.read", ["native.imageStatus", "native.videoStatus", "native.documentStatus"]],
  ["analytics.read", ["analytics.getPostMetrics"]],
  ["analytics.account.read", ["analytics.getAccountMetrics"]],
  ["analytics.report.read", ["analytics.getReport"]],
  ["search.posts", ["search.posts"]],
  ["comments.read", ["comments.list"]],
  ["comments.write", ["comments.reply"]],
  ["messages.write", ["messages.send"]],
  ["webhooks.verify", ["webhooks.verify", "webhooks.decode"]],
  ["posts.publish.video", ["posts.publishTarget"]],
  ["posts.repost", ["native.repostPost|native.repost"]],
  ["posts.quote", ["native.quotePost|native.quote"]],
  ["posts.delete", ["native.deletePost|native.deleteVideo"]],
  ["graph.read", ["graph.listRelationships"]],
  ["graph.follow", ["graph.follow|native.follow|native.followUser"]],
  ["graph.unfollow", ["graph.unfollow|native.unfollow|native.unfollowUser"]],
  ["graph.block", ["graph.block|native.block|native.blockUser"]],
  ["graph.unblock", ["graph.unblock|native.unblock|native.unblockUser"]],
  ["graph.mute", ["graph.mute|native.mute|native.muteUser"]],
  ["graph.unmute", ["graph.unmute|native.unmute|native.unmuteUser"]],
  ["notifications.read", ["notifications.list|native.listNotifications"]],
  ["notifications.seen", ["notifications.markSeen|native.markNotificationsSeen"]],
  ["profile.read", ["native.getProfile"]],
  [
    "profiles.read",
    ["graph.getProfile|native.getProfile|native.getUserById|native.businessDiscovery"],
  ],
  ["profiles.search", ["native.searchActors"]],
  ["profile.update", ["native.updateProfile"]],
  // Feed discovery is provider-specific: every adapter may expose a different native read,
  // while Bluesky intentionally conformance-tests all four feed routes in bluesky.test.ts.
  ["feeds.read", ["native.listFeeds|native.getTimeline|native.getFeed|native.getAuthorFeed"]],
  ["chat.read", ["native.listConversations", "native.listMessages"]],
  ["chat.write", ["native.sendMessage"]],
  ["polls.create", ["native.createPoll"]],
  ["bookmarks.read", ["native.bookmarks|native.getBookmarks"]],
  [
    "bookmarks.write",
    ["native.bookmark|native.createBookmark", "native.removeBookmark|native.deleteBookmark"],
  ],
  ["labels.read", ["native.queryLabels", "native.getLabelerServices"]],
  ["follows.write", ["native.follow", "native.unfollow"]],
  ["media.video", ["native.uploadVideo"]],
  ["media.gif", ["native.uploadGif"]],
  ["media.status", ["native.getVideoJobStatus"]],
  ["media.limits.read", ["native.getVideoUploadLimits"]],
  [
    "messages.read",
    ["messages.listConversations|native.listDirectMessages|native.listConversations"],
  ],
  ["streams.read", ["native.stream"]],
  ["search.keyword", ["native.search"]],
  ["mentions.read", ["native.mentions|native.listMentions"]],
  ["timelines.read", ["native.userPosts", "native.homeTimeline"]],
  ["likes.read", ["native.getLikes|native.likedPosts"]],
  ["likes.write", ["native.likePost|native.like", "native.unlikePost|native.unlike"]],
  ["lists.read", ["native.getList"]],
  ["lists.write", ["native.createList", "native.updateList", "native.deleteList"]],
  ["lists.pinned.read", ["native.pinnedLists"]],
  ["lists.pinned.write", ["native.pinList", "native.unpinList"]],
  ["messages.conversation.write", ["native.sendConversationMessage"]],
  ["messages.group.write", ["native.createGroupConversation|native.createGroupChat"]],
  ["moderation.report", ["native.createModerationReport|native.reportAbuse"]],
  ["comments.moderate", ["native.hideReply|native.moderateComment|native.commentsModeration"]],
  ["comments.delete", ["native.deleteComment"]],
  ["comments.replies.read", ["native.listCommentReplies|native.commentReplies"]],
  ["comments.create", ["native.commentThreads|native.createComment"]],
  ["videos.read", ["native.videos", "native.batchGetStats"]],
  ["channels.read", ["native.channels"]],
  ["reference.read", ["native.videoCategories", "native.i18n"]],
  ["videos.update", ["native.updateVideo"]],
  ["videos.delete", ["native.deleteVideo"]],
  ["videos.rate", ["native.rateVideo", "native.getRating"]],
  ["subscriptions.read", ["native.subscriptions"]],
  ["subscriptions.write", ["native.subscriptions"]],
  [
    "analytics.followers.read",
    ["native.getOrganizationFollowerStatistics", "native.getOrganizationFollowerCount"],
  ],
  ["analytics.page.read", ["native.getOrganizationPageStatistics"]],
  ["analytics.shares.read", ["native.getOrganizationShareStatistics"]],
  ["posts.draft", ["native.uploadDraft|native.createDraft"]],
  ["posts.status.poll", ["native.publishStatus"]],
  ["reels.publish", ["native.publishReel"]],
  ["stories.publish", ["native.publishStory"]],
  ["hashtags.search", ["native.hashtagSearch"]],
  ["publishing.limit.read", ["native.publishingLimit"]],
  ["thumbnails.write", ["native.setThumbnail"]],
  ["captions.read", ["native.captions"]],
  ["captions.write", ["native.captions"]],
  ["playlists.read", ["native.playlists"]],
  ["playlists.write", ["native.playlists"]],
  ["posts.schedule", ["posts.publishTarget"]],
  ["posts.update", ["native.updateVideo|native.updatePost"]],
  ["analytics.youtube.read", ["native.analytics"]],
  ["analytics.groups", ["native.analyticsGroups", "native.analyticsGroupItems"]],
  [
    "analytics.reporting.bulk",
    ["native.reportTypes", "native.reportingJobs", "native.reports", "native.downloadReport"],
  ],
  ["live.broadcasts", ["native.liveBroadcasts"]],
  ["live.streams", ["native.liveStreams"]],
  ["channel.banner.write", ["native.uploadChannelBanner"]],
  ["channel.watermark.write", ["native.watermarks"]],
  ["playlists.images.write", ["native.playlistImages"]],
  ["live.superChat.read", ["native.superChatEvents"]],
  ["live.chat.messages", ["native.liveChatMessages"]],
  ["live.chat.stream", ["native.liveChatStream"]],
  ["live.chat.moderators", ["native.liveChatModerators"]],
  ["live.chat.bans", ["native.liveChatBans"]],
  ["channel.sections.read", ["native.channelSections"]],
  ["channel.sections.write", ["native.channelSections"]],
  ["channel.activity.read", ["native.activities"]],
  ["posts.multi-image", ["posts.publishTarget"]],
  ["posts.video", ["posts.publishTarget", "media.upload", "native.videoStatus"]],
  ["posts.document", ["posts.publishTarget", "media.upload", "native.documentStatus"]],
  ["reactions.write", ["native.react"]],
  ["reshares.write", ["native.reshare"]],
  ["analytics.organization.read", ["native.organizationAnalytics"]],
  ["articles.create", ["posts.publishTarget"]],
  ["replies.own.read", ["native.listOwnReplies"]],
  ["posts.ghost.read", ["native.listGhostPosts"]],
  ["profiles.posts.read", ["native.profilePosts"]],
  ["locations.search", ["native.locationSearch", "native.getLocation"]],
  ["analytics.demographics.read", ["native.followerDemographics"]],
  ["tokens.debug", ["native.debugToken"]],
  ["posts.embed", ["native.oembed"]],
  ["posts.read.batch", ["native.getPosts", "native.getPost"]],
  ["social-metadata.read", ["native.getSocialMetadata"]],
  ["reactions.read", ["native.listReactions"]],
  ["reactions.delete", ["native.deleteReaction"]],
  ["comments.state.write", ["native.setCommentsState"]],
  ["comments.edit", ["native.editComment"]],
  [
    "analytics.member.posts.read",
    ["native.getMemberPostAnalytics", "native.getMemberVideoAnalytics"],
  ],
  ["analytics.member.followers.read", ["native.getMemberFollowerCount"]],
  ["analytics.brand.read", ["native.getBrandPageStatistics"]],
  ["analytics.shares.posts.read", ["native.getOrganizationPostStatistics"]],
  [
    "organizations.read",
    [
      "native.lookupOrganizations",
      "native.findOrganizationByVanityName",
      "native.listOrganizationBrands",
    ],
  ],
  ["organizations.roles.read", ["native.listOrganizationRoles"]],
  [
    "social.batch.read",
    ["native.getSocialMetadataBatch", "native.getSocialActionsBatch", "native.getComments"],
  ],
  ["reactions.get", ["native.getReaction", "native.getReactions"]],
  ["media.read.batch", ["native.mediaStatuses"]],
  ["mentions.resolve", ["native.resolveMemberVanityUrl"]],
  ["analytics.video.read", ["native.getOrganizationVideoAnalytics"]],
  [
    "events.write",
    [
      "native.createEvent",
      "native.updateEvent",
      "native.uploadEventBackgroundImage",
      "native.createEventPost",
    ],
  ],
  ["events.read", ["native.getEvent", "native.listEvents"]],
  [
    "organizations.authorizations.read",
    [
      "native.getOrganizationAuthorization",
      "native.getOrganizationAuthorizations",
      "native.findOrganizationAuthorizations",
    ],
  ],
  [
    "webhooks.subscriptions.write",
    ["native.subscribeOrganizationNotifications", "native.unsubscribeOrganizationNotifications"],
  ],
  ["webhooks.subscriptions.read", ["native.listOrganizationNotificationSubscriptions"]],
  // X native reads (SOC-37).
  ["posts.lookup", ["native.getPosts"]],
  ["posts.quotes.read", ["native.quotePosts"]],
  ["reposts.read", ["native.repostedBy", "native.reposts", "native.repostsOfMe"]],
  ["users.lookup", ["native.getUsers", "native.getUsersByUsernames"]],
  ["users.search", ["native.searchUsers"]],
  ["users.affiliates.read", ["native.affiliates"]],
  ["search.counts", ["native.countRecentPosts", "native.countAllPosts"]],
  [
    "bookmarks.folders",
    ["native.bookmarkFolders", "native.createBookmarkFolder", "native.bookmarksByFolder"],
  ],
  [
    "spaces.read",
    ["native.getSpace", "native.searchSpaces", "native.spacePosts", "native.spaceBuyers"],
  ],
  ["communities.read", ["native.getCommunity", "native.searchCommunities"]],
  ["trends.read", ["native.trends", "native.personalizedTrends"]],
  ["usage.read", ["native.postUsage", "native.creditBalance"]],
  ["media.lookup", ["native.getMedia"]],
  ["media.dm.upload", ["native.uploadDmMedia"]],
  [
    "media.subtitles",
    ["native.uploadSubtitles", "native.attachSubtitles", "native.deleteSubtitles"],
  ],
  ["analytics.private.read", ["native.privatePostMetrics"]],
  ["analytics.posts.read", ["native.postAnalytics"]],
  ["analytics.media.read", ["native.mediaAnalytics"]],
  ["messages.event.read", ["native.getDirectMessage"]],
  ["messages.delete", ["native.deleteDirectMessage"]],
  ["messages.media.read", ["native.downloadDmMedia"]],
  ["messages.block", ["native.blockDms", "native.unblockDms"]],
  ["bookmarks.bulk", ["native.bookmarkPosts"]],
  ["media.metadata", ["native.setMediaMetadata"]],
  ["streams.activity", ["native.activityStream"]],
  ["streams.volume", ["native.volumeStream"]],
  ["streams.compliance", ["native.complianceStream"]],
  [
    "compliance.jobs",
    [
      "native.createComplianceJob",
      "native.complianceJobs",
      "native.getComplianceJob",
      "native.uploadComplianceIds",
      "native.downloadComplianceResults",
      "native.cancelComplianceJob",
    ],
  ],
  [
    "notes.community",
    [
      "native.createCommunityNote",
      "native.evaluateCommunityNote",
      "native.deleteCommunityNote",
      "native.communityNotesWritten",
      "native.postsEligibleForNotes",
    ],
  ],
  ["news.read", ["native.searchNews", "native.getNews"]],
  [
    "chat.groups",
    [
      "native.initializeChatGroup",
      "native.createChatGroup",
      "native.getChatConversation",
      "native.updateChatGroup",
      "native.deleteChatConversation",
      "native.addChatMembers",
      "native.removeChatMembers",
      "native.setChatAdmins",
      "native.chatAdminRequests",
      "native.requestChatAdmin",
      "native.resolveChatAdminRequest",
      "native.updateChatAdminSettings",
      "native.enableChatInvite",
      "native.disableChatInvite",
      "native.getChatInvite",
      "native.requestToJoinChat",
      "native.rejectChatJoinRequests",
    ],
  ],
  [
    "chat.inbox",
    [
      "native.setChatArchived",
      "native.setChatMuted",
      "native.markChatRead",
      "native.sendChatTyping",
      "native.setChatMessageTtl",
      "native.setChatScreenCapture",
      "native.chatPinnedMessages",
      "native.deleteChatMessages",
      "native.chatMessageRequests",
      "native.getChatMessageRequest",
      "native.acceptChatMessageRequest",
      "native.chatSettings",
    ],
  ],
  [
    "chat.keys",
    ["native.addChatConversationKeys", "native.chatPublicKeys", "native.registerChatPublicKey"],
  ],
  ["chat.media", ["native.uploadChatMedia", "native.downloadChatMedia"]],
  [
    "live.x.broadcasts.user",
    [
      "native.userBroadcasts",
      "native.getUserBroadcast",
      "native.createUserBroadcast",
      "native.setUserBroadcastState",
      "native.deleteUserBroadcast",
      "native.userStreamSources",
      "native.getUserStreamSource",
      "native.createUserStreamSource",
      "native.renameUserStreamSource",
      "native.deleteUserStreamSource",
      "native.ingestRegion",
      "native.setBroadcastChatMute",
      "native.getScheduledBroadcast",
      "native.updateScheduledBroadcast",
    ],
  ],
  [
    "calls.manage",
    [
      "native.createCall",
      "native.getCall",
      "native.joinCall",
      "native.leaveCall",
      "native.scheduledCalls",
      "native.scheduleCall",
      "native.getScheduledCall",
      "native.updateScheduledCall",
      "native.cancelScheduledCall",
      "native.rsvpScheduledCall",
    ],
  ],
  [
    "bots.manage",
    [
      "native.bots",
      "native.createBot",
      "native.updateBot",
      "native.deleteBot",
      "native.rotateBotToken",
      "native.revokeBotToken",
    ],
  ],
  ["developer.account", ["native.developerAccount", "native.ensureDeveloperAccount"]],
  ["streams.rules.counts", ["native.streamRuleCounts"]],
  [
    "streams.webhooks",
    ["native.streamWebhooks", "native.linkStreamWebhook", "native.unlinkStreamWebhook"],
  ],
  ["streams.connections", ["native.streamConnections", "native.terminateStreamConnections"]],
  [
    "webhooks.manage",
    [
      "native.listWebhooks",
      "native.createWebhook",
      "native.validateWebhook",
      "native.deleteWebhook",
      "native.replayWebhook",
    ],
  ],
  ["articles.publish", ["native.createArticleDraft", "native.publishArticle"]],
  ["chat.encrypted", ["native.chatConversations", "native.chatEvents", "native.sendChatMessage"]],
  [
    "live.x.broadcasts",
    [
      "native.broadcasts",
      "native.scheduleBroadcast",
      "native.goLive",
      "native.endBroadcast",
      "native.streamSources",
      "native.createStreamSource",
      "native.broadcastChat",
      "native.sendBroadcastChat",
      "native.setChatModerator",
      "native.setChatMute",
    ],
  ],
  [
    "activity.subscriptions",
    [
      "native.createActivitySubscription",
      "native.listActivitySubscriptions",
      "native.updateActivitySubscription",
      "native.deleteActivitySubscriptions",
    ],
  ],
]);

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isCallable(value: unknown): value is CallableFunction {
  return typeof value === "function";
}

/** Native surfaces that ship from their own subpath instead of the adapter's `native` property. */
const nativeCompanions = new Map<string, () => object>([]);

const cell = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

function surface(entry: { readonly operation: string; readonly surface?: string }): string {
  if (entry.surface !== undefined) return entry.surface;

  const paths = implementationPaths.get(entry.operation);

  if (
    paths?.length &&
    paths.every((path) => path.split("|").every((candidate) => candidate.startsWith("native.")))
  )
    return "native";

  return "normalized";
}

const rows = [];

for (const adapter of adapterNames) {
  const instance = createDiagnosticAdapter(adapter);
  const companion = nativeCompanions.get(adapter)?.();
  const surfaces = companion === undefined ? instance : { ...instance, native: companion };
  const manifest = instance.capabilities;
  manifests.push({ adapter, manifest });

  for (const declaration of manifest.capabilities) {
    if (declaration.availability !== "available") continue;
    const paths = implementationPaths.get(declaration.operation);

    if (!paths)
      throw new Error(`No conformance mapping for available operation ${declaration.operation}`);

    for (const path of paths) {
      const found = path.split("|").some((candidate) => {
        let value: unknown = surfaces;

        for (const key of candidate.split("."))
          value = isObject(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

        return isCallable(value);
      });

      if (!found)
        throw new Error(
          `Adapter ${adapter} advertises ${declaration.operation} but has no ${path} method`,
        );
    }
  }

  for (const entry of manifest.capabilities)
    rows.push(
      `| ${cell(adapter)} | ${cell(entry.platform)} | ${cell(surface(entry))} | ${cell(entry.operation)} | ${cell(entry.availability)} | ${cell((entry.formats ?? []).join(", ") || "None declared")} | ${cell((entry.requiredScopes ?? entry.constraints?.scopes ?? []).join(", ") || "See adapter setup")} | ${cell((entry.constraints?.eligibility ?? []).join("; ") || "None declared")} | ${cell((entry.constraints?.approval ?? []).join("; ") || "None declared")} | ${cell((entry.constraints?.mediaSources ?? []).join(", ") || "None declared")} | ${cell(entry.notes ?? "None declared")} |`,
    );
}

const markdown = `---
title: Capability matrix
description: Read generated operation declarations for installed Social SDK adapters, including formats, backend routes, and scope guidance.
---

This table is generated from the same manifests used by local preparation and the diagnostic CLI. An available declaration describes an implemented route. It does not certify credentials, product approval, account eligibility or a successful live request. Read the platform/backend guide before enabling the operation. No adapter has live verification in this checkout.

An omitted operation is unsupported through the normalized API. Some operations need several permissions, and token/product restrictions can differ between member and organization accounts. The setup guide and current provider documentation determine the permissions for your account.

Surface is \`normalized\` for the SDK's portable facade and \`native\` for a provider-specific route. Eligibility, approval, scopes, and accepted media sources are constraints on a declaration; they do not prove that a particular account can use it.

Diagnostic manifests use one fixed setup per adapter: Instagram Login for Instagram and a member author for LinkedIn. Facebook Login deletion and organization-only analytics can therefore appear unavailable in this table. Create the adapter with your actual flavor or author to inspect its declarations.

The adapter ID below identifies the implementation, such as \`instagram\` or \`zernio\`. It is not your configured backend instance key: references use the key registered with \`createSocial\`, such as \`default\` or \`company\`.

| Adapter ID | Platform | Surface | Operation | Declaration | Formats | Scope guidance | Eligibility | Approval | Media sources | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

## Capability IDs and methods

Capability IDs describe routes, not necessarily method names. Native routes require explicit unsafe access and their own authorization checks.

| Capability ID | Implementation method(s) |
| --- | --- |
${[...implementationPaths].map(([operation, paths]) => `| ${cell(operation)} | ${cell(paths.join(", "))} |`).join("\n")}

Generate this page with \`bun scripts/generate-capabilities.ts\`. CI uses \`--check\` to detect drift. The complete manifests, including API revisions, runtimes and notes, are returned by \`social-sdk capabilities --adapter NAME --json\`.
`;

const files = new Map([
  ["apps/docs/docs/reference/capabilities.mdx", markdown],
  ["planning/evidence/capability-manifests.json", JSON.stringify(manifests, null, 2) + "\n"],
]);

for (const [path, content] of files) {
  if (process.argv.includes("--check")) {
    let existing: string;

    try {
      existing = await readFile(path, "utf8");
    } catch (error) {
      if (path.startsWith("planning/")) {
        console.log(`Skipping ${path}: the untracked planning folder is absent here.`);
        continue;
      }

      throw error;
    }

    if (existing !== content) throw new Error(`Generated capability data is stale: ${path}`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

console.log(
  `Capability ${process.argv.includes("--check") ? "check" : "generation"} passed (${rows.length} declarations).`,
);
