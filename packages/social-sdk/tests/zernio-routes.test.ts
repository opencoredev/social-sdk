import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import type { SocialError } from "../src/core/errors.js";
import { decodeWebhook } from "../src/server/webhooks.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";
import type {
  AdapterOperationContext,
  CommentRef,
  ConversationRef,
  DeliveryRef,
  JsonObject,
  JsonValue,
  PlatformPostRef,
} from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: JsonObject;
  readonly headers: Headers;
}

/** A Zernio adapter whose fake fetch answers each `METHOD /path` from `routes`. */
function fake(routes: Readonly<Record<string, JsonValue>>) {
  const calls: Call[] = [];

  const options: Parameters<typeof zernio>[0] = {
    apiKey: "test",
    clock: () => new Date("2026-11-04T12:00:00Z"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname.replace(/^\/api/, "");
      const parsed: unknown = init?.body === undefined ? undefined : JSON.parse(String(init.body));

      calls.push({
        method,
        path,
        query: Object.fromEntries(url.searchParams),
        headers: new Headers(init?.headers),
        ...definedFields({ body: isJsonValue(parsed) ? object(parsed) : undefined }),
      });

      const answer = routes[`${method} ${path}`];

      if (answer === undefined) return Response.json({ error: "no route" }, { status: 404 });

      return Response.json(answer);
    },
  };

  return { native: zernioNative(options), adapter: zernio(options), calls };
}

const account = (platform: string, accountId = "acc1") =>
  connectedAccountRef({ backend: "default", platform, accountId });

it("validates several destinations with customContent and customMedia [feature:zernio.publish.custom_per_platform]", async () => {
  const { native, calls } = fake({
    "POST /v1/tools/validate/post": {
      valid: false,
      errors: [{ platform: "twitter", error: "Too long" }],
      warnings: [],
    },
  });

  const result = await native.validatePosts(
    {
      content: { text: "Shared caption" },
      targets: [
        { account: account("linkedin", "li1") },
        {
          account: account("x", "x1"),
          content: {
            text: "Short for X",
            media: [
              {
                kind: "image",
                mimeType: "image/png",
                source: { kind: "https-url", url: "https://cdn.example.test/x.png" },
              },
            ],
          },
          options: { quotePostId: "1748391029384756102" },
        },
      ],
    },
    context,
  );

  assert.deepEqual(calls[0]?.body, {
    content: "Shared caption",
    mediaItems: [],
    platforms: [
      { platform: "linkedin", accountId: "li1" },
      {
        platform: "twitter",
        accountId: "x1",
        customContent: "Short for X",
        customMedia: [{ type: "image", url: "https://cdn.example.test/x.png" }],
        platformSpecificData: { quoteTweetId: "1748391029384756102" },
      },
    ],
  });
  assert.deepEqual(result, {
    valid: false,
    errors: [{ platform: "twitter", error: "Too long" }],
    warnings: [],
    localIssues: [
      {
        code: "x.quote",
        message: "An X quote post cannot carry media.",
        severity: "error",
        targetIndex: 1,
      },
    ],
  });
  await assert.rejects(native.validatePosts({ content: { text: "x" }, targets: [] }, context), {
    code: "invalid_input",
  });
});

it("lists and selects the facebook-page a connection posts to", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/fb1/facebook-page": {
      pages: [{ id: "111", name: "Main", category: "Brand", access_token: "never-copied" }],
      selectedPageId: "111",
      cached: true,
    },
    "PUT /v1/accounts/fb1/facebook-page": {
      message: "ok",
      selectedPage: { id: "222", name: "Second" },
    },
  });

  const facebook = account("facebook", "fb1");

  assert.deepEqual(await native.listFacebookPages({ account: facebook, refresh: true }, context), {
    pages: [{ id: "111", name: "Main", category: "Brand" }],
    selectedPageId: "111",
  });
  assert.deepEqual(calls[0]?.query, { refresh: "true" });
  assert.deepEqual(await native.selectFacebookPage({ account: facebook, pageId: "222" }, context), {
    id: "222",
    name: "Second",
  });
  assert.deepEqual(calls[1]?.body, { selectedPageId: "222" });
  await assert.rejects(native.listFacebookPages({ account: account("x") }, context), {
    code: "invalid_input",
  });
});

it("lists and sets publish destinations: pinterest-boards, youtube-playlists, gmb-locations, reddit-flairs, discord-channels", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/pin1/pinterest-boards": {
      boards: [{ id: "b1", name: "Recipes", privacy: "PUBLIC", owner: { id: "dropped" } }],
    },
    "POST /v1/accounts/pin1/pinterest-boards": {
      board: { id: "b2", name: "New", privacy: "SECRET", url: "https://pinterest.com/b2" },
    },
    "PUT /v1/accounts/pin1/pinterest-boards": { message: "ok" },
    "GET /v1/accounts/yt1/youtube-playlists": {
      playlists: [{ id: "PL1", title: "Talks", privacy: "public", itemCount: 4 }],
      defaultPlaylistId: "PL1",
    },
    "POST /v1/accounts/yt1/youtube-playlists": {
      playlist: {
        id: "PL2",
        title: "Shorts",
        description: "",
        privacy: "unlisted",
        itemCount: 0,
        thumbnailUrl: "",
      },
    },
    "PUT /v1/accounts/yt1/youtube-playlists": { success: true },
    "GET /v1/accounts/gbp1/gmb-locations": {
      locations: [{ id: "locations/1", name: "Main St", accountId: "dropped" }],
      hasMore: false,
      selectedLocationId: "locations/1",
    },
    "GET /v1/accounts/rd1/reddit-subreddits": {
      subreddits: [{ id: "t5_1", name: "typescript", over18: false }],
      defaultSubreddit: "typescript",
    },
    "PUT /v1/accounts/rd1/reddit-subreddits": { success: true },
    "GET /v1/accounts/rd1/reddit-subreddits/typescript/rules": {
      rules: [{ kind: "link", shortName: "No spam", priority: 0 }],
      siteRules: ["Spam"],
    },
    "GET /v1/accounts/rd1/reddit-flairs": { flairs: [{ id: "f1", text: "Release" }] },
    "GET /v1/accounts/dc1/discord-channels": { channels: [{ id: "111", name: "news", type: 5 }] },
  });

  const pinterest = account("pinterest", "pin1");
  const youtube = account("youtube", "yt1");
  const reddit = account("reddit", "rd1");

  assert.deepEqual(await native.listPinterestBoards({ account: pinterest }, context), [
    { id: "b1", name: "Recipes", privacy: "PUBLIC" },
  ]);
  assert.deepEqual(
    await native.createPinterestBoard(
      { account: pinterest, name: "New", privacy: "SECRET" },
      context,
    ),
    { id: "b2", name: "New", privacy: "SECRET", url: "https://pinterest.com/b2" },
  );
  assert.deepEqual(calls[1]?.body, { name: "New", privacy: "SECRET" });
  await native.setDefaultPinterestBoard({ account: pinterest, boardId: "b2" }, context);
  assert.deepEqual(calls[2]?.body, { defaultBoardId: "b2" });
  assert.equal(calls[2]?.method, "PUT");
  assert.deepEqual(await native.listYouTubePlaylists({ account: youtube }, context), {
    playlists: [{ id: "PL1", title: "Talks", privacy: "public", itemCount: 4 }],
    defaultPlaylistId: "PL1",
  });
  assert.equal(
    (await native.createYouTubePlaylist({ account: youtube, title: "Shorts" }, context))["id"],
    "PL2",
  );
  await native.setDefaultYouTubePlaylist({ account: youtube, playlistId: "PL2" }, context);
  assert.deepEqual(calls[5]?.body, { defaultPlaylistId: "PL2" });
  assert.deepEqual(
    await native.listGoogleBusinessLocations(
      { account: account("google-business", "gbp1"), search: "Main" },
      context,
    ),
    {
      locations: [{ id: "locations/1", name: "Main St" }],
      hasMore: false,
      selectedLocationId: "locations/1",
    },
  );
  assert.deepEqual(calls[6]?.query, { limit: "100", search: "Main" });
  assert.deepEqual(await native.listSubreddits({ account: reddit }, context), {
    subreddits: [{ id: "t5_1", name: "typescript", over18: false }],
    defaultSubreddit: "typescript",
  });
  await native.setDefaultSubreddit({ account: reddit, subreddit: "r/typescript" }, context);
  assert.deepEqual(calls[8]?.body, { defaultSubreddit: "typescript" });
  assert.deepEqual(
    await native.subredditRules({ account: reddit, subreddit: "typescript" }, context),
    {
      rules: [{ kind: "link", shortName: "No spam", priority: 0 }],
      siteRules: ["Spam"],
    },
  );
  assert.deepEqual(
    await native.listRedditFlairs({ account: reddit, subreddit: "typescript" }, context),
    [{ id: "f1", text: "Release" }],
  );
  assert.deepEqual(calls[10]?.query, { subreddit: "typescript" });
  assert.deepEqual(
    await native.listDiscordChannels({ account: account("discord", "dc1") }, context),
    [{ id: "111", name: "news", type: 5 }],
  );
  await assert.rejects(native.listPinterestBoards({ account: youtube }, context), {
    code: "invalid_input",
  });
});

