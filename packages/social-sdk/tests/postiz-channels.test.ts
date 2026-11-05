import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, createSocial } from "../src/index.js";
import { postiz } from "../src/cloud/postiz.js";
import type { JsonObject, MediaAttachment, PublishContent } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object, string } from "../src/transport/validation.js";

const clock = () => new Date("2026-11-04T12:00:00.000Z");

const image = (name: string): MediaAttachment => ({
  kind: "image",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.png` },
  mimeType: "image/png",
});

const video: MediaAttachment = {
  kind: "video",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
  mimeType: "video/mp4",
};

/**
 * Publish one target to a Postiz channel whose provider identifier is `identifier`, through a
 * fake Postiz, and return the preparation issues, the create request, and the imported URLs.
 */
async function publish(
  identifier: string,
  content: PublishContent,
  options: JsonObject,
  schedule?: { readonly at: string },
) {
  const uploads: string[] = [];
  const creates: JsonObject[] = [];

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const parsed: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      const body = isJsonValue(parsed) ? object(parsed) : {};

      if (url.pathname === "/public/v1/integrations")
        return Response.json([
          { id: "int1", name: "Channel", identifier, profile: "me", disabled: false },
        ]);

      if (url.pathname === "/public/v1/upload-from-url") {
        const source = string(body["url"]);
        const name = source.slice(source.lastIndexOf("/") + 1);

        uploads.push(source);

        return Response.json({ id: `m-${name}`, path: `https://uploads.postiz.com/${name}` });
      }

      if (url.pathname === "/public/v1/posts" && init?.method === "POST") {
        creates.push(body);

        return Response.json([{ postId: "p1", integration: "int1" }]);
      }

      return Response.json({
        posts: [
          {
            id: "p1",
            publishDate: schedule?.at ?? "2026-11-04T12:00:00.000Z",
            state: "QUEUE",
            group: "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20",
            integration: { id: "int1", providerIdentifier: identifier },
          },
        ],
      });
    },
  });

  const social = createSocial({ backend: adapter, clock });

  const listed = await adapter.accounts.list(
    {},
    {
      backendInstance: "default",
      correlationId: "contract",
      retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
    },
  );

  const platform = string(listed.items[0]?.ref.platform);
  const account = connectedAccountRef({ backend: "default", platform, accountId: "int1" });
  const request = { targets: [{ account, options }], content, ...definedFields({ schedule }) };
  const prepared = social.posts.prepare(request);
  const result = prepared.ok ? await social.posts.publish(request) : undefined;
  const create = creates[0];
  const post = create === undefined ? undefined : object(array(create["posts"])[0]);

  return {
    platform,
    issues: prepared.issues.map((issue) => issue.code),
    outcome: result?.outcomes[0],
    create,
    settings: post === undefined ? undefined : post["settings"],
    value: post === undefined ? [] : array(post["value"]),
    uploads,
  };
}

const at = "2026-11-06T09:00:00.000Z";

it("Postiz sends a Twitch announcement with its color [feature:postiz.publish.twitch.announcement]", async () => {
  const { settings, outcome } = await publish(
    "twitch",
    { text: "We just hit 10,000 followers!" },
    { messageType: "announcement", announcementColor: "purple" },
    { at },
  );

  assert.deepEqual(settings, { messageType: "announcement", announcementColor: "purple" });
  assert.equal(outcome?.state, "scheduled");

  const plain = await publish("twitch", { text: "Live soon" }, { announcementColor: "green" });

  assert.deepEqual(plain.issues, ["twitch.announcement_color"]);

  const wrong = await publish("twitch", { text: "Live soon" }, { messageType: "shout" });

  assert.deepEqual(wrong.issues, ["twitch.message_type"]);
});

it("Postiz repeats a post every N days with inter [feature:postiz.scheduling.repeat]", async () => {
  const { create } = await publish(
    "x",
    { text: "Weekly reminder" },
    { repeatEveryDays: 7 },
    { at },
  );

  assert.equal(create?.["inter"], 7);
  assert.equal(create?.["type"], "schedule");

  const once = await publish("x", { text: "Once" }, {}, { at });

  assert.equal(once.create?.["inter"], undefined);

  const bad = await publish("x", { text: "Bad" }, { repeatEveryDays: 1.5 });

  assert.deepEqual(bad.issues, ["postiz.repeat"]);
});

