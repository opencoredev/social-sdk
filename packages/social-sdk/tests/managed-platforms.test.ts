import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { buffer } from "../src/cloud/buffer.js";
import { normalizePlatform } from "../src/cloud/common.js";
import { postForMe } from "../src/cloud/post-for-me.js";
import { postfast } from "../src/cloud/postfast.js";
import { postiz } from "../src/cloud/postiz.js";
import { zernio } from "../src/cloud/zernio.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object, string } from "../src/transport/validation.js";
import type { AdapterOperationContext, JsonObject } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const clock = () => new Date("2026-10-09T12:00:00.000Z");

const future = "2026-10-10T15:00:00.000Z";

const ref = (platform: string, accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

const body = (init?: RequestInit): JsonObject => {
  const parsed: unknown = JSON.parse(String(init?.body));

  if (!isJsonValue(parsed)) throw new Error("Fixture body must be JSON.");

  return object(parsed);
};

const image = {
  kind: "image",
  mimeType: "image/png",
  source: { kind: "https-url", url: "https://cdn.example.test/pin.png" },
} as const;

const newPlatforms = [
  "pinterest",
  "reddit",
  "mastodon",
  "telegram",
  "discord",
  "google-business",
  "snapchat",
  "whatsapp",
  "twitch",
] as const;

it("normalizes provider aliases to Social SDK platform slugs", () => {
  for (const [input, expected] of [
    ["twitter", "x"],
    ["X", "x"],
    ["gmb", "google-business"],
    ["googlebusiness", "google-business"],
    ["GOOGLE_BUSINESS_PROFILE", "google-business"],
    ["google_business", "google-business"],
    ["Pinterest", "pinterest"],
    ["lemmy", "lemmy"],
  ] as const)
    assert.equal(normalizePlatform(input), expected);
});

it("Zernio lists and reads accounts on the extra platforms", async () => {
  const rows = [
    { _id: "a1", platform: "pinterest", username: "pins" },
    { _id: "a2", platform: "reddit", username: "u" },
    { _id: "a3", platform: "googlebusiness", username: "shop" },
    { _id: "a4", platform: "telegram", username: "chan" },
    { _id: "a5", platform: "discord", username: "srv" },
    { _id: "a6", platform: "snapchat", username: "snap" },
    { _id: "a7", platform: "whatsapp", username: "wa" },
    { _id: "a8", platform: "slack", username: "ws" },
  ];

  const adapter = zernio({
    apiKey: "test",
    fetch: async (input) => {
      const platform = new URL(String(input)).searchParams.get("platform");

      return Response.json({
        accounts: rows.filter((row) => platform === null || row.platform === platform),
      });
    },
  });

  const listed = await adapter.accounts.list({ limit: 25 }, context);

  assert.deepEqual(
    listed.items.map((item) => item.ref.platform),
    ["pinterest", "reddit", "google-business", "telegram", "discord", "snapchat", "whatsapp"],
  );
  assert.equal(
    (await adapter.accounts.get(ref("google-business", "a3"), context)).ref.accountId,
    "a3",
  );
});

it("Post for Me, PostFast, Postiz and Buffer list the extra platforms", async () => {
  const pfm = postForMe({
    apiKey: "test",
    fetch: async () =>
      Response.json({
        data: [
          { id: "a1", platform: "pinterest", user_id: "u1" },
          { id: "a2", platform: "tiktok_business", user_id: "u2" },
        ],
        meta: { next: null },
      }),
  });

  assert.deepEqual(
    (await pfm.accounts.list({}, context)).items.map((item) => item.ref.platform),
    ["pinterest"],
  );

  const fast = postfast({
    apiKey: "test",
    fetch: async () =>
      Response.json([
        { id: "f1", platform: "PINTEREST", platformUsername: "pins" },
        { id: "f2", platform: "TELEGRAM", platformUsername: "chan" },
        { id: "f3", platform: "GOOGLE_BUSINESS_PROFILE", platformUsername: "shop" },
      ]),
  });

  assert.deepEqual(
    (await fast.accounts.list({}, context)).items.map((item) => item.ref.platform),
    ["pinterest", "telegram", "google-business"],
  );

  const identifiers = ["pinterest", "reddit", "gmb", "mastodon", "telegram", "discord", "twitch"];

  const hub = postiz({
    apiKey: "test",
    fetch: async () =>
      Response.json(
        identifiers.map((identifier, index) => ({
          id: `i${index}`,
          name: identifier,
          identifier,
          profile: identifier,
          disabled: false,
        })),
      ),
  });

  assert.deepEqual(
    (await hub.accounts.list({ limit: 100 }, context)).items.map((item) => item.ref.platform),
    ["pinterest", "reddit", "google-business", "mastodon", "telegram", "discord", "twitch"],
  );

  const services = ["pinterest", "mastodon", "googlebusiness", "whatsapp"];

  const buf = buffer({
    apiKey: "test",
    organizationId: "org1",
    fetch: async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      const query = isJsonValue(parsed) ? string(object(parsed)["query"]) : "";

      if (query.includes("query Channels"))
        return Response.json({
          data: {
            channels: services.map((service, index) => ({
              id: `c${index}`,
              name: service,
              displayName: service,
              service,
              organizationId: "org1",
            })),
          },
        });

      return Response.json({ data: null, errors: [{ message: "unexpected" }] });
    },
  });

  assert.deepEqual(
    (await buf.accounts.list({ limit: 100 }, context)).items.map((item) => item.ref.platform),
    ["pinterest", "mastodon", "google-business", "whatsapp"],
  );
});