it("looks up tiktok/locations, commercial-music and instagram/audio", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/tt1/tiktok/locations": { locations: [{ id: "loc1", name: "Lisbon" }] },
    "GET /v1/accounts/tt1/tiktok/commercial-music": {
      tracks: [{ id: "m1", name: "Song", artist: "Band", durationSec: 30, clip: { start: 0 } }],
    },
    "GET /v1/accounts/ig1/instagram/audio": {
      audio: [{ audioId: "a1", title: "Theme", audioType: "music", downloadUrl: "https://signed" }],
    },
    "GET /v1/accounts/ig1/instagram/audio/a1": { audio: { audioId: "a1", title: "Theme" } },
  });

  const tiktok = account("tiktok", "tt1");
  const instagram = account("instagram", "ig1");

  assert.deepEqual(
    await native.searchTikTokLocations({ account: tiktok, query: "Lisbon" }, context),
    [{ id: "loc1", name: "Lisbon" }],
  );
  assert.deepEqual(calls[0]?.query, { query: "Lisbon" });
  assert.deepEqual(
    await native.tiktokCommercialMusic({ account: tiktok, countryCode: "PT" }, context),
    [{ id: "m1", name: "Song", artist: "Band", durationSec: 30 }],
  );
  assert.deepEqual(calls[1]?.query, { countryCode: "PT" });
  assert.deepEqual(
    await native.searchInstagramAudio(
      { account: instagram, audioType: "music", query: "theme" },
      context,
    ),
    [{ audioId: "a1", title: "Theme", audioType: "music" }],
  );
  assert.deepEqual(calls[2]?.query, { audioType: "music", q: "theme" });
  assert.deepEqual(await native.getInstagramAudio({ account: instagram, audioId: "a1" }, context), {
    audioId: "a1",
    title: "Theme",
  });
  await assert.rejects(
    native.tiktokCommercialMusic({ account: tiktok, countryCode: "pt" }, context),
    {
      code: "invalid_input",
    },
  );
});

it("reads the Instagram publishing-limit quota", async () => {
  const { native } = fake({
    "GET /v1/accounts/ig1/instagram/publishing-limit": {
      quotaUsage: 12,
      quotaTotal: 100,
      quotaDurationSeconds: 86400,
    },
  });

  assert.deepEqual(
    await native.instagramPublishingLimit({ account: account("instagram", "ig1") }, context),
    {
      quotaUsage: 12,
      quotaTotal: 100,
      quotaDurationSeconds: 86400,
    },
  );
});

it("manages account-groups", async () => {
  const { native, calls } = fake({
    "GET /v1/account-groups": {
      groups: [{ _id: "g1", name: "Brand", accountIds: ["acc1"], createdBy: "u1" }],
    },
    "POST /v1/account-groups": {
      message: "ok",
      group: { _id: "g2", name: "Team", accountIds: ["acc1"] },
    },
    "PUT /v1/account-groups/g2": { message: "ok", group: {} },
    "DELETE /v1/account-groups/g2": { message: "deleted" },
  });

  assert.deepEqual(await native.listAccountGroups(context), [
    { groupId: "g1", name: "Brand", accountIds: ["acc1"] },
  ]);
  assert.deepEqual(
    await native.createAccountGroup({ name: "Team", accounts: [account("x")] }, context),
    {
      groupId: "g2",
      name: "Team",
      accountIds: ["acc1"],
    },
  );
  assert.deepEqual(calls[1]?.body, { name: "Team", accountIds: ["acc1"] });
  await native.updateAccountGroup({ groupId: "g2", name: "Renamed" }, context);
  assert.deepEqual(calls[2]?.body, { name: "Renamed" });
  await native.deleteAccountGroup({ groupId: "g2" }, context);
  assert.equal(calls[3]?.method, "DELETE");
});

it("reads and changes per-account settings: bluesky-settings, discord-settings, facebook-page-info, linkedin-organization, webhook-subscription", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/bs1/bluesky-settings": { defaultLangs: ["en", "pt"] },
    "PATCH /v1/accounts/bs1/bluesky-settings": {},
    "GET /v1/accounts/dc1/discord-settings": {
      account: {
        _id: "dc1",
        channelId: "111",
        channelName: "news",
        guildId: "999",
        webhookUsername: null,
      },
    },
    "PATCH /v1/accounts/dc1/discord-settings": {
      message: "ok",
      account: { channelId: "222", webhookUsername: "Bot" },
    },
    "GET /v1/accounts/fb1/facebook-page-info": {
      about: "Bakery",
      description: null,
      website: "https://example.com",
      phone: null,
      emails: [],
      hours: {},
    },
    "PATCH /v1/accounts/fb1/facebook-page-info": {
      about: "Bakery since 1990",
      description: null,
      website: "https://example.com",
      phone: null,
      emails: ["hi@example.com"],
      hours: { mon_1_open: "08:00" },
    },
    "GET /v1/accounts/li1/linkedin-organizations": {
      organizations: [{ id: "123", name: "Acme", vanityName: "acme" }],
    },
    "PUT /v1/accounts/li1/linkedin-organization": {
      message: "ok",
      accountType: "organization",
      accountName: "Acme",
    },
    "GET /v1/accounts/fb1/webhook-subscription": {
      pageId: "p1",
      appSubscribed: false,
      subscribedFields: [],
      warning: "Not subscribed",
    },
    "POST /v1/accounts/fb1/webhook-subscription": {
      resubscribed: true,
      pageId: "p1",
      appSubscribed: true,
      subscribedFields: ["feed", "messages"],
      warning: null,
    },
  });

  const bluesky = account("bluesky", "bs1");
  const discord = account("discord", "dc1");
  const facebook = account("facebook", "fb1");
  const linkedin = account("linkedin", "li1");

  assert.deepEqual(await native.getBlueskySettings({ account: bluesky }, context), {
    defaultLanguages: ["en", "pt"],
  });
  await native.updateBlueskySettings({ account: bluesky, defaultLanguages: null }, context);
  assert.deepEqual(calls[1]?.body, { defaultLangs: null });
  assert.deepEqual(await native.getDiscordSettings({ account: discord }, context), {
    channelId: "111",
    channelName: "news",
    guildId: "999",
    webhookUsername: null,
  });
  assert.deepEqual(
    await native.updateDiscordSettings(
      { account: discord, channelId: "222", webhookUsername: "Bot" },
      context,
    ),
    { channelId: "222", webhookUsername: "Bot" },
  );
  assert.deepEqual(calls[3]?.body, { webhookUsername: "Bot", channelId: "222" });
  assert.equal(
    (await native.getFacebookPageInfo({ account: facebook }, context))["about"],
    "Bakery",
  );
  await native.updateFacebookPageInfo(
    {
      account: facebook,
      about: "Bakery since 1990",
      emails: ["hi@example.com"],
      hours: { mon_1_open: "08:00" },
    },
    context,
  );
  assert.deepEqual(calls[5]?.body, {
    about: "Bakery since 1990",
    emails: ["hi@example.com"],
    hours: { mon_1_open: "08:00" },
  });
  assert.deepEqual(await native.listLinkedInOrganizations({ account: linkedin }, context), [
    { id: "123", name: "Acme", vanityName: "acme" },
  ]);
  assert.deepEqual(
    await native.switchLinkedInAccountType(
      { account: linkedin, accountType: "organization", organization: { id: "123", name: "Acme" } },
      context,
    ),
    { accountType: "organization", accountName: "Acme" },
  );
  assert.deepEqual(calls[7]?.body, {
    accountType: "organization",
    selectedOrganization: { id: "123", urn: "urn:li:organization:123", name: "Acme" },
  });
  assert.deepEqual(await native.getWebhookSubscription({ account: facebook }, context), {
    pageId: "p1",
    appSubscribed: false,
    subscribedFields: [],
    warning: "Not subscribed",
  });
  assert.deepEqual(await native.resubscribeWebhooks({ account: facebook }, context), {
    resubscribed: true,
    pageId: "p1",
    appSubscribed: true,
    subscribedFields: ["feed", "messages"],
    warning: null,
  });
  assert.equal(calls[9]?.method, "POST");
  await assert.rejects(
    native.updateBlueskySettings(
      { account: bluesky, defaultLanguages: ["english language"] },
      context,
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.switchLinkedInAccountType({ account: linkedin, accountType: "organization" }, context),
    { code: "invalid_input" },
  );
});

it("manages oauth-apps and the welcome-screen without returning secrets", async () => {
  const app = {
    id: "app1",
    platform: "linkedin",
    label: "Our app",
    clientId: "client",
    scopeAreas: ["posting"],
    status: "unchecked",
    accountCount: 0,
    redirectUri: "https://zernio.com/callback/app1",
    createdAt: "2026-11-04T00:00:00Z",
    webhook: { secret: "never-copied" },
  };

  const { native, calls } = fake({
    "GET /v1/connect/oauth-apps": { apps: [app], pagination: { nextCursor: "n2" }, platforms: [] },
    "POST /v1/connect/oauth-apps": { app },
    "GET /v1/connect/oauth-apps/app1": { app },
    "PATCH /v1/connect/oauth-apps/app1": { app: { ...app, label: "Renamed" } },
    "POST /v1/connect/oauth-apps/app1/test": { app: { ...app, status: "ok" } },
    "DELETE /v1/connect/oauth-apps/app1": { disconnectedAccounts: 2 },
    "GET /v1/connect/welcome-screen": {
      showByDefault: false,
      brandName: null,
      logoUrl: null,
      theme: null,
    },
    "PUT /v1/connect/welcome-screen": {
      showByDefault: true,
      brandName: "Acme",
      logoUrl: null,
      theme: null,
    },
  });

  const listed = await native.listOAuthApps({}, context);

  assert.equal(listed.nextCursor, "n2");
  assert.deepEqual(listed.apps[0]?.["webhook"], {});
  assert.equal(listed.apps[0]?.["redirectUri"], "https://zernio.com/callback/app1");
  await native.createOAuthApp(
    {
      platform: "linkedin",
      label: "Our app",
      clientId: "client",
      clientSecret: "fixture-secret",
      scopeAreas: ["posting"],
    },
    context,
  );
  assert.deepEqual(calls[1]?.body, {
    platform: "linkedin",
    label: "Our app",
    clientId: "client",
    clientSecret: "fixture-secret",
    scopeAreas: ["posting"],
  });
  assert.equal((await native.getOAuthApp({ appId: "app1" }, context))["clientId"], "client");
  assert.equal(
    (await native.updateOAuthApp({ appId: "app1", label: "Renamed" }, context))["label"],
    "Renamed",
  );
  assert.equal((await native.testOAuthApp({ appId: "app1" }, context))["status"], "ok");
  assert.deepEqual(await native.deleteOAuthApp({ appId: "app1", confirm: true }, context), {
    disconnectedAccounts: 2,
  });
  assert.deepEqual(calls[5]?.query, { confirm: "true" });
  assert.equal((await native.getWelcomeScreen(context))["showByDefault"], false);
  await native.saveWelcomeScreen({ showByDefault: true, brandName: "Acme" }, context);
  assert.deepEqual(calls[7]?.body, { showByDefault: true, brandName: "Acme" });
});