it("Postiz posts to a Slack channel by ID [feature:postiz.publish.slack]", async () => {
  const { platform, settings, value, uploads } = await publish(
    "slack",
    { text: "*New release*", media: [image("metrics")] },
    { channelId: "C0123456789" },
  );

  assert.equal(platform, "slack");
  assert.deepEqual(settings, { channel: "C0123456789" });
  assert.deepEqual(
    object(array(object(value[0])["image"])[0])["path"],
    "https://uploads.postiz.com/metrics.png",
  );
  assert.deepEqual(uploads, ["https://cdn.example.test/metrics.png"]);

  const missing = await publish("slack", { text: "No channel" }, {});

  assert.deepEqual(missing.issues, ["slack.channel"]);

  const withVideo = await publish("slack", { text: "Clip", media: [video] }, { channelId: "C1" });

  assert.deepEqual(withVideo.issues, ["slack.video_unsupported"]);
});

it("Postiz posts to Lemmy communities with a title and link [feature:postiz.publish.lemmy]", async () => {
  const { settings } = await publish(
    "lemmy",
    { text: "Why open source matters" },
    {
      communities: [
        { id: "123456", name: "opensource", title: "Why Open Source Matters" },
        { id: "777", name: "linux", title: "Open source essay", url: "https://example.com/essay" },
      ],
    },
  );

  assert.deepEqual(settings, {
    subreddit: [
      { value: { subreddit: "opensource", id: "123456", title: "Why Open Source Matters" } },
      {
        value: {
          subreddit: "linux",
          id: "777",
          title: "Open source essay",
          url: "https://example.com/essay",
        },
      },
    ],
  });

  const short = await publish(
    "lemmy",
    { text: "x" },
    { communities: [{ id: "1", name: "o", title: "T" }] },
  );

  assert.deepEqual(short.issues, ["lemmy.communities"]);

  const withImage = await publish(
    "lemmy",
    { text: "x", media: [image("a")] },
    { communities: [{ id: "1", name: "oss", title: "Title" }] },
  );

  assert.deepEqual(withImage.issues, ["lemmy.media_unsupported"]);
});

it("Postiz casts to Warpcast channels, listed from wrapcast [feature:postiz.publish.warpcast]", async () => {
  const { platform, settings } = await publish(
    "wrapcast",
    { text: "Hello Farcaster", media: [image("design")] },
    { channels: ["design", "builders"] },
  );

  assert.equal(platform, "warpcast");
  assert.deepEqual(settings, {
    subreddit: [{ value: { id: "design" } }, { value: { id: "builders" } }],
  });

  const feed = await publish("warpcast", { text: "Main feed" }, {});

  assert.equal(feed.platform, "warpcast");
  assert.deepEqual(feed.settings, {});

  const long = await publish("warpcast", { text: "a".repeat(801) }, {});

  assert.deepEqual(long.issues, ["warpcast.text_too_long"]);
});

it("Postiz posts text and images to Nostr, VK, and Kick without settings [feature:postiz.publish.nostr_vk_kick]", async () => {
  for (const identifier of ["nostr", "vk", "kick"]) {
    const { platform, settings, value, outcome } = await publish(
      identifier,
      {
        text: "Launch screenshot",
        media: [image("launch")],
      },
      {},
    );

    assert.equal(platform, identifier);
    assert.deepEqual(settings, {});
    assert.equal(object(value[0])["content"], "Launch screenshot");
    assert.equal(outcome?.state, "processing");
  }

  assert.deepEqual((await publish("kick", { text: "a".repeat(501) }, {})).issues, [
    "kick.text_too_long",
  ]);
  assert.deepEqual((await publish("vk", { text: "Hi" }, { title: "x" })).issues, [
    "options.unmapped",
  ]);
});