it("unknownPlatforms: include lists unrecognized networks under the provider's identifier", async () => {
  const rows = [
    { _id: "a1", platform: "twitter", username: "x" },
    { _id: "a2", platform: "slack", username: "ws" },
  ];

  const skipping = zernio({ apiKey: "test", fetch: async () => Response.json({ accounts: rows }) });

  assert.deepEqual(
    (await skipping.accounts.list({}, context)).items.map((item) => item.ref.platform),
    ["x"],
  );

  const including = zernio({
    apiKey: "test",
    unknownPlatforms: "include",
    fetch: async () => Response.json({ accounts: rows }),
  });

  const listed = await including.accounts.list({}, context);

  assert.deepEqual(
    listed.items.map((item) => item.ref.platform),
    ["x", "slack"],
  );
  assert.equal((await including.accounts.get(ref("slack", "a2"), context)).ref.platform, "slack");

  const social = createSocial({ backend: including });

  // Publishing needs a platform the backend declares, so an included network stays read-only.
  assert.ok(
    social.posts
      .prepare({ targets: [{ account: ref("slack", "a2") }], content: { text: "hi" } })
      .issues.some((issue) => issue.code === "capability.unavailable"),
  );
});

it("Zernio publishes to the extra platforms with their documented platform data", async () => {
  const sent: JsonObject[] = [];

  const adapter = zernio({
    apiKey: "test",
    fetch: async (_input, init) => {
      const payload = body(init);
      sent.push(payload);

      return Response.json({
        post: { _id: "p1", status: "publishing", platforms: [] },
      });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  await social.posts.publish({
    targets: [
      {
        account: ref("pinterest", "pin1"),
        options: { boardId: "123", title: "Pin", link: "https://example.test/p" },
      },
      {
        account: ref("reddit", "red1"),
        options: { subreddit: "r/typescript", title: "Hello", nsfw: false },
      },
      { account: ref("discord", "dis1"), options: { channelId: "999" } },
      { account: ref("google-business", "gbp1"), options: { locationId: "locations/1" } },
      { account: ref("snapchat", "snap1"), options: { contentType: "spotlight" } },
      { account: ref("telegram", "tg1") },
    ],
    content: { text: "launch", media: [image] },
  });

  const byAccount = new Map(
    sent.map((payload) => {
      const [destination] = Array.isArray(payload["platforms"]) ? payload["platforms"] : [];

      return [string(object(destination ?? {})["accountId"]), object(destination ?? {})];
    }),
  );

  assert.deepEqual(byAccount.get("pin1"), {
    platform: "pinterest",
    accountId: "pin1",
    platformSpecificData: { boardId: "123", title: "Pin", link: "https://example.test/p" },
  });
  assert.deepEqual(byAccount.get("red1")?.["platformSpecificData"], {
    subreddit: "typescript",
    title: "Hello",
    nsfw: false,
  });
  assert.deepEqual(byAccount.get("dis1")?.["platformSpecificData"], { channelId: "999" });
  assert.equal(byAccount.get("gbp1")?.["platform"], "googlebusiness");
  assert.deepEqual(byAccount.get("gbp1")?.["platformSpecificData"], { locationId: "locations/1" });
  assert.deepEqual(byAccount.get("snap1")?.["platformSpecificData"], { contentType: "spotlight" });
  assert.equal(byAccount.get("tg1")?.["platform"], "telegram");
  assert.equal(byAccount.get("tg1")?.["platformSpecificData"], undefined);
});

it("Zernio account metrics keep reading account pages until the account appears", async () => {
  const pages: string[] = [];

  const adapter = zernio({
    apiKey: "test",
    fetch: async (input) => {
      const page = new URL(String(input)).searchParams.get("page") ?? "1";
      pages.push(page);

      return Response.json({
        accounts:
          page === "2"
            ? [{ _id: "late", platform: "twitter", username: "x", followersCount: 42 }]
            : [{ _id: "early", platform: "twitter", username: "y" }],
        pagination: { pages: 2 },
      });
    },
  });

  const metrics = await adapter.analytics.getAccountMetrics(ref("x", "late"), context);

  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(metrics[0]?.value, 42);
});

it("Post for Me maps Pinterest boards", async () => {
  const sent: JsonObject[] = [];

  const adapter = postForMe({
    apiKey: "test",
    fetch: async (_input, init) => {
      sent.push(body(init));

      return Response.json({ id: "parent", status: "processing" });
    },
  });

  await createSocial({ backend: adapter, clock }).posts.publish({
    targets: [
      {
        account: ref("pinterest", "pin1"),
        options: { boardId: "123", title: "Pin", link: "https://example.test/p" },
      },
    ],
    content: { text: "launch", media: [image] },
  });

  assert.deepEqual(object(sent[0]?.["platform_configurations"] ?? {})["pinterest"], {
    board_ids: ["123"],
    title: "Pin",
    link: "https://example.test/p",
  });
});

it("PostFast publishes Pinterest, Telegram and Google Business, and exposes isShort", async () => {
  const sent: JsonObject[] = [];

  const adapter = postfast({
    apiKey: "test",
    clock,
    uploadHostAllowed: (hostname) => hostname === "storage.example.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));

      if (url.hostname === "storage.example.test") return new Response(null, { status: 200 });

      if (url.pathname === "/file/get-signed-upload-urls")
        return Response.json(
          [{ key: "media/m1", signedUrl: "https://storage.example.test/media/m1?sig=1" }],
          { status: 201 },
        );

      if (init?.method === "POST") {
        sent.push(body(init));

        return Response.json({ postIds: ["p1"] }, { status: 201 });
      }

      return Response.json({}, { status: 404 });
    },
  });

  const social = createSocial({ backend: adapter, clock });
  const controlsOf = () => object(sent.at(-1)?.["controls"] ?? {});

  const uploaded = (kind: "image" | "video", fingerprint: string) =>
    ({
      kind,
      mimeType: kind === "image" ? "image/png" : "video/mp4",
      filename: kind === "image" ? "pin.png" : "clip.mp4",
      source: { kind: "blob", blob: new Blob([new Uint8Array(1)]), fingerprint },
    }) as const;

  // PostFast takes uploaded files only, so a URL-only pin is rejected before dispatch.
  assert.ok(
    social.posts
      .prepare({
        targets: [{ account: ref("pinterest", "pin1"), options: { boardId: "123" } }],
        content: { text: "launch", media: [image] },
        schedule: { at: future },
      })
      .issues.some((issue) => issue.code === "media.url_unsupported"),
  );

  await social.posts.publish({
    targets: [
      {
        account: ref("pinterest", "pin1"),
        options: { boardId: "123", link: "https://example.test/p" },
      },
    ],
    content: { text: "launch", media: [uploaded("image", "i1")] },
    schedule: { at: future },
  });
  assert.deepEqual(controlsOf(), {
    pinterestBoardId: "123",
    pinterestLink: "https://example.test/p",
  });

  await social.posts.publish({
    targets: [{ account: ref("telegram", "tg1") }],
    content: { text: "launch" },
    schedule: { at: future },
  });
  assert.equal(sent.at(-1)?.["controls"], undefined);

  await social.posts.publish({
    targets: [{ account: ref("google-business", "gbp1"), options: { locationId: "locations/1" } }],
    content: { text: "launch" },
    schedule: { at: future },
  });
  assert.deepEqual(controlsOf(), { gbpLocationId: "locations/1" });

  const youtube = async (isShort?: boolean) => {
    const base = { title: "Demo", visibility: "private", madeForKids: false } as const;
    const options = isShort === undefined ? base : { ...base, isShort };

    await social.posts.publish({
      targets: [{ account: ref("youtube", "yt1"), options }],
      content: { text: "demo", media: [uploaded("video", `v${String(isShort)}`)] },
      schedule: { at: future },
    });

    return controlsOf()["youtubeIsShort"];
  };

  assert.equal(await youtube(true), true);
  assert.equal(await youtube(false), false);
  assert.equal(await youtube(), false);
});

it("Postiz maps Pinterest, Reddit, Discord and TikTok inbox-draft titles", async () => {
  const sent: JsonObject[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (_input, init) => {
      if (init?.method === "POST") {
        const payload = body(init);

        // Media goes through the upload endpoint before the post is created.
        if (payload["posts"] === undefined)
          return Response.json({ id: "m1", path: "https://cdn.example.test/m1.png" });
        sent.push(payload);

        return Response.json([{ postId: "p1", integration: "i1" }]);
      }

      return Response.json({ posts: [] });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  const settingsOf = (index: number) => {
    const [first] = array(sent[index]?.["posts"] ?? []);

    return object(object(first ?? {})["settings"] ?? {});
  };

  await social.posts.publish({
    targets: [
      {
        account: ref("pinterest", "i1"),
        options: { boardId: "123", title: "Pin", link: "https://example.test/p" },
      },
    ],
    content: { text: "launch", media: [image] },
  });
  await social.posts.publish({
    targets: [
      {
        account: ref("reddit", "i2"),
        options: { subreddit: "/r/typescript/", title: "Hello world" },
      },
    ],
    content: { text: "body" },
  });
  await social.posts.publish({
    targets: [{ account: ref("discord", "i3"), options: { channelId: "999" } }],
    content: { text: "ping" },
  });
  await social.posts.publish({
    targets: [{ account: ref("mastodon", "i4") }],
    content: { text: "toot" },
  });

  assert.deepEqual(settingsOf(0), {
    board: "123",
    title: "Pin",
    link: "https://example.test/p",
  });
  assert.deepEqual(settingsOf(1), {
    subreddit: [
      {
        value: {
          subreddit: "/r/typescript",
          title: "Hello world",
          type: "self",
          is_flair_required: false,
        },
      },
    ],
  });
  assert.deepEqual(settingsOf(2), { channel: "999" });
  assert.deepEqual(settingsOf(3), {});

  const tiktok = ref("tiktok", "i5");

  const choices = {
    privacy: "SELF_ONLY",
    consentGiven: true,
    disableComments: false,
    disableDuet: false,
    disableStitch: false,
    brandedContent: false,
    ownBrand: false,
    aiGenerated: false,
  } as const;

  const video = {
    kind: "video",
    mimeType: "video/mp4",
    source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
  } as const;

  const codes = (options: JsonObject) =>
    social.posts
      .prepare({ targets: [{ account: tiktok, options }], content: { text: "hi", media: [video] } })
      .issues.map((issue) => issue.code);

  assert.ok(!codes({ ...choices, draft: true, title: "Inbox title" }).includes("options.unmapped"));
  assert.ok(codes({ ...choices, draft: false, title: "Nope" }).includes("tiktok.title"));
});

it("Buffer maps Pinterest boards and LinkedIn documents", async () => {
  const seen: JsonObject[] = [];

  const adapter = buffer({
    apiKey: "test",
    organizationId: "org1",
    clock,
    fetch: async (_input, init) => {
      const parsed: unknown = JSON.parse(String(init?.body));
      const payload = isJsonValue(parsed) ? object(parsed) : {};
      const query = string(payload["query"]);
      const input = object(object(payload["variables"] ?? {})["input"] ?? {});

      if (query.includes("query Channels"))
        return Response.json({
          data: {
            channels: [
              {
                id: "pin1",
                name: "pins",
                displayName: "Pins",
                service: "pinterest",
                organizationId: "org1",
              },
              {
                id: "li1",
                name: "company",
                displayName: "Company",
                service: "linkedin",
                organizationId: "org1",
              },
            ],
          },
        });

      if (query.includes("createPost")) {
        seen.push(input);

        return Response.json({
          data: {
            createPost: {
              post: {
                id: "post1",
                text: "t",
                channelId: string(input["channelId"]),
                channelService: input["channelId"] === "pin1" ? "pinterest" : "linkedin",
                dueAt: null,
                sentAt: null,
                status: "sending",
                shareMode: "shareNow",
                externalLink: null,
                metrics: null,
              },
            },
          },
        });
      }

      return Response.json({ data: null, errors: [{ message: "unexpected" }] });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  await social.posts.publish({
    targets: [
      {
        account: ref("pinterest", "pin1"),
        options: { boardId: "123", title: "Pin", link: "https://example.test/p" },
      },
    ],
    content: { text: "launch", media: [image] },
  });

  assert.deepEqual(object(seen[0]?.["metadata"] ?? {})["pinterest"], {
    boardServiceId: "123",
    title: "Pin",
    url: "https://example.test/p",
  });

  const document = {
    kind: "document",
    mimeType: "application/pdf",
    caption: "Roadmap",
    source: { kind: "https-url", url: "https://cdn.example.test/roadmap.pdf" },
    thumbnail: { kind: "https-url", url: "https://cdn.example.test/roadmap.png" },
  } as const;

  await social.posts.publish({
    targets: [{ account: ref("linkedin", "li1") }],
    content: { text: "deck", media: [document] },
  });

  assert.deepEqual(seen[1]?.["assets"], [
    {
      document: {
        url: "https://cdn.example.test/roadmap.pdf",
        title: "Roadmap",
        thumbnailUrl: "https://cdn.example.test/roadmap.png",
      },
    },
  ]);

  const { thumbnail: _thumbnail, ...bare } = document;

  const issues = social.posts
    .prepare({
      targets: [{ account: ref("linkedin", "li1") }],
      content: { text: "d", media: [bare] },
    })
    .issues.map((issue) => issue.code);

  assert.ok(issues.includes("media.document_thumbnail"));
});

it("managed adapters require the fields each new platform needs and reject uncovered ones", () => {
  const pfm = createSocial({ backend: postForMe({ apiKey: "test" }), clock });
  const hub = createSocial({ backend: postiz({ apiKey: "test" }), clock });
  const fast = createSocial({ backend: postfast({ apiKey: "test", clock }), clock });
  const buf = createSocial({ backend: buffer({ apiKey: "test", clock }), clock });
  const zern = createSocial({ backend: zernio({ apiKey: "test" }), clock });

  const codes = (
    social: ReturnType<typeof createSocial>,
    platform: string,
    options?: JsonObject,
    media = false,
  ) =>
    social.posts
      .prepare({
        targets: [
          options === undefined
            ? { account: ref(platform, "acc") }
            : { account: ref(platform, "acc"), options },
        ],
        content: media ? { text: "hi", media: [image] } : { text: "hi" },
        schedule: { at: future },
      })
      .issues.map((issue) => issue.code);

  assert.ok(codes(hub, "pinterest", {}, true).includes("pinterest.board"));
  assert.ok(codes(hub, "pinterest", { boardId: "name" }, true).includes("pinterest.board"));
  assert.ok(codes(buf, "pinterest", {}, true).includes("pinterest.board"));
  assert.ok(codes(fast, "pinterest", {}, true).includes("pinterest.board"));
  assert.ok(!codes(pfm, "pinterest", {}, true).includes("pinterest.board"));
  assert.ok(codes(pfm, "pinterest", { boardId: "1" }).includes("media.required"));
  assert.ok(codes(zern, "reddit", {}).includes("reddit.subreddit"));
  assert.ok(codes(hub, "reddit", { subreddit: "a" }).includes("reddit.title"));
  assert.ok(codes(zern, "discord", {}).includes("discord.channel"));
  assert.ok(codes(fast, "google-business", {}).includes("google_business.location"));
  assert.ok(
    codes(zern, "snapchat", { contentType: "reel" }, true).includes("snapchat.content_type"),
  );

  // Platforms a backend does not document stay rejected rather than guessed.
  assert.ok(codes(zern, "mastodon").includes("capability.unavailable"));
  assert.ok(codes(zern, "whatsapp").includes("capability.unavailable"));
  assert.ok(codes(pfm, "reddit").includes("capability.unavailable"));
  assert.ok(codes(fast, "discord").includes("capability.unavailable"));
  assert.ok(codes(buf, "telegram").includes("capability.unavailable"));
  assert.ok(!codes(hub, "mastodon").includes("capability.unavailable"));
});

it("capability manifests declare each backend's extra platforms and nothing else", () => {
  const declared = (manifest: {
    capabilities: readonly { platform: string; operation: string }[];
  }) =>
    new Set(
      manifest.capabilities
        .filter((entry) => entry.operation === "posts.publish")
        .map((entry) => entry.platform),
    );

  const extras = (platforms: Set<string>) =>
    newPlatforms.filter((platform) => platforms.has(platform));

  assert.deepEqual(extras(declared(zernio({ apiKey: "t" }).capabilities)), [
    "pinterest",
    "reddit",
    "telegram",
    "discord",
    "google-business",
    "snapchat",
  ]);
  assert.deepEqual(extras(declared(postForMe({ apiKey: "t" }).capabilities)), ["pinterest"]);
  assert.deepEqual(extras(declared(postfast({ apiKey: "t" }).capabilities)), [
    "pinterest",
    "telegram",
    "google-business",
  ]);
  assert.deepEqual(extras(declared(postiz({ apiKey: "t" }).capabilities)), [
    "pinterest",
    "reddit",
    "mastodon",
    "telegram",
    "discord",
    "google-business",
    "twitch",
  ]);
  assert.deepEqual(extras(declared(buffer({ apiKey: "t" }).capabilities)), [
    "pinterest",
    "mastodon",
    "google-business",
  ]);
});