it("connects Discord channels through /v1/connect/discord", async () => {
  const { native, calls } = fake({ "POST /v1/connect/discord": {} });

  await native.connectDiscord(
    { guildId: "999", channelIds: ["111", "222"], profileId: "prof1" },
    context,
  );
  assert.deepEqual(calls[0]?.body, {
    guildId: "999",
    profileId: "prof1",
    channelIds: ["111", "222"],
  });
  await assert.rejects(
    native.connectDiscord({ guildId: "999", channelIds: [], profileId: "prof1" }, context),
    { code: "invalid_input" },
  );
});

it("starts a reconnect with reconnectAccountId, forceReauth and a branded welcome screen", async () => {
  const { native, calls } = fake({
    "GET /v1/connect/instagram": { authUrl: "https://zernio.com/connect/abc", state: "s1" },
  });

  await native.createConnection(
    {
      platform: "instagram",
      profileId: "prof1",
      redirectUrl: "https://app.example.com/connected",
      reconnectAccountId: "ig1",
      forceReauth: true,
      expectedUsername: "@brand",
      scopes: ["posting", "comments"],
      welcome: true,
      brandName: "Acme",
      primaryColor: "#112233",
    },
    context,
  );
  assert.deepEqual(calls[0]?.query, {
    profileId: "prof1",
    redirect_url: "https://app.example.com/connected",
    reconnectAccountId: "ig1",
    forceReauth: "true",
    expectedUsername: "@brand",
    scopes: "posting,comments",
    welcome: "true",
    brandName: "Acme",
    primaryColor: "#112233",
  });
  await assert.rejects(
    native.createConnection(
      { platform: "x", profileId: "p", redirectUrl: "https://a.test/", brandName: "Acme" },
      context,
    ),
    { code: "invalid_input" },
  );
});

it("reads usage-stats and /v1/logs without logged bodies", async () => {
  const { native, calls } = fake({
    "GET /v1/usage-stats": {
      planName: "Build",
      billingPeriod: "monthly",
      hasAccess: true,
      customerId: "cus_dropped",
      limits: { uploads: 120, profiles: 10 },
      usage: { uploads: 4, profiles: 2 },
    },
    "GET /v1/logs": {
      logs: [
        {
          type: "publishing",
          action: "post.publish",
          status: "failed",
          error_message: "Rate limited",
          request_body: '{"content":"private"}',
          ip_address: "203.0.113.1",
          created_at: "2026-11-04T10:00:00Z",
        },
      ],
      pagination: { total: 1, hasMore: false },
    },
  });

  assert.deepEqual(await native.usageStats({}, context), {
    planName: "Build",
    billingPeriod: "monthly",
    hasAccess: true,
    limits: { uploads: 120, profiles: 10 },
    usage: { uploads: 4, profiles: 2 },
  });
  assert.deepEqual(
    await native.listLogs(
      { type: "publishing", status: "failed", account: account("x", "x1"), days: 7 },
      context,
    ),
    {
      logs: [
        {
          type: "publishing",
          action: "post.publish",
          status: "failed",
          error_message: "Rate limited",
          created_at: "2026-11-04T10:00:00Z",
        },
      ],
      hasMore: false,
      total: 1,
    },
  );
  assert.deepEqual(calls[1]?.query, {
    limit: "50",
    skip: "0",
    type: "publishing",
    status: "failed",
    accountId: "x1",
    platform: "twitter",
    days: "7",
  });
});

it("lists posts with dateFrom, dateTo and sortBy filters, and refuses updatedSince", async () => {
  const { native, calls } = fake({
    "GET /v1/posts": {
      posts: [
        {
          _id: "p1",
          content: "Hello",
          status: "published",
          updatedAt: "2026-11-03T10:00:00Z",
          platforms: [
            {
              platform: "twitter",
              accountId: { _id: "x1", accessToken: "dropped" },
              status: "published",
              platformPostId: "n1",
            },
          ],
        },
      ],
      pagination: { nextCursor: "c2" },
    },
  });

  const result = await native.listPosts(
    {
      account: account("x", "x1"),
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      sortBy: "created-asc",
      createdBy: "507f1f77bcf86cd799439011",
      includeHidden: true,
      tags: ["launch", "q4"],
    },
    context,
  );

  assert.deepEqual(calls[0]?.query, {
    limit: "25",
    accountId: "x1",
    platform: "twitter",
    dateFrom: "2026-11-01",
    dateTo: "2026-11-30",
    sortBy: "created-asc",
    createdBy: "507f1f77bcf86cd799439011",
    includeHidden: "true",
    tags: "launch,q4",
  });
  assert.deepEqual(result, {
    posts: [
      {
        _id: "p1",
        content: "Hello",
        status: "published",
        updatedAt: "2026-11-03T10:00:00Z",
        platforms: [
          { platform: "twitter", status: "published", platformPostId: "n1", accountId: "x1" },
        ],
      },
    ],
    nextCursor: "c2",
  });

  // Zernio's list-posts reference does not list updatedSince and answers 400 for it, so a
  // caller from an earlier build is refused before any request instead of getting every post.
  const legacy = { limit: 10, updatedSince: "2026-11-02T00:00:00Z" };

  await assert.rejects(native.listPosts(legacy, context), (error: SocialError) => {
    assert.equal(error.code, "invalid_input");
    assert.match(error.message, /analyticsDelta/);

    return true;
  });
  assert.equal(calls.length, 1);
});

it("reads instagram/stories, live media, tags, mentions, collaborators, business-discovery and follow-status", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/ig1/instagram/stories": {
      data: [
        {
          id: "s1",
          mediaType: "IMAGE",
          mediaUrl: "https://cdn.example.test/signed",
          timestamp: "t",
        },
      ],
    },
    "GET /v1/accounts/ig1/instagram/live-media": {
      data: [
        {
          id: "l1",
          mediaType: "BROADCAST",
          username: "brand",
          timestamp: null,
          mediaProductType: null,
        },
      ],
    },
    "GET /v1/accounts/ig1/instagram/tags": {
      data: [
        { id: "t1", caption: "Love it", username: "fan", likeCount: 3, mediaUrl: "https://signed" },
      ],
      nextCursor: "c2",
    },
    "GET /v1/accounts/ig1/instagram/mentions/media/m1": {
      id: "m1",
      caption: "@brand hi",
      username: "fan",
    },
    "GET /v1/accounts/ig1/instagram/mentions/comments/c1": {
      id: "c1",
      text: "@brand nice",
      timestamp: "t",
      likeCount: 0,
      media: { id: "m9" },
    },
    "GET /v1/accounts/ig1/instagram/media/m1/collaborators": {
      data: [{ id: "u2", username: "partner", inviteStatus: "Accepted" }],
    },
    "GET /v1/accounts/ig1/instagram/business-discovery": {
      profile: {
        id: "p1",
        username: "nasa",
        followersCount: 100,
        profilePictureUrl: "https://signed",
      },
      media: [{ id: "n1", caption: "Moon", likeCount: 9, viewCount: 20, children: [] }],
    },
    "GET /v1/accounts/ig1/follow-status/u7": {
      userId: "u7",
      accountId: "ig1",
      isFollower: true,
      username: "fan",
      unavailableReason: null,
    },
  });

  const instagram = account("instagram", "ig1");

  assert.deepEqual(await native.instagramActiveStories({ account: instagram }, context), [
    { id: "s1", mediaType: "IMAGE", timestamp: "t" },
  ]);
  assert.deepEqual(await native.instagramLiveMedia({ account: instagram }, context), [
    {
      id: "l1",
      mediaType: "BROADCAST",
      username: "brand",
      timestamp: null,
      mediaProductType: null,
    },
  ]);
  assert.deepEqual(await native.instagramTaggedPosts({ account: instagram, limit: 10 }, context), {
    posts: [{ id: "t1", caption: "Love it", username: "fan", likeCount: 3 }],
    nextCursor: "c2",
  });
  assert.deepEqual(calls[2]?.query, { limit: "10" });
  assert.equal(
    (await native.instagramMentionedMedia({ account: instagram, mediaId: "m1" }, context))[
      "caption"
    ],
    "@brand hi",
  );
  assert.deepEqual(
    await native.instagramMentionedComment({ account: instagram, commentId: "c1" }, context),
    {
      id: "c1",
      text: "@brand nice",
      timestamp: "t",
      likeCount: 0,
      mediaId: "m9",
    },
  );
  assert.deepEqual(
    await native.instagramCollaborators({ account: instagram, mediaId: "m1" }, context),
    [{ id: "u2", username: "partner", inviteStatus: "Accepted" }],
  );
  assert.deepEqual(
    await native.instagramBusinessDiscovery({ account: instagram, username: "@nasa" }, context),
    {
      profile: { id: "p1", username: "nasa", followersCount: 100 },
      media: [{ id: "n1", caption: "Moon", likeCount: 9, viewCount: 20 }],
    },
  );
  assert.deepEqual(calls[6]?.query, { username: "nasa", limit: "12" });
  assert.deepEqual(
    await native.instagramFollowStatus({ account: instagram, userId: "u7" }, context),
    {
      userId: "u7",
      isFollower: true,
      username: "fan",
      unavailableReason: null,
    },
  );
  await assert.rejects(
    native.instagramBusinessDiscovery({ account: instagram, username: "not a handle" }, context),
    { code: "invalid_input" },
  );
});