it("Postiz publishes a Medium article with subtitle, canonical, and tags [feature:postiz.publish.medium]", async () => {
  const { settings } = await publish(
    "medium",
    { text: "# Introduction\n\nMarkdown body." },
    {
      title: "Building Modern Web Applications",
      subtitle: "A full-stack guide",
      canonicalUrl: "https://blog.example.com/modern-web",
      publicationId: "pub-1",
      tags: ["programming", "webdev"],
    },
  );

  assert.deepEqual(settings, {
    title: "Building Modern Web Applications",
    subtitle: "A full-stack guide",
    canonical: "https://blog.example.com/modern-web",
    publication: "pub-1",
    tags: [
      { value: "programming", label: "programming" },
      { value: "webdev", label: "webdev" },
    ],
  });

  const noSubtitle = await publish("medium", { text: "Body" }, { title: "Title" });

  assert.deepEqual(noSubtitle.issues, ["medium.subtitle"]);

  const manyTags = await publish(
    "medium",
    { text: "Body" },
    { title: "Title", subtitle: "Sub", tags: ["a", "b", "c", "d", "e"] },
  );

  assert.deepEqual(manyTags.issues, ["medium.tags"]);
});

it("Postiz publishes a Dev.to article with an imported main_image [feature:postiz.publish.devto]", async () => {
  const { settings, uploads } = await publish(
    "devto",
    { text: "# Getting started" },
    {
      title: "10 JavaScript Tips",
      mainImage: "https://cdn.example.test/cover.jpg",
      organizationId: "org-9",
      tags: ["javascript"],
    },
  );

  assert.deepEqual(uploads, ["https://cdn.example.test/cover.jpg"]);
  assert.deepEqual(settings, {
    title: "10 JavaScript Tips",
    organization: "org-9",
    tags: [{ value: "javascript", label: "javascript" }],
    main_image: { id: "m-cover.jpg", path: "https://uploads.postiz.com/cover.jpg" },
  });

  const badCover = await publish(
    "devto",
    { text: "Body" },
    { title: "Title", mainImage: "https://cdn.example.test/cover.svg" },
  );

  assert.deepEqual(badCover.issues, ["postiz.main_image"]);
});

it("Postiz publishes a Hashnode article to a publication with tag IDs [feature:postiz.publish.hashnode]", async () => {
  const { settings } = await publish(
    "hashnode",
    { text: "Markdown body" },
    {
      title: "Shipping a scheduler",
      subtitle: "Notes",
      mainImage: "https://cdn.example.test/hero.png",
      publicationId: "pub-7",
      tags: [{ id: "56744721958ef13879b94cad", name: "JavaScript" }],
    },
  );

  assert.deepEqual(settings, {
    title: "Shipping a scheduler",
    subtitle: "Notes",
    publication: "pub-7",
    tags: [{ value: "56744721958ef13879b94cad", label: "JavaScript" }],
    main_image: { id: "m-hero.png", path: "https://uploads.postiz.com/hero.png" },
  });

  const missing = await publish("hashnode", { text: "Body" }, { title: "Short" });

  assert.deepEqual(missing.issues, ["hashnode.tags", "hashnode.title", "hashnode.publication"]);
});

it("Postiz publishes a WordPress post with status, categories, and tags [feature:postiz.publish.wordpress]", async () => {
  const { settings } = await publish(
    "wordpress",
    { text: "<p>Welcome</p>" },
    {
      title: "Company updates",
      postType: "post",
      status: "draft",
      categoryIds: [12],
      tagIds: [45, 46],
    },
  );

  assert.deepEqual(settings, {
    title: "Company updates",
    type: "post",
    status: "draft",
    categories: [12],
    tags: [45, 46],
  });

  const bad = await publish(
    "wordpress",
    { text: "<p>x</p>" },
    { title: "Title", postType: "page", status: "live", categoryIds: ["news"] },
  );

  assert.deepEqual(bad.issues, ["wordpress.status", "wordpress.categories"]);
});