it("reads facebook-visitor-posts and facebook-tagged-posts", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/fb1/facebook-visitor-posts": {
      data: [
        {
          id: "v1",
          message: "Great shop",
          from: { id: "u1", name: "Ana", email: "dropped" },
          media: null,
        },
      ],
      nextCursor: null,
    },
    "GET /v1/accounts/fb1/facebook-tagged-posts": {
      data: [
        {
          id: "t1",
          message: "With @Page",
          taggedTime: "t",
          pictureUrl: "https://signed",
          from: null,
        },
      ],
      nextCursor: "n2",
    },
  });

  const facebook = account("facebook", "fb1");

  assert.deepEqual(await native.facebookVisitorPosts({ account: facebook }, context), {
    posts: [{ id: "v1", message: "Great shop", from: { id: "u1", name: "Ana" } }],
  });
  assert.deepEqual(
    await native.facebookTaggedPosts({ account: facebook, limit: 50, cursor: "c" }, context),
    {
      posts: [{ id: "t1", message: "With @Page", taggedTime: "t" }],
      nextCursor: "n2",
    },
  );
  assert.deepEqual(calls[1]?.query, { limit: "50", cursor: "c" });
  await assert.rejects(native.facebookTaggedPosts({ account: facebook, limit: 51 }, context), {
    code: "invalid_input",
  });
});

it("reads a video transcript from youtube-captions", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/yt1/youtube-captions": {
      accountId: "yt1",
      videoId: "dQw4w9WgXcQ",
      language: "en",
      trackKind: "asr",
      text: "Hello world",
      cues: [{ start: 0, end: 1.5, text: "Hello world" }],
      availableTracks: [{ trackId: "tr1", language: "en", trackKind: "asr", name: "" }],
    },
  });

  const result = await native.youtubeCaptions(
    { account: account("youtube", "yt1"), videoId: "dQw4w9WgXcQ", language: "en" },
    context,
  );

  assert.deepEqual(calls[0]?.query, { videoId: "dQw4w9WgXcQ", language: "en" });
  assert.equal(result["text"], "Hello world");
  assert.deepEqual(result["cues"], [{ start: 0, end: 1.5, text: "Hello world" }]);
});

it("syncs one external post through sync-external", async () => {
  const { native, calls } = fake({
    "POST /v1/posts/sync-external": {
      synced: { postsFound: 1, postsSynced: 1, skipped: false },
      found: true,
      posts: [
        {
          platform: "instagram",
          platformPostId: "n1",
          content: "Old post",
          analytics: { likes: 1 },
        },
      ],
    },
  });

  assert.deepEqual(
    await native.syncExternalPosts(
      { account: account("instagram", "ig1"), url: "https://www.instagram.com/p/abc/" },
      context,
    ),
    {
      postsFound: 1,
      postsSynced: 1,
      skipped: false,
      found: true,
      posts: [{ platform: "instagram", platformPostId: "n1", content: "Old post" }],
    },
  );
  assert.deepEqual(calls[0]?.body, { accountId: "ig1", url: "https://www.instagram.com/p/abc/" });
});

it("uploads a CSV to bulk-upload as multipart form data with dryRun", async () => {
  let received: { path: string; query: string; file: string } | undefined;

  const native = zernioNative({
    apiKey: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body;

      assert.ok(body instanceof FormData);

      const file = body.get("file");

      assert.ok(file instanceof Blob);

      received = { path: url.pathname, query: url.search, file: await file.text() };

      return Response.json({
        total: 2,
        valid: 1,
        invalid: 1,
        results: [
          { rowIndex: 0, ok: true },
          { rowIndex: 1, ok: false, errors: ["Unknown account"] },
        ],
        warnings: [],
      });
    },
  });

  const csv = "platform,accountId,content\ntwitter,x1,Hello\n";
  const result = await native.bulkUpload({ csv, dryRun: true }, context);

  assert.deepEqual(received, {
    path: "/api/v1/posts/bulk-upload",
    query: "?dryRun=true",
    file: csv,
  });
  assert.equal(result["invalid"], 1);
  assert.deepEqual(result["results"], [
    { rowIndex: 0, ok: true },
    { rowIndex: 1, ok: false, errors: ["Unknown account"] },
  ]);
  await assert.rejects(native.bulkUpload({ csv: "" }, context), { code: "invalid_input" });
});

it("calls the validate/post-length, validate/media and validate/subreddit tools", async () => {
  const { native, calls } = fake({
    "POST /v1/tools/validate/post-length": {
      text: "Hi",
      platforms: { twitter: { count: 2, limit: 280, valid: true } },
    },
    "POST /v1/tools/validate/media": {
      valid: true,
      contentType: "image/png",
      size: 100,
      type: "image",
      platformLimits: { instagram: { maxSize: 8 } },
    },
    "GET /v1/tools/validate/subreddit": { exists: false, error: "Subreddit not found" },
  });

  assert.deepEqual(await native.validatePostLength({ text: "Hi" }, context), {
    platforms: { twitter: { count: 2, limit: 280, valid: true } },
  });
  assert.equal(
    (await native.validateMedia({ url: "https://cdn.example.test/a.png" }, context))["type"],
    "image",
  );
  assert.deepEqual(calls[1]?.body, { url: "https://cdn.example.test/a.png" });
  assert.deepEqual(await native.validateSubreddit({ subreddit: "r/nope" }, context), {
    exists: false,
    error: "Subreddit not found",
  });
  assert.deepEqual(calls[2]?.query, { name: "nope" });
});

it("reads gmb-reviews one at a time, by page and in a batch", async () => {
  const review = {
    id: "r1",
    rating: 5,
    starRating: "FIVE",
    comment: "Great",
    reviewer: { displayName: "Ana", profilePhotoUrl: "https://signed" },
    reviewReply: { comment: "Thanks!", updateTime: "t" },
    photos: [{ url: "https://signed" }],
  };

  const { native, calls } = fake({
    "GET /v1/accounts/gbp1/gmb-reviews": {
      reviews: [review],
      averageRating: 4.8,
      totalReviewCount: 12,
      nextPageToken: "p2",
    },
    "GET /v1/accounts/gbp1/gmb-reviews/r1": { review },
    "POST /v1/accounts/gbp1/gmb-reviews/batch": {
      locationReviews: [{ name: "locations/1", review }],
    },
  });

  const gbp = account("google-business", "gbp1");

  const expected = {
    id: "r1",
    rating: 5,
    starRating: "FIVE",
    comment: "Great",
    reviewer: { displayName: "Ana" },
    reply: { comment: "Thanks!", updateTime: "t" },
  };

  assert.deepEqual(
    await native.listGoogleBusinessReviews({ account: gbp, locationId: "locations/1" }, context),
    {
      reviews: [expected],
      averageRating: 4.8,
      totalReviewCount: 12,
      nextPageToken: "p2",
    },
  );
  assert.deepEqual(calls[0]?.query, { locationId: "locations/1", pageSize: "50" });
  assert.deepEqual(
    await native.getGoogleBusinessReview({ account: gbp, reviewId: "r1" }, context),
    expected,
  );
  assert.deepEqual(
    await native.batchGoogleBusinessReviews(
      { account: gbp, locationNames: ["locations/1"], orderBy: "rating desc" },
      context,
    ),
    { locationReviews: [{ name: "locations/1", review: expected }] },
  );
  assert.deepEqual(calls[2]?.body, { locationNames: ["locations/1"], orderBy: "rating desc" });
});

it("manages a Google Business listing: gmb-location-details, attributes, services, food menus, place actions, media and verifications", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/gbp1/gmb-location-details": {
      success: true,
      title: "Main St Bakery",
      websiteUri: "https://example.com",
      regularHours: { periods: [] },
    },
    "PUT /v1/accounts/gbp1/gmb-location-details": { success: true },
    "GET /v1/accounts/gbp1/gmb-attributes": {
      attributes: [{ name: "attributes/has_wheelchair_accessible_entrance", values: [true] }],
    },
    "PUT /v1/accounts/gbp1/gmb-attributes": {
      attributes: [{ name: "attributes/has_wifi", values: [true] }],
    },
    "GET /v1/accounts/gbp1/gmb-attribute-metadata": {
      attributeMetadata: [{ parent: "attributes/has_wifi" }],
      nextPageToken: "n",
    },
    "GET /v1/accounts/gbp1/gmb-services": {
      services: [{ freeFormServiceItem: { category: "c" } }],
    },
    "PUT /v1/accounts/gbp1/gmb-services": { success: true, services: [] },
    "GET /v1/accounts/gbp1/gmb-food-menus": { menus: [{ labels: [{ displayName: "Lunch" }] }] },
    "PUT /v1/accounts/gbp1/gmb-food-menus": { menus: [{ labels: [{ displayName: "Dinner" }] }] },
    "GET /v1/accounts/gbp1/gmb-place-actions": {
      placeActionLinks: [
        { name: "pa/1", uri: "https://book.example.com", placeActionType: "APPOINTMENT" },
      ],
    },
    "POST /v1/accounts/gbp1/gmb-place-actions": {
      success: true,
      name: "pa/2",
      uri: "https://order.example.com",
      placeActionType: "FOOD_ORDERING",
    },
    "PATCH /v1/accounts/gbp1/gmb-place-actions": {
      success: true,
      name: "pa/2",
      uri: "https://order2.example.com",
      placeActionType: "FOOD_ORDERING",
    },
    "DELETE /v1/accounts/gbp1/gmb-place-actions": { success: true, deleted: true, name: "pa/2" },
    "GET /v1/accounts/gbp1/gmb-media": {
      mediaItems: [
        {
          name: "m/1",
          mediaFormat: "PHOTO",
          googleUrl: "https://lh3.example",
          sourceUrl: "https://signed",
        },
      ],
      totalMediaItemsCount: 1,
    },
    "POST /v1/accounts/gbp1/gmb-media": {
      success: true,
      name: "m/2",
      mediaFormat: "PHOTO",
      googleUrl: "https://lh3.example/2",
    },
    "DELETE /v1/accounts/gbp1/gmb-media": { success: true, deleted: true, mediaId: "m/2" },
    "GET /v1/accounts/gbp1/gmb-verifications": {
      voiceOfMerchantState: { hasVoiceOfMerchant: false },
      verifications: [],
    },
    "POST /v1/accounts/gbp1/gmb-verifications/options": {
      options: [{ verificationMethod: "SMS", phoneNumber: "+1555" }],
    },
    "POST /v1/accounts/gbp1/gmb-verifications": {
      verification: { name: "v/1", method: "SMS", state: "PENDING" },
    },
    "POST /v1/accounts/gbp1/gmb-verifications/v%2F1/complete": {
      verification: { name: "v/1", method: "SMS", state: "COMPLETED" },
    },
  });

  const gbp = { account: account("google-business", "gbp1"), locationId: "locations/1" };

  assert.equal(
    (await native.getGoogleBusinessLocationDetails(gbp, context))["title"],
    "Main St Bakery",
  );
  await native.updateGoogleBusinessLocationDetails(
    { ...gbp, updateMask: "websiteUri", fields: { websiteUri: "https://new.example.com" } },
    context,
  );
  assert.deepEqual(calls[1]?.body, {
    updateMask: "websiteUri",
    websiteUri: "https://new.example.com",
  });
  assert.deepEqual(calls[1]?.query, { locationId: "locations/1" });
  assert.equal((await native.getGoogleBusinessAttributes(gbp, context)).length, 1);
  await native.updateGoogleBusinessAttributes(
    {
      ...gbp,
      attributes: [{ name: "attributes/has_wifi", values: [true] }],
      attributeMask: "attributes/has_wifi",
    },
    context,
  );
  assert.deepEqual(calls[3]?.body, {
    attributes: [{ name: "attributes/has_wifi", values: [true] }],
    attributeMask: "attributes/has_wifi",
  });
  assert.equal(
    (await native.googleBusinessAttributeMetadata({ ...gbp, categoryName: "gcid:bakery" }, context))
      .nextPageToken,
    "n",
  );
  assert.deepEqual(calls[4]?.query, { locationId: "locations/1", categoryName: "gcid:bakery" });
  assert.equal((await native.getGoogleBusinessServices(gbp, context)).length, 1);
  await native.replaceGoogleBusinessServices({ ...gbp, serviceItems: [] }, context);
  assert.deepEqual(calls[6]?.body, { serviceItems: [] });
  assert.equal((await native.getGoogleBusinessFoodMenus(gbp, context)).length, 1);
  await native.updateGoogleBusinessFoodMenus(
    { ...gbp, menus: [{ labels: [{ displayName: "Dinner" }] }] },
    context,
  );
  assert.deepEqual(calls[8]?.body, { menus: [{ labels: [{ displayName: "Dinner" }] }] });
  assert.equal(
    (await native.listGoogleBusinessPlaceActions(gbp, context)).placeActionLinks.length,
    1,
  );
  await native.createGoogleBusinessPlaceAction(
    { ...gbp, uri: "https://order.example.com", placeActionType: "FOOD_ORDERING" },
    context,
  );
  assert.deepEqual(calls[10]?.body, {
    uri: "https://order.example.com/",
    placeActionType: "FOOD_ORDERING",
  });
  await native.updateGoogleBusinessPlaceAction(
    { ...gbp, name: "pa/2", uri: "https://order2.example.com" },
    context,
  );
  assert.equal(calls[11]?.method, "PATCH");
  await native.deleteGoogleBusinessPlaceAction({ ...gbp, name: "pa/2" }, context);
  assert.deepEqual(calls[12]?.query, { locationId: "locations/1", name: "pa/2" });
  assert.deepEqual(await native.listGoogleBusinessMedia(gbp, context), {
    mediaItems: [{ name: "m/1", mediaFormat: "PHOTO", googleUrl: "https://lh3.example" }],
    totalMediaItemsCount: 1,
  });
  await native.addGoogleBusinessMedia(
    { ...gbp, sourceUrl: "https://cdn.example.test/front.jpg", category: "EXTERIOR" },
    context,
  );
  assert.deepEqual(calls[14]?.body, {
    sourceUrl: "https://cdn.example.test/front.jpg",
    category: "EXTERIOR",
  });
  await native.deleteGoogleBusinessMedia({ ...gbp, mediaId: "m/2" }, context);
  assert.deepEqual(calls[15]?.query, { locationId: "locations/1", mediaId: "m/2" });
  assert.deepEqual(
    (await native.getGoogleBusinessVerifications(gbp, context))["verifications"],
    [],
  );
  assert.deepEqual(
    await native.googleBusinessVerificationOptions({ ...gbp, languageCode: "en" }, context),
    [{ verificationMethod: "SMS", phoneNumber: "+1555" }],
  );
  assert.equal(
    (
      await native.startGoogleBusinessVerification(
        { ...gbp, method: "SMS", phoneNumber: "+1555" },
        context,
      )
    )["state"],
    "PENDING",
  );
  assert.equal(
    (
      await native.completeGoogleBusinessVerification(
        { ...gbp, verificationId: "v/1", pin: "123456" },
        context,
      )
    )["state"],
    "COMPLETED",
  );
  assert.deepEqual(calls[19]?.body, { pin: "123456" });
  await assert.rejects(
    native.updateGoogleBusinessLocationDetails(
      { ...gbp, updateMask: "x", fields: { name: "locations/9" } },
      context,
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(native.startGoogleBusinessVerification({ ...gbp, method: "SMS" }, context), {
    code: "invalid_input",
  });
});

it("votes with reddit-vote and reads Reddit search, feed and comments", async () => {
  const listing = {
    items: [{ id: "abc", fullname: "t3_abc", title: "SDK", score: 10, galleryImages: [] }],
    after: "t3_abc",
    before: null,
  };

  const { native, calls } = fake({
    "POST /v1/accounts/rd1/reddit-vote": { success: true },
    "GET /v1/reddit/search": listing,
    "GET /v1/reddit/feed": listing,
    "GET /v1/reddit/comments/abc": {
      post: {},
      items: [{ id: "c1", fullname: "t1_c1", body: "Nice", depth: 0 }],
      more: ["t1_c2"],
    },
  });

  const reddit = account("reddit", "rd1");

  await native.redditVote({ account: reddit, thingId: "t3_abc", direction: 1 }, context);
  assert.deepEqual(calls[0]?.body, { thingId: "t3_abc", direction: 1 });

  const expected = {
    posts: [{ id: "abc", fullname: "t3_abc", title: "SDK", score: 10 }],
    after: "t3_abc",
  };

  assert.deepEqual(
    await native.redditSearch(
      { account: reddit, query: "sdk", subreddit: "typescript", sort: "new" },
      context,
    ),
    expected,
  );
  assert.deepEqual(calls[1]?.query, {
    accountId: "rd1",
    q: "sdk",
    subreddit: "typescript",
    restrict_sr: "1",
    sort: "new",
  });
  assert.deepEqual(
    await native.redditFeed(
      { account: reddit, subreddit: "typescript", sort: "top", time: "week" },
      context,
    ),
    expected,
  );
  assert.deepEqual(calls[2]?.query, {
    accountId: "rd1",
    subreddit: "typescript",
    sort: "top",
    t: "week",
  });
  assert.deepEqual(
    await native.redditComments({ account: reddit, postId: "abc", sort: "best" }, context),
    {
      comments: [{ id: "c1", fullname: "t1_c1", body: "Nice", depth: 0 }],
      more: ["t1_c2"],
    },
  );
  await assert.rejects(
    native.redditVote({ account: reddit, thingId: "abc", direction: 1 }, context),
    {
      code: "invalid_input",
    },
  );
});