it("Postiz sends a Listmonk campaign with subject, preview, list, and template [feature:postiz.publish.listmonk]", async () => {
  const { settings } = await publish(
    "listmonk",
    { text: "<h1>November</h1>" },
    { subject: "November news", preview: "What shipped", listId: "3", templateId: "1" },
  );

  assert.deepEqual(settings, {
    subject: "November news",
    preview: "What shipped",
    list: "3",
    template: "1",
  });

  const missing = await publish("listmonk", { text: "<p>x</p>" }, { subject: "S" });

  assert.deepEqual(missing.issues, ["listmonk.preview", "listmonk.list"]);
});

it("Postiz posts a Dribbble shot from one image with a title and team [feature:postiz.publish.dribbble]", async () => {
  const { settings } = await publish(
    "dribbble",
    { text: "Dashboard concept", media: [image("shot")] },
    { title: "Analytics dashboard", teamUrl: "https://dribbble.com/acme" },
  );

  assert.deepEqual(settings, { title: "Analytics dashboard", team: "https://dribbble.com/acme" });

  const two = await publish(
    "dribbble",
    { text: "Two", media: [image("a"), image("b")] },
    { title: "Shots" },
  );

  assert.ok(two.issues.includes("dribbble.media"));
});

it("Postiz posts to Tumblr with title, link, sourceUrl, and joined tags [feature:postiz.publish.tumblr]", async () => {
  const { settings } = await publish(
    "tumblr",
    { text: "Process notes", media: [image("piece")] },
    {
      title: "Process",
      link: "https://example.com/article",
      sourceUrl: "https://example.com/original",
      tags: ["design", "typography"],
    },
  );

  assert.deepEqual(settings, {
    title: "Process",
    link: "https://example.com/article",
    sourceUrl: "https://example.com/original",
    tags: "design, typography",
  });

  const thread = await publish("tumblr", { text: "x" }, { thread: [{ text: "more" }] });

  assert.deepEqual(thread.issues, ["postiz.thread_unsupported"]);
});

it("Postiz posts to a MeWe timeline or group [feature:postiz.publish.mewe]", async () => {
  const timeline = await publish("mewe", { text: "Hello" }, { postType: "timeline" });

  assert.deepEqual(timeline.settings, { postType: "timeline" });

  const group = await publish("mewe", { text: "Hi group" }, { postType: "group", groupId: "g-1" });

  assert.deepEqual(group.settings, { postType: "group", group: "g-1" });

  const missing = await publish("mewe", { text: "Hi" }, { postType: "group" });

  assert.deepEqual(missing.issues, ["mewe.group"]);
});

it("Postiz posts to a Moltbook submolt [feature:postiz.publish.moltbook]", async () => {
  const { settings } = await publish("moltbook", { text: "Hello molts" }, { submolt: "general" });

  assert.deepEqual(settings, { submolt: "general" });

  const long = await publish("moltbook", { text: "a".repeat(301) }, { submolt: "general" });

  assert.deepEqual(long.issues, ["moltbook.text_too_long"]);
});

it("Postiz posts to a Skool group with a label and title [feature:postiz.publish.skool]", async () => {
  const { settings } = await publish(
    "skool",
    { text: "Weekly metrics" },
    { groupId: "grp", labelId: "lbl", title: "Metrics" },
  );

  assert.deepEqual(settings, { group: "grp", label: "lbl", title: "Metrics" });

  const missing = await publish("skool", { text: "x" }, { groupId: "grp" });

  assert.deepEqual(missing.issues, ["skool.label", "skool.title"]);
});

it("Postiz posts to a Whop forum experience [feature:postiz.publish.whop]", async () => {
  const { settings } = await publish(
    "whop",
    { text: "**Preview**" },
    { companyId: "biz_1", experienceId: "exp_2", title: "Preview" },
  );

  assert.deepEqual(settings, { company: "biz_1", experience: "exp_2", title: "Preview" });

  const untitled = await publish(
    "whop",
    { text: "x" },
    { companyId: "biz_1", experienceId: "exp_2" },
  );

  assert.deepEqual(untitled.settings, { company: "biz_1", experience: "exp_2" });
});