it("runs Discord DMs and /v1/discord/guilds roles, members, pins, threads, crossposts and scheduled events", async () => {
  const role = { id: "r1", name: "Mods", color: 0, permissions: "8", managed: false };

  const member = {
    user: { id: "u1", username: "ana", email: "dropped" },
    nick: null,
    roles: ["r1"],
    joined_at: "t",
  };

  const event = {
    id: "e1",
    guild_id: "999",
    name: "Launch",
    scheduled_start_time: "2026-12-01T18:00:00Z",
    status: 1,
    entity_type: 3,
  };

  const { native, calls } = fake({
    "POST /v1/discord/dms": {
      messageId: "dm1",
      channelId: "c9",
      url: "https://discord.com/x",
      timestamp: "t",
    },
    "GET /v1/discord/guilds/999/roles": { data: [role] },
    "POST /v1/discord/guilds/999/roles": { data: role },
    "PATCH /v1/discord/guilds/999/roles/r1": { data: { ...role, name: "Moderators" } },
    "DELETE /v1/discord/guilds/999/roles/r1": { success: true },
    "GET /v1/discord/guilds/999/members": {
      data: [member],
      pagination: { nextCursor: "u1", hasMore: true },
    },
    "GET /v1/discord/guilds/999/members/search": { data: [member] },
    "GET /v1/discord/guilds/999/members/u1": { data: member },
    "PUT /v1/discord/guilds/999/members/u1/roles/r1": { success: true, operation: "role_assigned" },
    "GET /v1/discord/channels/111/pins": {
      data: [{ id: "m1", channel_id: "111", content: "Rules", author: {} }],
    },
    "PUT /v1/discord/channels/111/pins/m1": { success: true },
    "POST /v1/discord/channels/111/threads": { data: { id: "th1", name: "Q&A" } },
    "POST /v1/discord/channels/111/messages/m1/crosspost": {
      data: { id: "m1", channel_id: "111" },
    },
    "DELETE /v1/discord/channels/111/messages/m1": { success: true },
    "GET /v1/discord/guilds/999/events": { data: [event] },
    "POST /v1/discord/guilds/999/events": { data: event },
    "PATCH /v1/discord/guilds/999/events/e1": { data: { ...event, status: 4 } },
    "DELETE /v1/discord/guilds/999/events/e1": { success: true, deleted: "e1" },
  });

  const bot = account("discord", "dc1");
  const guild = { account: bot, guildId: "999" };
  const channel = { account: bot, channelId: "111" };

  assert.equal(
    (await native.sendDiscordDirectMessage({ account: bot, userId: "123", text: "Hi" }, context))[
      "messageId"
    ],
    "dm1",
  );
  assert.deepEqual(calls[0]?.body, { accountId: "dc1", userId: "123", content: "Hi" });
  assert.deepEqual(await native.listDiscordRoles(guild, context), [role]);
  assert.deepEqual(calls[1]?.query, { accountId: "dc1" });
  await native.createDiscordRole({ ...guild, name: "Mods", permissions: "8" }, context);
  assert.deepEqual(calls[2]?.body, { name: "Mods", permissions: "8" });
  assert.equal(
    (await native.updateDiscordRole({ ...guild, roleId: "r1", name: "Moderators" }, context))[
      "name"
    ],
    "Moderators",
  );
  await native.deleteDiscordRole({ ...guild, roleId: "r1" }, context);
  assert.deepEqual(await native.listDiscordMembers({ ...guild, limit: 10 }, context), {
    members: [{ user: { id: "u1", username: "ana" }, nick: null, roles: ["r1"], joined_at: "t" }],
    nextCursor: "u1",
  });
  assert.deepEqual(calls[5]?.query, { accountId: "dc1", limit: "10" });
  assert.equal((await native.searchDiscordMembers({ ...guild, query: "an" }, context)).length, 1);
  assert.equal((await native.getDiscordMember({ ...guild, userId: "u1" }, context))["nick"], null);
  await native.setDiscordMemberRole(
    { ...guild, userId: "u1", roleId: "r1", assigned: true },
    context,
  );
  assert.equal(calls[8]?.method, "PUT");
  assert.deepEqual(await native.listDiscordPins(channel, context), [
    { id: "m1", channel_id: "111", content: "Rules" },
  ]);
  await native.setDiscordPin({ ...channel, messageId: "m1", pinned: true }, context);
  assert.deepEqual(
    await native.createDiscordThread({ ...channel, name: "Q&A", messageId: "m1" }, context),
    {
      id: "th1",
      name: "Q&A",
    },
  );
  assert.deepEqual(calls[11]?.body, { name: "Q&A", messageId: "m1" });
  await native.crosspostDiscordMessage({ ...channel, messageId: "m1" }, context);
  await native.deleteDiscordMessage({ ...channel, messageId: "m1" }, context);
  assert.equal(calls[13]?.method, "DELETE");
  assert.equal(
    (await native.listDiscordEvents({ ...guild, withUserCount: true }, context)).length,
    1,
  );
  assert.deepEqual(calls[14]?.query, { accountId: "dc1", withUserCount: "true" });
  await native.createDiscordEvent(
    {
      ...guild,
      name: "Launch",
      startsAt: "2026-12-01T18:00:00Z",
      entity: { type: "external", location: "Zoom", endsAt: "2026-12-01T19:00:00Z" },
    },
    context,
  );
  assert.deepEqual(calls[15]?.body, {
    accountId: "dc1",
    name: "Launch",
    startsAt: "2026-12-01T18:00:00Z",
    entity: { type: "external", location: "Zoom", endsAt: "2026-12-01T19:00:00Z" },
  });
  assert.deepEqual(calls[15]?.query, {});
  assert.equal(
    (await native.updateDiscordEvent({ ...guild, eventId: "e1", status: "cancelled" }, context))[
      "status"
    ],
    4,
  );
  assert.deepEqual(calls[16]?.body, { accountId: "dc1", status: "cancelled" });
  await native.deleteDiscordEvent({ ...guild, eventId: "e1" }, context);
  await assert.rejects(native.listDiscordRoles({ account: bot, guildId: "server" }, context), {
    code: "invalid_input",
  });
  await assert.rejects(
    native.listDiscordRoles({ account: account("x"), guildId: "999" }, context),
    {
      code: "invalid_input",
    },
  );
});

it("decodes account.permissions_changed, conversation.started and referral.received webhooks", async () => {
  const decode = (event: string, extra: JsonObject) =>
    decodeWebhook({
      provider: "zernio",
      backend: "managed",
      body: new TextEncoder().encode(JSON.stringify({ id: `evt-${event}`, event, ...extra })),
    });

  const account = { accountId: "acc1", platform: "instagram" };

  assert.equal((await decode("account.permissions_changed", { account })).type, "account.updated");
  assert.equal((await decode("account.rate_limited", { account })).type, "account.updated");
  assert.equal(
    (await decode("conversation.started", { account, conversation: { id: "c1" } })).type,
    "conversation.updated",
  );
  assert.equal(
    (await decode("conversation.control_changed", { account, conversation: { id: "c1" } })).type,
    "conversation.updated",
  );
  assert.equal((await decode("referral.received", { account })).type, "message.referral");
  assert.equal((await decode("message.played", { account })).type, "message.updated");
  assert.equal((await decode("analytics.synced", { account })).type, "insights.updated");
  assert.equal((await decode("webhook.test", { message: "Test" })).type, "unknown");

  const started = await decode("conversation.started", { account, conversation: { id: "c1" } });

  assert.deepEqual(started.accountIds, ["acc1"]);
  assert.equal(started.originalType, "conversation.started");
});

const postRef = (platform: string, accountId: string, postId: string): PlatformPostRef => ({
  kind: "platform-post",
  version: 1,
  backend: "default",
  platform,
  accountId,
  postId,
});

const conversationRef = (platform: string, accountId: string): ConversationRef => ({
  kind: "conversation",
  version: 1,
  backend: "default",
  platform,
  accountId,
  conversationId: "conv1",
});

const commentRef = (platform: string, accountId: string): CommentRef => ({
  kind: "comment",
  version: 1,
  backend: "default",
  platform,
  accountId,
  postId: "post1",
  commentId: "c1",
});

it("reads post-timeline, the analytics/delta cursor feed and the dashboard", async () => {
  const delivery: DeliveryRef = {
    kind: "delivery",
    version: 1,
    backend: "default",
    platform: "instagram",
    accountId: "ig1",
    deliveryId: "post1",
  };

  const { native, calls } = fake({
    "GET /v1/analytics/post-timeline": {
      postId: "post1",
      timeline: [
        {
          date: "2026-11-01",
          platform: "instagram",
          impressions: 10,
          likes: 2,
          impressionSources: {},
        },
      ],
    },
    "GET /v1/analytics/delta": {
      data: [
        {
          postId: "p1",
          accountId: "ig1",
          platform: "instagram",
          isDeleted: false,
          metrics: { likes: 3 },
        },
        { postId: "p2", accountId: "other", platform: "instagram", metrics: {} },
      ],
      nextCursor: "cur2",
      hasMore: false,
    },
    "GET /v1/analytics/dashboard": {
      dateRange: { fromDate: "2026-10-01", toDate: "2026-10-31" },
      totals: { impressions: 100 },
      followers: { current: 50, gained: 5, byAccount: [] },
      daily: [],
      topPosts: [],
      recentPosts: [],
      dataAsOf: "2026-11-01T00:00:00Z",
    },
  });

  assert.deepEqual(
    await native.postTimeline({ delivery, fromDate: "2026-11-01T00:00:00Z" }, context),
    [{ date: "2026-11-01", platform: "instagram", impressions: 10, likes: 2 }],
  );
  assert.deepEqual(calls[0]?.query, { postId: "post1", fromDate: "2026-11-01T00:00:00Z" });
  assert.deepEqual(
    await native.analyticsDelta(
      { accounts: [account("instagram", "ig1")], cursor: "cur1" },
      context,
    ),
    {
      changes: [
        {
          postId: "p1",
          accountId: "ig1",
          platform: "instagram",
          isDeleted: false,
          metrics: { likes: 3 },
        },
      ],
      nextCursor: "cur2",
      hasMore: false,
    },
  );
  assert.deepEqual(calls[1]?.query, { limit: "50", cursor: "cur1", platform: "instagram" });

  const dashboard = await native.analyticsDashboard(
    { fromDate: "2026-10-01", toDate: "2026-10-31", comparePrevious: true, topPosts: 3 },
    context,
  );

  assert.deepEqual(dashboard["totals"], { impressions: 100 });
  assert.deepEqual(calls[2]?.query, {
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
    compare: "previous_period",
    topPosts: "3",
  });
});

it("reads follower-history, online-followers, story insights, post-earnings, reactions, LinkedIn stats and search-keywords", async () => {
  const { native, calls } = fake({
    "GET /v1/analytics/instagram/follower-history": {
      success: true,
      metricType: "time_series",
      metrics: { follower_count: [{ date: "2026-11-01", value: 10 }] },
      unavailableMetrics: [],
    },
    "GET /v1/analytics/instagram/online-followers": {
      days: [{ endTime: "2026-11-01T07:00:00Z", hours: { "0": 12 } }],
      note: "Last 7 days",
    },
    "GET /v1/accounts/ig1/instagram/stories/s1/insights": {
      data: { source: "live", metrics: { reach: 40 } },
    },
    "GET /v1/analytics/facebook/post-earnings": {
      period: "lifetime",
      metrics: { earnings: 1.5 },
      unavailableMetrics: [],
    },
    "GET /v1/accounts/fb1/facebook-post-reactions": { total: 3, breakdown: { like: 2, love: 1 } },
    "GET /v1/accounts/li1/linkedin-post-analytics": {
      postUrn: "urn:li:share:1",
      analytics: { impressions: 120, likes: 4 },
    },
    "GET /v1/accounts/li1/linkedin-post-reactions": {
      reactions: [
        { reactionType: "LIKE", reactedAt: "t", from: { id: "m1", name: "Ana", email: "dropped" } },
      ],
      pagination: { hasMore: true, cursor: "25", total: 30 },
    },
    "GET /v1/accounts/li1/linkedin-aggregate-analytics": {
      aggregation: "TOTAL",
      analytics: { impressions: 900 },
    },
    "GET /v1/analytics/googlebusiness/search-keywords": {
      keywords: [{ keyword: "bakery near me", impressions: 120, impressionsThreshold: null }],
      nextPageToken: null,
    },
  });

  const instagram = account("instagram", "ig1");

  assert.deepEqual(
    (
      await native.instagramFollowerHistory({ account: instagram, fromDate: "2026-10-01" }, context)
    )["metrics"],
    { follower_count: [{ date: "2026-11-01", value: 10 }] },
  );
  assert.deepEqual(calls[0]?.query, { accountId: "ig1", fromDate: "2026-10-01" });
  assert.deepEqual(await native.instagramOnlineFollowers({ account: instagram }, context), {
    days: [{ endTime: "2026-11-01T07:00:00Z", hours: { "0": 12 } }],
    note: "Last 7 days",
  });
  assert.deepEqual(
    await native.instagramStoryInsights({ account: instagram, storyId: "s1" }, context),
    {
      source: "live",
      metrics: { reach: 40 },
    },
  );
  assert.deepEqual(
    (await native.facebookPostEarnings({ post: postRef("facebook", "fb1", "p_1") }, context))[
      "metrics"
    ],
    { earnings: 1.5 },
  );
  assert.deepEqual(calls[3]?.query, { accountId: "fb1", postId: "p_1" });
  assert.deepEqual(
    await native.facebookPostReactions({ post: postRef("facebook", "fb1", "p_1") }, context),
    {
      total: 3,
      breakdown: { like: 2, love: 1 },
    },
  );
  assert.deepEqual(
    (
      await native.linkedInPostAnalytics(
        { post: postRef("linkedin", "li1", "urn:li:share:1") },
        context,
      )
    )["analytics"],
    { impressions: 120, likes: 4 },
  );
  assert.deepEqual(calls[5]?.query, { urn: "urn:li:share:1" });
  assert.deepEqual(
    await native.linkedInPostReactions(
      { post: postRef("linkedin", "li1", "urn:li:share:1") },
      context,
    ),
    {
      reactions: [{ reactionType: "LIKE", reactedAt: "t", from: { id: "m1", name: "Ana" } }],
      nextCursor: "25",
      total: 30,
    },
  );
  assert.deepEqual(
    (
      await native.linkedInAggregateAnalytics(
        { account: account("linkedin", "li1"), aggregation: "TOTAL" },
        context,
      )
    )["analytics"],
    { impressions: 900 },
  );
  assert.deepEqual(
    await native.googleBusinessSearchKeywords(
      { account: account("google-business", "gbp1"), startMonth: "2026-09", endMonth: "2026-10" },
      context,
    ),
    { keywords: [{ keyword: "bakery near me", impressions: 120, impressionsThreshold: null }] },
  );
  await assert.rejects(native.instagramOnlineFollowers({ account: account("x") }, context), {
    code: "invalid_input",
  });
});

it("reads Google Business Profile performance metrics as typed daily series", async () => {
  const { native, calls } = fake({
    "GET /v1/analytics/googlebusiness/performance": {
      success: true,
      accountId: "gbp1",
      platform: "googlebusiness",
      dateRange: { startDate: "2026-10-01", endDate: "2026-10-31" },
      metrics: {
        WEBSITE_CLICKS: {
          total: 4,
          values: [
            { date: "2026-10-01", value: 3 },
            { date: "2026-10-02", value: 1 },
          ],
        },
        CALL_CLICKS: { values: [{ date: "2026-10-01", value: 1 }] },
        UNDOCUMENTED_METRIC: { total: 9, values: [] },
      },
      dataDelay: "Data may be delayed 2-3 days",
    },
  });

  const gbp = account("google-business", "gbp1");

  assert.deepEqual(
    await native.googleBusinessPerformance(
      {
        account: gbp,
        metrics: ["WEBSITE_CLICKS", "CALL_CLICKS", "WEBSITE_CLICKS"],
        fromDate: "2026-10-01",
        toDate: "2026-10-31",
      },
      context,
    ),
    {
      accountId: "gbp1",
      dateRange: { startDate: "2026-10-01", endDate: "2026-10-31" },
      dataDelay: "Data may be delayed 2-3 days",
      metrics: {
        WEBSITE_CLICKS: {
          total: 4,
          values: [
            { date: "2026-10-01", value: 3 },
            { date: "2026-10-02", value: 1 },
          ],
        },
        CALL_CLICKS: { values: [{ date: "2026-10-01", value: 1 }] },
      },
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.path, "/v1/analytics/googlebusiness/performance");
  assert.equal(calls[0]?.body, undefined);
  assert.deepEqual(calls[0]?.query, {
    accountId: "gbp1",
    metrics: "WEBSITE_CLICKS,CALL_CLICKS",
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
  });

  await native.googleBusinessPerformance({ account: gbp }, context);
  assert.deepEqual(calls[1]?.query, { accountId: "gbp1" });

  for (const input of [
    { account: account("instagram", "ig1") },
    { account: gbp, metrics: [] },
    { account: gbp, fromDate: "2026-10" },
    { account: gbp, toDate: "31/10/2026" },
    { account: gbp, fromDate: "2026-10-31", toDate: "2026-10-01" },
  ])
    await assert.rejects(native.googleBusinessPerformance(input, context), {
      code: "invalid_input",
    });

  assert.equal(calls.length, 2);

  const other = fake({
    "GET /v1/analytics/googlebusiness/performance": { accountId: "someone-else", metrics: {} },
  });

  await assert.rejects(other.native.googleBusinessPerformance({ account: gbp }, context), {
    code: "unauthorized",
  });

  const malformed = fake({
    "GET /v1/analytics/googlebusiness/performance": {
      accountId: "gbp1",
      metrics: { CALL_CLICKS: { values: [{ date: "2026-10-01", value: "1" }] } },
    },
  });

  await assert.rejects(malformed.native.googleBusinessPerformance({ account: gbp }, context));
});

it("reads analytics/inbox volume, heatmap, response time and conversation reports", async () => {
  const { native, calls } = fake({
    "GET /v1/analytics/inbox/volume": {
      success: true,
      from: "2026-10-01",
      summary: { received: 10, sent: 8 },
      timeseries: [],
      byPlatform: [],
    },
    "GET /v1/analytics/inbox/response-time": {
      summary: { sampleSize: 5, medianSeconds: 120, p90Seconds: 600 },
      histogram: [],
    },
    "GET /v1/analytics/inbox/heatmap": { buckets: [{ dow: 1, hour: 9, received: 3 }] },
    "GET /v1/analytics/inbox/conversations/conv1": {
      summary: { totalMessages: 4 },
      timeseries: [],
      bySource: [{ source: "dm", count: 4 }],
    },
  });

  assert.deepEqual(
    (
      await native.inboxAnalytics(
        { report: "volume", fromDate: "2026-10-01", account: account("instagram", "ig1") },
        context,
      )
    )["summary"],
    { received: 10, sent: 8 },
  );
  assert.deepEqual(calls[0]?.query, {
    fromDate: "2026-10-01",
    accountId: "ig1",
    platform: "instagram",
  });
  assert.deepEqual(
    (await native.inboxAnalytics({ report: "response-time", fromDate: "2026-10-01" }, context))[
      "summary"
    ],
    { sampleSize: 5, medianSeconds: 120, p90Seconds: 600 },
  );
  assert.deepEqual(
    (
      await native.inboxAnalytics(
        { report: "heatmap", fromDate: "2026-10-01", platform: "facebook" },
        context,
      )
    )["buckets"],
    [{ dow: 1, hour: 9, received: 3 }],
  );
  assert.deepEqual(
    await native.conversationAnalytics(
      { conversation: conversationRef("instagram", "ig1"), fromDate: "2026-10-01" },
      context,
    ),
    { summary: { totalMessages: 4 }, timeseries: [], bySource: [{ source: "dm", count: 4 }] },
  );
  await assert.rejects(native.inboxAnalytics({ report: "volume", fromDate: "October" }, context), {
    code: "invalid_input",
  });
});

it("edits a Reddit comment and sets YouTube heldForReview moderation", async () => {
  const { native, calls } = fake({
    "PATCH /v1/inbox/comments/post1/c1": { status: "edited", commentId: "c1", platform: "reddit" },
    "POST /v1/inbox/comments/post1/c1/moderation": { success: true },
  });

  await native.editComment({ comment: commentRef("reddit", "rd1"), text: "Fixed typo" }, context);
  assert.deepEqual(calls[0]?.body, { accountId: "rd1", platform: "reddit", content: "Fixed typo" });
  await native.setCommentModerationStatus(
    { comment: commentRef("youtube", "yt1"), status: "heldForReview" },
    context,
  );
  assert.deepEqual(calls[1]?.body, {
    accountId: "yt1",
    platform: "youtube",
    moderationStatus: "heldForReview",
  });
  await assert.rejects(
    native.setCommentModerationStatus(
      { comment: commentRef("youtube", "yt1"), status: "published", banAuthor: true },
      context,
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.editComment({ comment: commentRef("x", "x1"), text: "no" }, context),
    {
      code: "invalid_input",
    },
  );
});

it("searches, archives, deletes, accepts, hands over with thread-control and labels conversations", async () => {
  const { native, calls } = fake({
    "GET /v1/inbox/conversations/search": {
      data: [
        {
          conversation: { id: "conv1", platform: "instagram", accountId: "ig1", token: "dropped" },
          matchCount: 2,
          matches: [],
        },
      ],
      pagination: { hasMore: false, nextCursor: null },
    },
    "PUT /v1/inbox/conversations/conv1": {
      success: true,
      data: { id: "conv1", status: "archived" },
    },
    "DELETE /v1/inbox/conversations/conv1": {
      success: true,
      data: { id: "conv1", deletedMessages: 12 },
    },
    "POST /v1/inbox/conversations/conv1/accept": { success: true, data: { messageId: "m9" } },
    "POST /v1/inbox/conversations/conv1/thread-control": {
      success: true,
      control: { owner: "app", ownerAppId: "123" },
    },
    "GET /v1/inbox/labels": { labels: [{ id: "l1", name: "VIP" }] },
    "POST /v1/inbox/labels": { label: { id: "l2", name: "Lead" } },
    "DELETE /v1/inbox/labels/l2": { success: true },
    "GET /v1/inbox/conversations/conv1/labels": { labels: [{ id: "l1", name: "VIP" }] },
    "POST /v1/inbox/conversations/conv1/labels": { success: true },
    "DELETE /v1/inbox/conversations/conv1/labels/l1": { success: true },
  });

  const conversation = conversationRef("facebook", "fb1");
  const page = account("facebook", "fb1");

  assert.deepEqual(
    await native.searchConversations(
      { query: "refund", account: account("instagram", "ig1") },
      context,
    ),
    {
      results: [
        { conversation: { id: "conv1", platform: "instagram", accountId: "ig1" }, matchCount: 2 },
      ],
    },
  );
  assert.deepEqual(calls[0]?.query, { query: "refund", accountId: "ig1", platform: "instagram" });
  await native.setConversationStatus({ conversation, status: "archived" }, context);
  assert.deepEqual(calls[1]?.body, { accountId: "fb1", status: "archived" });
  assert.deepEqual(await native.deleteConversation({ conversation }, context), {
    deletedMessages: 12,
  });
  assert.deepEqual(calls[2]?.query, { accountId: "fb1" });
  assert.deepEqual(
    await native.acceptMessageRequest({ conversation, text: "Hi, happy to help" }, context),
    {
      messageId: "m9",
    },
  );
  assert.deepEqual(calls[3]?.body, { accountId: "fb1", message: "Hi, happy to help" });
  assert.deepEqual(await native.threadControl({ conversation, action: "take" }, context), {
    owner: "app",
    ownerAppId: "123",
  });
  assert.deepEqual(calls[4]?.body, { accountId: "fb1", action: "take" });
  assert.deepEqual(await native.listInboxLabels({ account: page }, context), [
    { id: "l1", name: "VIP" },
  ]);
  assert.deepEqual(await native.createInboxLabel({ account: page, name: "Lead" }, context), {
    id: "l2",
    name: "Lead",
  });
  await native.deleteInboxLabel({ account: page, labelId: "l2" }, context);
  assert.deepEqual(await native.listConversationLabels({ conversation }, context), [
    { id: "l1", name: "VIP" },
  ]);
  await native.setConversationLabel({ conversation, labelId: "l1", applied: true }, context);
  assert.deepEqual(calls[9]?.body, { accountId: "fb1", labelId: "l1" });
  await native.setConversationLabel({ conversation, labelId: "l1", applied: false }, context);
  assert.equal(calls[10]?.method, "DELETE");
  await assert.rejects(native.threadControl({ conversation, action: "pass" }, context), {
    code: "invalid_input",
  });
});

it("reads and sets messenger-menu, greeting, ice-breakers and telegram-commands", async () => {
  const { native, calls } = fake({
    "GET /v1/accounts/fb1/messenger-menu": { data: [{ locale: "default", call_to_actions: [] }] },
    "PUT /v1/accounts/fb1/messenger-menu": {},
    "PUT /v1/accounts/fb1/messenger-greeting": { success: true },
    "PUT /v1/accounts/fb1/messenger-ice-breakers": { success: true },
    "PUT /v1/accounts/ig1/instagram-ice-breakers": {},
    "GET /v1/accounts/tg1/telegram-commands": {
      data: [{ command: "start", description: "Start" }],
    },
    "PUT /v1/accounts/tg1/telegram-commands": {},
    "DELETE /v1/accounts/fb1/messenger-get-started": { success: true },
    "PUT /v1/accounts/fb1/messenger-get-started": { success: true },
  });

  const facebook = account("facebook", "fb1");
  const instagram = account("instagram", "ig1");
  const telegram = account("telegram", "tg1");

  assert.deepEqual(
    await native.getBotSetting({ account: facebook, setting: "messenger-menu" }, context),
    {
      value: [{ locale: "default", call_to_actions: [] }],
    },
  );
  await native.setBotSetting(
    {
      account: facebook,
      setting: "messenger-menu",
      persistentMenu: [{ locale: "default", call_to_actions: [] }],
    },
    context,
  );
  assert.deepEqual(calls[1]?.body, {
    persistent_menu: [{ locale: "default", call_to_actions: [] }],
  });
  await native.setBotSetting(
    {
      account: facebook,
      setting: "messenger-greeting",
      greetings: [{ locale: "default", text: "Hi!" }],
    },
    context,
  );
  assert.deepEqual(calls[2]?.body, { greeting: [{ locale: "default", text: "Hi!" }] });
  await native.setBotSetting(
    {
      account: facebook,
      setting: "ice-breakers",
      iceBreakers: [
        { locale: "default", questions: [{ question: "Opening hours?", payload: "HOURS" }] },
      ],
    },
    context,
  );
  assert.deepEqual(calls[3]?.body, {
    ice_breakers: [
      { locale: "default", call_to_actions: [{ question: "Opening hours?", payload: "HOURS" }] },
    ],
  });
  await native.setBotSetting(
    {
      account: instagram,
      setting: "ice-breakers",
      iceBreakers: [{ questions: [{ question: "Prices?", payload: "PRICES" }] }],
    },
    context,
  );
  assert.equal(calls[4]?.path, "/v1/accounts/ig1/instagram-ice-breakers");
  assert.deepEqual(calls[4]?.body, { ice_breakers: [{ question: "Prices?", payload: "PRICES" }] });
  assert.deepEqual(
    await native.getBotSetting({ account: telegram, setting: "telegram-commands" }, context),
    {
      value: [{ command: "start", description: "Start" }],
    },
  );
  await native.setBotSetting(
    {
      account: telegram,
      setting: "telegram-commands",
      commands: [{ command: "help", description: "Get help" }],
    },
    context,
  );
  assert.deepEqual(calls[6]?.body, { commands: [{ command: "help", description: "Get help" }] });
  await native.deleteBotSetting({ account: facebook, setting: "messenger-get-started" }, context);
  assert.equal(calls[7]?.method, "DELETE");
  await assert.rejects(
    native.setBotSetting(
      {
        account: telegram,
        setting: "telegram-commands",
        commands: [{ command: "/Help", description: "x" }],
      },
      context,
    ),
    { code: "invalid_input" },
  );
  await assert.rejects(
    native.getBotSetting({ account: instagram, setting: "messenger-menu" }, context),
    {
      code: "invalid_input",
    },
  );
  await assert.rejects(
    native.setBotSetting(
      {
        account: facebook,
        setting: "messenger-greeting",
        greetings: [{ locale: "en_US", text: "Hi" }],
      },
      context,
    ),
    { code: "invalid_input" },
  );
});
