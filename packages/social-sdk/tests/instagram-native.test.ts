import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { instagram } from "../src/platforms/instagram.js";
import {
  connectedAccountRef,
  type AdapterOperationContext,
  type JsonValue,
  type MediaAttachment,
} from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { decodePlatformWebhook } from "../src/server/webhooks.js";
import { isJsonValue } from "../src/transport/json.js";
import { isJsonObject } from "../src/transport/validation.js";

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly body: JsonValue | undefined;
  readonly headers: Headers;
  readonly raw: BodyInit | null | undefined;
}

const context = (): AdapterOperationContext => ({
  backendInstance: "instagram",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
});

const account = connectedAccountRef({
  backend: "instagram",
  platform: "instagram",
  accountId: "ig1",
});

/** A fake Graph API that answers each request with the first matching route. */
const fakeGraph = (
  routes: readonly (readonly [(call: Call) => boolean, (call: Call) => JsonValue])[],
) => {
  const calls: Call[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const text =
      init?.body === undefined || init.body === null
        ? undefined
        : await new Response(init.body).text();

    const parsed = text === undefined ? undefined : parseJson(text);

    const call: Call = {
      url: new URL(String(input)),
      method: init?.method ?? "GET",
      body: parsed,
      headers: new Headers(init?.headers),
      raw: init?.body,
    };

    calls.push(call);

    for (const [match, answer] of routes)
      if (match(call)) return new Response(JSON.stringify(answer(call)));

    return new Response(JSON.stringify({ error: { message: "unrouted" } }), { status: 404 });
  };

  return { calls, fetch };
};

function parseJson(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const native = (adapter: ReturnType<typeof instagram>) => {
  const module = adapter.native;
  assert.ok(module, "expected the Instagram native module");

  return module;
};

const bodyOf = (call: Call | undefined) => {
  assert.ok(call, "expected a request");
  assert.ok(isJsonObject(call.body), "expected a JSON object body");

  return call.body;
};

const publishRoutes = [
  [(call: Call) => call.url.pathname.endsWith("/media"), () => ({ id: "container1" })],
  [
    (call: Call) => call.url.searchParams.get("fields") === "id,status_code,status",
    () => ({ id: "container1", status_code: "FINISHED" }),
  ],
  [(call: Call) => call.url.pathname.endsWith("/media_publish"), () => ({ id: "post1" })],
] as const;

const image = (index = 0): MediaAttachment => ({
  kind: "image",
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
  source: { kind: "https-url", url: `https://cdn.example/${index}.jpg` },
});

const video: MediaAttachment = {
  kind: "video",
  mimeType: "video/mp4",
  width: 1080,
  height: 1920,
  source: { kind: "https-url", url: "https://cdn.example/reel.mp4" },
};

const prepared = (media: readonly MediaAttachment[], options?: JsonValue, text = "caption") => ({
  targetIndex: 0,
  targetKey: "instagram",
  account,
  content: { text, media },
  options,
});

describe("Instagram publishing options", () => {
  it("accepts carousels of up to 20 items [feature:instagram.publish.carousel]", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });
    const twenty = Array.from({ length: 20 }, (_, index) => image(index));

    assert.deepEqual(adapter.posts?.prepareTarget(prepared(twenty)), []);

    const tooMany = adapter.posts?.prepareTarget(prepared([...twenty, image(21)])) ?? [];
    assert.deepEqual(
      tooMany.map((issue) => issue.code),
      ["instagram.media"],
    );

    const outcome = await adapter.posts?.publishTarget(
      prepared(twenty, { collaborators: ["partner.one"], isAiGenerated: true }),
      context(),
    );

    assert.equal(outcome?.state, "published");
    const creates = graph.calls.filter((call) => call.url.pathname.endsWith("/ig1/media"));
    assert.equal(creates.length, 21);

    for (const child of creates.slice(0, 20)) {
      const body = bodyOf(child);
      assert.equal(body["is_carousel_item"], true);
      assert.equal(body["is_ai_generated"], undefined);
      assert.equal(body["collaborators"], undefined);
    }

    const parent = bodyOf(creates[20]);
    assert.equal(parent["media_type"], "CAROUSEL");
    assert.equal(parent["children"], Array.from({ length: 20 }, () => "container1").join(","));
    assert.deepEqual(parent["collaborators"], ["partner.one"]);
    assert.equal(parent["is_ai_generated"], true);
  });

  it("enforces 30 hashtags and 20 @ tags in captions [feature:instagram.publish.caption_limits]", () => {
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: fetchNever });

    const tags = (count: number, mark: string) =>
      Array.from({ length: count }, (_, index) => `${mark}tag${index}`).join(" ");

    assert.deepEqual(
      adapter.posts?.prepareTarget(prepared([image()], undefined, tags(30, "#"))),
      [],
    );
    assert.deepEqual(
      adapter.posts?.prepareTarget(prepared([image()], undefined, tags(20, "@"))),
      [],
    );

    const hashtags = adapter.posts?.prepareTarget(prepared([image()], undefined, tags(31, "#")));
    assert.deepEqual(
      hashtags?.map((issue) => issue.message),
      ["Caption has more than 30 hashtags."],
    );

    const mentions = adapter.posts?.prepareTarget(prepared([image()], undefined, tags(21, "@")));
    assert.deepEqual(
      mentions?.map((issue) => issue.message),
      ["Caption has more than 20 @ tags."],
    );

    // An email address is not an @ tag.
    assert.deepEqual(
      adapter.posts?.prepareTarget(prepared([image()], undefined, `mail a@b.co ${tags(20, "@")}`)),
      [],
    );
  });

  it("sends Reel cover_url, thumb_offset, audio_name, trial_params and share_to_feed [feature:instagram.publish.reels.share_to_feed]", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const outcome = await native(adapter).publishReel({
      account,
      videoUrl: "https://cdn.example/reel.mp4",
      caption: "Reel",
      shareToFeed: false,
      coverUrl: "https://cdn.example/cover.jpg",
      thumbOffsetMs: 1500,
      audioName: "Studio take",
      trial: { graduationStrategy: "SS_PERFORMANCE" },
      collaborators: ["partner.one", "partner_two"],
      locationId: "110843418940484",
      isAiGenerated: true,
      context: context(),
    });

    assert.equal(outcome.state, "published");
    assert.deepEqual(bodyOf(graph.calls[0]), {
      media_type: "REELS",
      video_url: "https://cdn.example/reel.mp4",
      caption: "Reel",
      share_to_feed: false,
      cover_url: "https://cdn.example/cover.jpg",
      thumb_offset: 1500,
      audio_name: "Studio take",
      trial_params: { graduation_strategy: "SS_PERFORMANCE" },
      collaborators: ["partner.one", "partner_two"],
      location_id: "110843418940484",
      is_ai_generated: true,
    });
  });

  it("maps normalized options onto a single Reel container", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const options = {
      shareToFeed: true,
      coverUrl: "https://cdn.example/cover.jpg",
      trial: { graduationStrategy: "MANUAL" },
    };

    assert.deepEqual(adapter.posts?.prepareTarget(prepared([video], options)), []);
    await adapter.posts?.publishTarget(prepared([video], options), context());

    const body = bodyOf(graph.calls[0]);
    assert.equal(body["media_type"], "REELS");
    assert.equal(body["share_to_feed"], true);
    assert.equal(body["cover_url"], "https://cdn.example/cover.jpg");
    assert.deepEqual(body["trial_params"], { graduation_strategy: "MANUAL" });
  });

  it("sends user_tags, location_id and collaborators on a single image", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const options = {
      userTags: [{ username: "friend.one", x: 0.25, y: 0.75 }],
      locationId: "110843418940484",
      collaborators: ["partner.one"],
    };

    assert.deepEqual(adapter.posts?.prepareTarget(prepared([image()], options)), []);
    await adapter.posts?.publishTarget(prepared([image()], options), context());

    const body = bodyOf(graph.calls[0]);
    assert.deepEqual(body["user_tags"], [{ username: "friend.one", x: 0.25, y: 0.75 }]);
    assert.equal(body["location_id"], "110843418940484");
    assert.deepEqual(body["collaborators"], ["partner.one"]);
  });

  it("rejects options on container kinds Meta does not document", () => {
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: fetchNever });

    const issues = (media: readonly MediaAttachment[], options: JsonValue) =>
      (adapter.posts?.prepareTarget(prepared(media, options)) ?? []).map((issue) => issue.code);

    assert.deepEqual(issues([image()], { coverUrl: "https://cdn.example/c.jpg" }), [
      "instagram.options",
    ]);
    assert.deepEqual(issues([video], { userTags: [{ username: "a", x: 0, y: 0 }] }), [
      "instagram.options",
    ]);
    assert.deepEqual(issues([image()], { collaborators: ["a", "b", "c", "d"] }), [
      "instagram.options",
    ]);
    assert.deepEqual(issues([image()], { userTags: [{ username: "a", x: 1.5, y: 0 }] }), [
      "instagram.options",
    ]);
    assert.deepEqual(
      issues([image()], { userTags: [{ username: "a", x: 0.5, y: 0.5, mediaIndex: 0 }] }),
      ["instagram.options"],
    );
    assert.deepEqual(issues([image()], { shareToFeeds: true }), ["instagram.options"]);
    assert.deepEqual(issues([video], { trial: { graduationStrategy: "AUTO" } }), [
      "instagram.options",
    ]);
  });

  it("sends Story user_tags with optional coordinates", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).publishStory({
      account,
      mediaUrl: "https://cdn.example/story.jpg",
      userTags: [{ username: "friend.one" }, { username: "friend_two", x: 0.5, y: 0.5 }],
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[0]), {
      media_type: "STORIES",
      image_url: "https://cdn.example/story.jpg",
      user_tags: [{ username: "friend.one" }, { username: "friend_two", x: 0.5, y: 0.5 }],
    });
  });

  it("puts is_ai_generated on the native carousel parent only [feature:instagram.publish.is_ai_generated]", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).publishCarousel(account, ["child1", "child2"], "Album", context(), {
      isAiGenerated: true,
      locationId: "110843418940484",
    });

    const parent = graph.calls.find((call) => call.url.pathname.endsWith("/ig1/media"));
    assert.deepEqual(bodyOf(parent), {
      media_type: "CAROUSEL",
      children: "child1,child2",
      caption: "Album",
      is_ai_generated: true,
      location_id: "110843418940484",
    });

    await assert.rejects(
      native(adapter).publishCarousel(account, ["only"], "Album", context()),
      /2 to 20 child containers/,
    );
  });

  it("sends Facebook Login partnership, poll, comment prompt, product_tags and audio_configuration fields", async () => {
    const graph = fakeGraph(publishRoutes);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    await native(adapter).publishReel({
      account,
      videoUrl: "https://cdn.example/reel.mp4",
      caption: "Which one?",
      isPaidPartnership: true,
      brandedContentSponsorIds: ["17841400000000001"],
      poll: { options: ["Red", "Blue"], extendedDuration: true },
      productTags: [{ productId: "3231775643511089" }],
      audioConfiguration: { audioId: "548233112", audioVolume: 40, videoVolume: 80 },
      context: context(),
    });

    const body = bodyOf(graph.calls[0]);
    assert.equal(graph.calls[0]?.url.host, "graph.facebook.com");
    assert.equal(body["is_paid_partnership"], true);
    assert.deepEqual(body["branded_content_sponsor_ids"], ["17841400000000001"]);
    assert.deepEqual(body["poll_attachment"], { option_a: "Red", option_b: "Blue" });
    assert.equal(body["is_poll_duration_extended"], true);
    assert.deepEqual(body["product_tags"], [{ product_id: "3231775643511089" }]);
    assert.deepEqual(body["audio_configuration"], {
      audio_id: "548233112",
      audio_volume: 40,
      video_volume: 80,
    });

    const prompt = fakeGraph(publishRoutes);

    const promptAdapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: prompt.fetch,
    });

    const options = {
      commentPrompt: true,
      productTags: [{ productId: "3231775643511089", x: 0.5, y: 0.4 }],
    };

    assert.deepEqual(
      promptAdapter.posts?.prepareTarget(prepared([image()], options, "Tell us")),
      [],
    );
    await promptAdapter.posts?.publishTarget(prepared([image()], options, "Tell us"), context());

    const imageBody = bodyOf(prompt.calls[0]);
    assert.equal(imageBody["is_comment_prompt_used"], true);
    assert.deepEqual(imageBody["product_tags"], [
      { product_id: "3231775643511089", x: 0.5, y: 0.4 },
    ]);
  });

  it("rejects Facebook Login-only fields and invalid polls before sending", async () => {
    const graph = fakeGraph(publishRoutes);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    for (const options of [
      { isPaidPartnership: true },
      { poll: { options: ["A", "B"] } },
      { commentPrompt: true },
      { productTags: [{ productId: "1" }] },
    ])
      assert.deepEqual(
        adapter.posts?.prepareTarget(prepared([image()], options)).map((issue) => issue.code),
        ["instagram.options_flavor"],
      );

    await assert.rejects(
      native(adapter).publishReel({
        account,
        videoUrl: "https://cdn.example/reel.mp4",
        audioConfiguration: { audioId: "1" },
        context: context(),
      }),
      /requires Instagram API with Facebook Login/,
    );
    assert.equal(graph.calls.length, 0);

    const facebook = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: fetchNever,
    });

    const codes = (options: JsonValue, text = "Question?") =>
      (facebook.posts?.prepareTarget(prepared([image()], options, text)) ?? []).map(
        (issue) => issue.message,
      );

    assert.match(codes({ poll: { options: ["A", "B"] } }, "")[0] ?? "", /non-empty caption/);
    assert.match(codes({ poll: { options: ["A"] } })[0] ?? "", /2 to 4 options/);
    assert.match(codes({ poll: { options: ["A", "B", "C", "D", "E"] } })[0] ?? "", /2 to 4/);
    assert.match(codes({ poll: { options: ["A", "x".repeat(26)] } })[0] ?? "", /1 to 25/);
    assert.match(
      codes({ poll: { options: ["A", "B"] }, commentPrompt: true })[0] ?? "",
      /cannot be combined/,
    );
    assert.match(
      codes({ brandedContentSponsorIds: ["1", "2", "3"] })[0] ?? "",
      /1 or 2 numeric Instagram user IDs/,
    );
  });
});

describe("Instagram audio and copyright reads", () => {
  const facebookAdapter = (fetch: typeof globalThis.fetch) =>
    instagram({ auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" }, fetch });

  it("searches licensed audio through GET /ig_audio", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig_audio"),
        () => ({
          data: [
            {
              audio_id: "548233112",
              title: "Morning",
              audio_type: "music",
              display_artist: "Band",
              duration_in_ms: 30000,
              unexpected: { nested: true },
            },
          ],
        }),
      ],
      [
        (call) => call.url.pathname.endsWith("/548233112"),
        () => ({ audio_id: "548233112", title: "Morning", audio_type: "music" }),
      ],
    ]);

    const adapter = facebookAdapter(graph.fetch);

    const results = await native(adapter).searchAudio({
      account,
      audioType: "music",
      query: "morning",
      context: context(),
    });

    const search = graph.calls[0];
    assert.equal(search?.url.host, "graph.facebook.com");
    assert.equal(search?.url.searchParams.get("audio_type"), "music");
    assert.equal(search?.url.searchParams.get("user_id"), "ig1");
    assert.equal(search?.url.searchParams.get("search_query"), "morning");
    assert.deepEqual(results.items, [
      {
        audio_id: "548233112",
        title: "Morning",
        audio_type: "music",
        display_artist: "Band",
        duration_in_ms: 30000,
      },
    ]);

    const asset = await native(adapter).getAudio({
      account,
      audioId: "548233112",
      context: context(),
    });

    assert.equal(graph.calls[1]?.url.searchParams.get("user_id"), "ig1");
    assert.equal(asset["title"], "Morning");

    const instagramLogin = instagram({
      auth: { accessToken: "t", accountId: "ig1" },
      fetch: fetchNever,
    });

    await assert.rejects(
      native(instagramLogin).searchAudio({ account, audioType: "music", context: context() }),
      /Facebook Login/,
    );
  });

  it("reads copyright_check_status for containers and copyright_check_information for media", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.searchParams.get("fields") === "copyright_check_status",
        () => ({
          id: "container1",
          copyright_check_status: { status: "in_progress", matches_found: false },
        }),
      ],
      [
        (call) => call.url.searchParams.get("fields") === "copyright_check_information",
        () => ({
          id: "media1",
          copyright_check_information: {
            status: { status: "completed", matches_found: true },
            copyright_matches: [{ content_title: "Song", author: "Label" }],
          },
        }),
      ],
    ]);

    const adapter = facebookAdapter(graph.fetch);

    const container = await native(adapter).getCopyrightCheck({
      account,
      id: "container1",
      stage: "container",
      context: context(),
    });

    assert.equal(graph.calls[0]?.url.pathname, "/v27.0/container1");
    assert.deepEqual(
      { status: container.status, matchesFound: container.matchesFound },
      { status: "in_progress", matchesFound: false },
    );

    const media = await native(adapter).getCopyrightCheck({
      account,
      id: "media1",
      stage: "media",
      context: context(),
    });

    assert.equal(media.status, "completed");
    assert.equal(media.matchesFound, true);
    assert.deepEqual(media.native["copyright_matches"], [
      { content_title: "Song", author: "Label" },
    ]);
  });
});

describe("Instagram resumable uploads", () => {
  it("creates a resumable container and uploads local bytes to rupload.facebook.com [feature:instagram.media.resumable_upload]", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.host === "graph.facebook.com" && call.url.pathname.endsWith("/media"),
        () => ({
          id: "container9",
          uri: "https://rupload.facebook.com/ig-api-upload/v27.0/container9",
        }),
      ],
      [
        (call) => call.url.host === "rupload.facebook.com",
        () => ({ success: true, message: "Upload successful." }),
      ],
      [
        (call) => call.url.searchParams.get("fields") === "id,status,status_code,video_status",
        () => ({
          id: "container9",
          status_code: "IN_PROGRESS",
          video_status: { uploading_phase: { status: "complete", bytes_transferred: 6 } },
        }),
      ],
    ]);

    const adapter = instagram({
      auth: { accessToken: "page-token", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const upload = await native(adapter).createResumableUpload({
      account,
      mediaType: "REELS",
      caption: "Local Reel",
      shareToFeed: true,
      context: context(),
    });

    const create = graph.calls[0];
    assert.equal(create?.url.searchParams.get("upload_type"), "resumable");
    assert.deepEqual(bodyOf(create), {
      media_type: "REELS",
      caption: "Local Reel",
      share_to_feed: true,
    });
    assert.deepEqual(upload, {
      containerId: "container9",
      uploadUri: "https://rupload.facebook.com/ig-api-upload/v27.0/container9",
    });

    const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6])], { type: "video/mp4" });

    await native(adapter).uploadVideo({
      account,
      uploadUri: upload.uploadUri,
      source: { kind: "blob", blob, offset: 2 },
      context: context(),
    });

    const sent = graph.calls[1];
    assert.equal(sent?.method, "POST");
    assert.equal(sent?.url.href, "https://rupload.facebook.com/ig-api-upload/v27.0/container9");
    assert.equal(sent?.headers.get("authorization"), "OAuth page-token");
    assert.equal(sent?.headers.get("offset"), "2");
    assert.equal(sent?.headers.get("file_size"), "6");
    assert.ok(sent?.raw instanceof Blob);
    assert.deepEqual([...new Uint8Array(await sent.raw.arrayBuffer())], [3, 4, 5, 6]);

    const status = await native(adapter).getUploadStatus({
      account,
      containerId: "container9",
      context: context(),
    });

    assert.deepEqual(status["video_status"], {
      uploading_phase: { status: "complete", bytes_transferred: 6 },
    });
  });

  it("sends a hosted file_url, surfaces debug_info failures, and rejects foreign upload hosts", async () => {
    const graph = fakeGraph([
      [
        (call) => call.headers.get("file_url") === "https://cdn.example/fail.mp4",
        () => ({
          debug_info: { retriable: false, type: "ProcessingFailedError", message: "Bad video" },
        }),
      ],
      [(call) => call.url.host === "rupload.facebook.com", () => ({ success: true })],
    ]);

    const adapter = instagram({
      auth: { accessToken: "page-token", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const uploadUri = "https://rupload.facebook.com/ig-api-upload/v27.0/container9";

    await native(adapter).uploadVideo({
      account,
      uploadUri,
      source: { kind: "https-url", url: "https://cdn.example/video.mp4" },
      context: context(),
    });

    assert.equal(graph.calls[0]?.headers.get("file_url"), "https://cdn.example/video.mp4");
    assert.equal(graph.calls[0]?.headers.get("offset"), null);

    await assert.rejects(
      native(adapter).uploadVideo({
        account,
        uploadUri,
        source: { kind: "https-url", url: "https://cdn.example/fail.mp4" },
        context: context(),
      }),
      { name: "SocialError", code: "upstream_failure", message: "Bad video" },
    );

    await assert.rejects(
      native(adapter).uploadVideo({
        account,
        uploadUri: "https://uploads.example/ig-api-upload/v27.0/container9",
        source: { kind: "https-url", url: "https://cdn.example/video.mp4" },
        context: context(),
      }),
      /outside rupload\.facebook\.com/,
    );
    assert.equal(graph.calls.length, 2);

    const instagramLogin = instagram({
      auth: { accessToken: "t", accountId: "ig1" },
      fetch: fetchNever,
    });

    await assert.rejects(
      native(instagramLogin).createResumableUpload({
        account,
        mediaType: "REELS",
        context: context(),
      }),
      /Facebook Login/,
    );
  });
});

describe("Instagram media and account reads", () => {
  const facebook = (fetch: typeof globalThis.fetch) =>
    instagram({ auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" }, fetch });

  const postRef = {
    kind: "platform-post" as const,
    version: 1 as const,
    backend: "instagram",
    platform: "instagram" as const,
    accountId: "ig1",
    postId: "media1",
  };

  it("lists posts with media_url, thumbnail_url, like_count and comments_count", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/media"),
        () => ({
          data: [
            {
              id: "media1",
              media_type: "VIDEO",
              media_url: "https://cdn.example/v.mp4",
              thumbnail_url: "https://cdn.example/t.jpg",
              like_count: 4,
              comments_count: 2,
            },
          ],
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });
    const listed = await adapter.posts?.list?.(account, {}, context());
    const fields = graph.calls[0]?.url.searchParams.get("fields")?.split(",") ?? [];

    for (const field of ["media_url", "thumbnail_url", "like_count", "comments_count"])
      assert.ok(fields.includes(field), field);
    assert.deepEqual(listed?.items[0], {
      id: "media1",
      media_type: "VIDEO",
      media_url: "https://cdn.example/v.mp4",
      thumbnail_url: "https://cdn.example/t.jpg",
      like_count: 4,
      comments_count: 2,
    });
  });

  it("reads saved_count and shares_count on Facebook Login posts.get only", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/media1"),
        () => ({ id: "media1", saved_count: 7, shares_count: 3, reposts_count: 1 }),
      ],
    ]);

    const post = await facebook(graph.fetch).posts?.get?.(postRef, context());
    const fields = graph.calls[0]?.url.searchParams.get("fields")?.split(",") ?? [];
    assert.ok(fields.includes("saved_count") && fields.includes("shares_count"));
    assert.deepEqual(post, { id: "media1", saved_count: 7, shares_count: 3, reposts_count: 1 });

    const instagramLogin = fakeGraph([[() => true, () => ({ id: "media1" })]]);
    await instagram({
      auth: { accessToken: "t", accountId: "ig1" },
      fetch: instagramLogin.fetch,
    }).posts?.get?.(postRef, context());
    assert.ok(!instagramLogin.calls[0]?.url.searchParams.get("fields")?.includes("saved_count"));
  });

  it("lists carousel /children, /stories and live_media", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/media1/children"),
        () => ({
          data: [{ id: "child1", media_type: "IMAGE", media_url: "https://cdn.example/1.jpg" }],
        }),
      ],
      [
        (call) => call.url.pathname.endsWith("/ig1/stories"),
        () => ({
          data: [{ id: "story1", media_type: "IMAGE" }],
          paging: { cursors: { after: "s2" }, next: "https://graph.facebook.com/next" },
        }),
      ],
      [
        (call) => call.url.pathname.endsWith("/ig1/live_media"),
        () => ({ data: [{ id: "live1", media_product_type: "LIVE" }] }),
      ],
    ]);

    const adapter = facebook(graph.fetch);

    const children = await native(adapter).listChildren({
      account,
      mediaId: "media1",
      context: context(),
    });

    assert.equal(graph.calls[0]?.url.pathname, "/v27.0/media1/children");
    assert.deepEqual(children.items, [
      { id: "child1", media_type: "IMAGE", media_url: "https://cdn.example/1.jpg" },
    ]);

    const stories = await native(adapter).listStories({ account, limit: 10, context: context() });
    assert.equal(graph.calls[1]?.url.pathname, "/v27.0/ig1/stories");
    assert.equal(graph.calls[1]?.url.searchParams.get("limit"), "10");
    assert.deepEqual(stories, { items: [{ id: "story1", media_type: "IMAGE" }], nextCursor: "s2" });

    const live = await native(adapter).listLiveMedia({
      account,
      since: "2026-11-04T00:00:00Z",
      context: context(),
    });

    assert.equal(graph.calls[2]?.url.pathname, "/v27.0/ig1/live_media");
    assert.equal(graph.calls[2]?.url.searchParams.get("since"), "1793750400");
    assert.deepEqual(live.items, [{ id: "live1", media_product_type: "LIVE" }]);

    const instagramLogin = instagram({
      auth: { accessToken: "t", accountId: "ig1" },
      fetch: fetchNever,
    });

    await assert.rejects(
      native(instagramLogin).listStories({ account, context: context() }),
      /Facebook Login/,
    );
  });

  it("reads collaborative_media, media /collaborators and collaboration_invites, and answers an invite", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/collaborative_media"),
        () => ({ data: [{ id: "shared1", username: "brand", total_like_count: 9 }] }),
      ],
      [
        (call) => call.url.pathname.endsWith("/media1/collaborators"),
        () => ({
          data: [
            { id: "u1", username: "partner.one", invite_status: "Accepted" },
            { id: "u2", username: "partner_two", invite_status: "Pending" },
          ],
        }),
      ],
      [
        (call) => call.method === "GET" && call.url.pathname.endsWith("/ig1/collaboration_invites"),
        () => ({
          data: [{ media_id: "9001", media_owner_username: "brand", caption: "Join" }],
          paging: { cursors: { after: "c2" } },
        }),
      ],
      [
        (call) =>
          call.method === "POST" && call.url.pathname.endsWith("/ig1/collaboration_invites"),
        () => ({ success: true }),
      ],
    ]);

    const adapter = facebook(graph.fetch);
    const shared = await native(adapter).listCollaborativeMedia({ account, context: context() });
    assert.deepEqual(shared.items, [{ id: "shared1", username: "brand", total_like_count: 9 }]);

    const collaborators = await native(adapter).listMediaCollaborators({
      account,
      mediaId: "media1",
      context: context(),
    });

    assert.equal(graph.calls[1]?.url.searchParams.get("fields"), "id,username,invite_status");
    assert.deepEqual(collaborators, [
      { id: "u1", username: "partner.one", inviteStatus: "Accepted" },
      { id: "u2", username: "partner_two", inviteStatus: "Pending" },
    ]);

    const invites = await native(adapter).listCollaborationInvites({ account, context: context() });
    assert.deepEqual(invites, {
      items: [{ media_id: "9001", media_owner_username: "brand", caption: "Join" }],
      nextCursor: "c2",
    });

    await native(adapter).respondToCollaborationInvite({
      account,
      mediaId: "9001",
      accept: false,
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[3]), { media_id: "9001", accept: false });
  });

  it("reads connected_threads_user, instagram_oembed, recently_searched_hashtags and upcoming_events", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/connected_threads_user"),
        () => ({ data: [{ threads_user_id: "th1" }] }),
      ],
      [
        (call) => call.url.pathname.endsWith("/instagram_oembed"),
        () => ({
          version: "1.0",
          provider_name: "Instagram",
          type: "rich",
          html: "<blockquote></blockquote>",
        }),
      ],
      [
        (call) => call.url.pathname.endsWith("/ig1/recently_searched_hashtags"),
        () => ({ data: [{ id: "17843857450040591" }] }),
      ],
      [
        (call) => call.method === "GET" && call.url.pathname.endsWith("/ig1/upcoming_events"),
        () => ({ data: [{ id: "ev1", title: "Launch", start_time: "2026-12-01T18:00:00+0000" }] }),
      ],
      [
        (call) => call.method === "POST" && call.url.pathname.endsWith("/ig1/upcoming_events"),
        () => ({ id: "ev2" }),
      ],
      [
        (call) => call.method === "POST" && call.url.pathname.endsWith("/ev2"),
        () => ({ id: "ev2" }),
      ],
    ]);

    const adapter = facebook(graph.fetch);
    const threads = await native(adapter).getConnectedThreadsUser({ account, context: context() });
    assert.equal(graph.calls[0]?.url.searchParams.get("fields"), "threads_user_id");
    assert.deepEqual(threads, { threadsUserId: "th1" });

    const embed = await native(adapter).getOEmbed({
      url: "https://www.instagram.com/p/C1abc/",
      maxWidth: 540,
      omitScript: true,
      appAccessToken: "app|client",
      context: context(),
    });

    const oembed = graph.calls[1];
    assert.equal(
      oembed?.url.href.startsWith("https://graph.facebook.com/v27.0/instagram_oembed?"),
      true,
    );
    assert.equal(oembed?.url.searchParams.get("url"), "https://www.instagram.com/p/C1abc/");
    assert.equal(oembed?.url.searchParams.get("maxwidth"), "540");
    assert.equal(oembed?.url.searchParams.get("omitscript"), "true");
    assert.equal(oembed?.headers.get("authorization"), "Bearer app|client");
    assert.equal(embed["html"], "<blockquote></blockquote>");

    await assert.rejects(
      native(adapter).getOEmbed({ url: "https://example.com/p/1", context: context() }),
      /instagram\.com/,
    );

    const hashtags = await native(adapter).listRecentlySearchedHashtags({
      account,
      limit: 30,
      context: context(),
    });

    assert.equal(graph.calls[2]?.url.searchParams.get("limit"), "30");
    assert.deepEqual(hashtags.items, [{ id: "17843857450040591" }]);
    await assert.rejects(
      native(adapter).listRecentlySearchedHashtags({ account, limit: 31, context: context() }),
      /1 through 30/,
    );

    const events = await native(adapter).listUpcomingEvents({ account, context: context() });
    assert.deepEqual(events.items, [
      { id: "ev1", title: "Launch", start_time: "2026-12-01T18:00:00+0000" },
    ]);

    const created = await native(adapter).createUpcomingEvent({
      account,
      title: "Launch",
      startTime: "2026-12-01T18:00:00Z",
      endTime: "2026-12-01T19:00:00Z",
      notificationSubtypes: ["EVENT_START", "BEFORE_EVENT_1DAY", "BEFORE_EVENT_15MIN"],
      context: context(),
    });

    assert.deepEqual(created, { id: "ev2" });
    assert.deepEqual(bodyOf(graph.calls[4]), {
      title: "Launch",
      start_time: "2026-12-01T18:00:00Z",
      end_time: "2026-12-01T19:00:00Z",
      notification_subtypes: ["EVENT_START", "BEFORE_EVENT_1DAY", "BEFORE_EVENT_15MIN"],
    });

    await native(adapter).updateUpcomingEvent({
      account,
      eventId: "ev2",
      title: "Launch day",
      context: context(),
    });
    assert.deepEqual(bodyOf(graph.calls[5]), { title: "Launch day" });

    await assert.rejects(
      native(adapter).createUpcomingEvent({
        account,
        title: "Ends",
        startTime: "2026-12-01T18:00:00Z",
        endTime: "2026-12-01T19:00:00Z",
        notificationTargetTime: "EVENT_END",
        context: context(),
      }),
      /endTime is not allowed/,
    );
    await assert.rejects(
      native(adapter).createUpcomingEvent({
        account,
        title: "Few",
        startTime: "2026-12-01T18:00:00Z",
        notificationSubtypes: ["EVENT_START"],
        context: context(),
      }),
      /at least one more value/,
    );
    assert.equal(graph.calls.length, 6);
  });
});

describe("Instagram comments", () => {
  it("comments on owned media through POST /{ig-media-id}/comments [feature:instagram.comments.create_on_media]", async () => {
    const graph = fakeGraph([
      [(call) => call.url.pathname.endsWith("/media1/comments"), () => ({ id: "c9" })],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const created = await native(adapter).createComment({
      account,
      mediaId: "media1",
      text: "Thanks everyone",
      context: context(),
    });

    assert.equal(graph.calls[0]?.method, "POST");
    assert.deepEqual(bodyOf(graph.calls[0]), { message: "Thanks everyone" });
    assert.deepEqual(created, { id: "c9" });
    await assert.rejects(
      native(adapter).createComment({ account, mediaId: "media1", text: " ", context: context() }),
      /non-empty/,
    );
  });

  it("reads one comment with hidden [feature:instagram.comments.read_node]", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/c1"),
        () => ({
          id: "c1",
          text: "Hi",
          hidden: true,
          like_count: 2,
          from: { id: "u1", username: "fan" },
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const comment = await native(adapter).getComment({
      account,
      commentId: "c1",
      context: context(),
    });

    assert.ok(graph.calls[0]?.url.searchParams.get("fields")?.split(",").includes("hidden"));
    assert.deepEqual(comment, {
      id: "c1",
      text: "Hi",
      hidden: true,
      like_count: 2,
      from: { id: "u1", username: "fan" },
    });
  });

  it("lists ordered_comments with Facebook Login only", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/media1/ordered_comments"),
        () => ({ data: [{ id: "c1", text: "First", timestamp: "2026-11-01T00:00:00+0000" }] }),
      ],
    ]);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const ordered = await native(adapter).listOrderedComments({
      account,
      mediaId: "media1",
      context: context(),
    });

    assert.equal(graph.calls[0]?.url.pathname, "/v27.0/media1/ordered_comments");
    assert.equal(ordered.items[0]?.["id"], "c1");

    const instagramLogin = instagram({
      auth: { accessToken: "t", accountId: "ig1" },
      fetch: fetchNever,
    });

    await assert.rejects(
      native(instagramLogin).listOrderedComments({
        account,
        mediaId: "media1",
        context: context(),
      }),
      /Facebook Login/,
    );
  });

  it("replies to caption and comment mentions through POST /{ig-user-id}/mentions [feature:instagram.comments.mention_reply]", async () => {
    const graph = fakeGraph([
      [(call) => call.url.pathname.endsWith("/ig1/mentions"), () => ({ id: "c10" })],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).replyToMention({
      account,
      mediaId: "m1",
      text: "Thank you!",
      context: context(),
    });
    await native(adapter).replyToMention({
      account,
      mediaId: "m1",
      commentId: "c1",
      text: "Thank you!",
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[0]), { media_id: "m1", message: "Thank you!" });
    assert.deepEqual(bodyOf(graph.calls[1]), {
      media_id: "m1",
      message: "Thank you!",
      comment_id: "c1",
    });
  });
});

describe("Instagram messaging", () => {
  const sendRoute = [
    (call: Call) => call.url.pathname.endsWith("/ig1/messages"),
    () => ({ recipient_id: "igsid1", message_id: "mid.1" }),
  ] as const;

  const messengerProfileRoute = [
    (call: Call) => call.url.pathname.endsWith("/ig1/messenger_profile"),
    (call: Call) =>
      call.method === "GET"
        ? call.url.searchParams.get("fields") === "ice_breakers"
          ? {
              data: [
                { call_to_actions: [{ question: "Hours?", payload: "HOURS" }], locale: "default" },
              ],
            }
          : { data: [{ persistent_menu: [] }] }
        : { success: true },
  ] as const;

  it("sends a private reply with recipient: { comment_id }", async () => {
    const graph = fakeGraph([sendRoute]);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const sent = await native(adapter).privateReply({
      account,
      commentId: "c1",
      text: "Sent you the details",
      context: context(),
    });

    assert.equal(graph.calls[0]?.url.host, "graph.facebook.com");
    assert.deepEqual(bodyOf(graph.calls[0]), {
      recipient: { comment_id: "c1" },
      message: { text: "Sent you the details" },
    });
    assert.deepEqual(sent, { recipientId: "igsid1", messageId: "mid.1" });
  });

  it("sends images by url and attachment_id, like_heart, MEDIA_SHARE, files and reply_to", async () => {
    const graph = fakeGraph([sendRoute]);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const send = (
      message: Parameters<ReturnType<typeof native>["sendDirectMessage"]>[0]["message"],
      replyToMessageId?: string,
    ) =>
      native(adapter).sendDirectMessage({
        account,
        recipientId: "igsid1",
        message,
        ...definedFields({ replyToMessageId }),
        context: context(),
      });

    await send({
      kind: "images",
      images: [{ url: "https://cdn.example/a.png" }, { attachmentId: "att1" }],
    });
    await send({ kind: "like_heart" });
    await send({ kind: "media_share", mediaId: "media1" }, "mid.0");
    await send({ kind: "video", url: "https://cdn.example/clip.mp4" });

    assert.deepEqual(bodyOf(graph.calls[0]), {
      recipient: { id: "igsid1" },
      message: {
        attachments: [
          { type: "image", payload: { url: "https://cdn.example/a.png" } },
          { type: "image", payload: { attachment_id: "att1" } },
        ],
      },
    });
    assert.deepEqual(bodyOf(graph.calls[1])["message"], { attachment: { type: "like_heart" } });
    assert.deepEqual(bodyOf(graph.calls[2]), {
      recipient: { id: "igsid1" },
      message: { attachment: { type: "MEDIA_SHARE", payload: { id: "media1" } } },
      reply_to: { mid: "mid.0" },
    });
    assert.deepEqual(bodyOf(graph.calls[3])["message"], {
      attachment: { type: "video", payload: { url: "https://cdn.example/clip.mp4" } },
    });

    await assert.rejects(
      send({ kind: "images", images: Array.from({ length: 11 }, () => ({ attachmentId: "a" })) }),
      /1 to 10 images/,
    );
  });

  it("sends quick_replies, generic and button templates (template_type) and the HUMAN_AGENT tag", async () => {
    const graph = fakeGraph([sendRoute]);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).sendDirectMessage({
      account,
      recipientId: "igsid1",
      message: {
        kind: "text",
        text: "Pick one",
        quickReplies: [
          { title: "Red", payload: "RED" },
          { title: "Blue", payload: "BLUE" },
        ],
      },
      humanAgent: true,
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[0]), {
      recipient: { id: "igsid1" },
      message: {
        text: "Pick one",
        quick_replies: [
          { content_type: "text", title: "Red", payload: "RED" },
          { content_type: "text", title: "Blue", payload: "BLUE" },
        ],
      },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
    });

    await native(adapter).sendDirectMessage({
      account,
      recipientId: "igsid1",
      message: {
        kind: "generic_template",
        elements: [
          {
            title: "Sneaker",
            subtitle: "In stock",
            imageUrl: "https://cdn.example/shoe.jpg",
            defaultActionUrl: "https://shop.example/shoe",
            buttons: [
              { kind: "web_url", title: "Buy", url: "https://shop.example/buy" },
              { kind: "postback", title: "More", payload: "MORE" },
            ],
          },
        ],
      },
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[1])["message"], {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [
            {
              title: "Sneaker",
              subtitle: "In stock",
              image_url: "https://cdn.example/shoe.jpg",
              default_action: { type: "web_url", url: "https://shop.example/shoe" },
              buttons: [
                { type: "web_url", title: "Buy", url: "https://shop.example/buy" },
                { type: "postback", title: "More", payload: "MORE" },
              ],
            },
          ],
        },
      },
    });

    await native(adapter).sendDirectMessage({
      account,
      recipientId: "igsid1",
      message: {
        kind: "button_template",
        text: "Need help?",
        buttons: [{ kind: "postback", title: "Talk to us", payload: "AGENT" }],
      },
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[2])["message"], {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "Need help?",
          buttons: [{ type: "postback", title: "Talk to us", payload: "AGENT" }],
        },
      },
    });

    await assert.rejects(
      native(adapter).sendDirectMessage({
        account,
        recipientId: "igsid1",
        message: { kind: "button_template", text: "x", buttons: [] },
        context: context(),
      }),
      /1 to 3 buttons/,
    );
    assert.equal(graph.calls.length, 3);
  });

  it("sends react, unreact, typing_on and mark_seen sender actions", async () => {
    const graph = fakeGraph([sendRoute]);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).reactToMessage({
      account,
      recipientId: "igsid1",
      messageId: "mid.1",
      reaction: "love",
      context: context(),
    });
    await native(adapter).removeReaction({
      account,
      recipientId: "igsid1",
      messageId: "mid.1",
      context: context(),
    });
    await native(adapter).sendSenderAction({
      account,
      recipientId: "igsid1",
      action: "typing_on",
      context: context(),
    });
    await native(adapter).sendSenderAction({
      account,
      recipientId: "igsid1",
      action: "mark_seen",
      context: context(),
    });

    assert.deepEqual(
      graph.calls.map((call) => bodyOf(call)),
      [
        {
          recipient: { id: "igsid1" },
          sender_action: "react",
          payload: { message_id: "mid.1", reaction: "love" },
        },
        { recipient: { id: "igsid1" }, sender_action: "unreact", payload: { message_id: "mid.1" } },
        { recipient: { id: "igsid1" }, sender_action: "typing_on" },
        { recipient: { id: "igsid1" }, sender_action: "mark_seen" },
      ],
    );
  });

  it("reads, sets and deletes ice_breakers and persistent_menu", async () => {
    const graph = fakeGraph([messengerProfileRoute]);
    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const current = await native(adapter).getIceBreakers({ account, context: context() });
    assert.deepEqual(current, [
      { locale: "default", questions: [{ question: "Hours?", payload: "HOURS" }] },
    ]);

    await native(adapter).setIceBreakers({
      account,
      iceBreakers: [{ questions: [{ question: "Do you ship?", payload: "SHIP" }] }],
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[1]), {
      platform: "instagram",
      ice_breakers: [{ call_to_actions: [{ question: "Do you ship?", payload: "SHIP" }] }],
    });

    await native(adapter).deleteIceBreakers({ account, context: context() });
    assert.equal(graph.calls[2]?.method, "DELETE");
    assert.deepEqual(bodyOf(graph.calls[2]), { fields: ["ice_breakers"] });

    await native(adapter).setPersistentMenu({
      account,
      menus: [
        {
          locale: "default",
          items: [
            { kind: "postback", title: "Talk to a human", payload: "HUMAN" },
            { kind: "web_url", title: "Shop", url: "https://shop.example" },
          ],
        },
      ],
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[3]), {
      platform: "instagram",
      persistent_menu: [
        {
          locale: "default",
          composer_input_disabled: false,
          call_to_actions: [
            { type: "postback", title: "Talk to a human", payload: "HUMAN" },
            { type: "web_url", title: "Shop", url: "https://shop.example/" },
          ],
        },
      ],
    });

    await native(adapter).getPersistentMenu({ account, context: context() });
    assert.equal(graph.calls[4]?.url.searchParams.get("fields"), "persistent_menu");
    await native(adapter).deletePersistentMenu({ account, context: context() });
    assert.deepEqual(bodyOf(graph.calls[5]), { fields: ["persistent_menu"] });

    await assert.rejects(
      native(adapter).setIceBreakers({
        account,
        iceBreakers: [
          {
            questions: Array.from({ length: 5 }, (_, i) => ({
              question: `Q${i}`,
              payload: `P${i}`,
            })),
          },
        ],
        context: context(),
      }),
      /1 to 4 questions/,
    );
  });

  it("reads the User Profile API including is_user_follow_business", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/igsid1"),
        () => ({
          id: "igsid1",
          name: "Pat",
          username: "pat.shop",
          follower_count: 120,
          is_user_follow_business: true,
          is_business_follow_user: false,
          is_verified_user: false,
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const profile = await native(adapter).getMessagingUserProfile({
      account,
      recipientId: "igsid1",
      context: context(),
    });

    assert.ok(graph.calls[0]?.url.searchParams.get("fields")?.includes("is_user_follow_business"));
    assert.deepEqual(profile, {
      id: "igsid1",
      name: "Pat",
      username: "pat.shop",
      followerCount: 120,
      isUserFollowBusiness: true,
      isBusinessFollowUser: false,
      isVerifiedUser: false,
    });

    const unified = fakeGraph([[() => true, () => ({ id: "igsid1", username: "pat.shop" })]]);

    const facebook = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: unified.fetch,
    });

    await native(facebook).getMessagingUserProfile({
      account,
      recipientId: "igsid1",
      context: context(),
    });

    assert.equal(unified.calls[0]?.url.origin, "https://graph.facebook.com");
    assert.equal(unified.calls[0]?.url.pathname, "/v27.0/igsid1");
  });
});

describe("Instagram insights", () => {
  it("reads media insights such as views and total_interactions with breakdowns", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/media1/insights"),
        () => ({
          data: [
            { name: "views", period: "lifetime", values: [{ value: 1200 }] },
            { name: "total_interactions", period: "lifetime", values: [{ value: 88 }] },
            {
              name: "profile_activity",
              period: "lifetime",
              total_value: {
                value: 9,
                breakdowns: [
                  {
                    dimension_keys: ["action_type"],
                    results: [{ dimension_values: ["email"], value: 9 }],
                  },
                ],
              },
            },
          ],
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const insights = await native(adapter).getMediaInsights({
      account,
      mediaId: "media1",
      metrics: ["views", "total_interactions", "profile_activity"],
      breakdown: "action_type",
      context: context(),
    });

    assert.equal(
      graph.calls[0]?.url.searchParams.get("metric"),
      "views,total_interactions,profile_activity",
    );
    assert.equal(graph.calls[0]?.url.searchParams.get("breakdown"), "action_type");
    assert.deepEqual(insights, [
      { name: "views", period: "lifetime", values: [{ value: 1200 }] },
      { name: "total_interactions", period: "lifetime", values: [{ value: 88 }] },
      {
        name: "profile_activity",
        period: "lifetime",
        totalValue: {
          value: 9,
          breakdowns: [
            { dimensionKeys: ["action_type"], results: [{ dimensionValues: ["email"], value: 9 }] },
          ],
        },
      },
    ]);

    await assert.rejects(
      native(adapter).getMediaInsights({
        account,
        mediaId: "media1",
        metrics: ["views"],
        breakdown: "story_navigation_action_type",
        context: context(),
      }),
      /navigation/,
    );
  });

  it("requests views and total_interactions in normalized post metrics", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/media1/insights"),
        () => ({ data: [{ name: "views", period: "lifetime", values: [{ value: 5 }] }] }),
      ],
      [(call) => call.url.pathname.endsWith("/media1"), () => ({ media_product_type: "REELS" })],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await adapter.analytics?.getPostMetrics?.(
      {
        kind: "platform-post",
        version: 1,
        backend: "instagram",
        platform: "instagram",
        accountId: "ig1",
        postId: "media1",
      },
      context(),
    );

    assert.equal(
      graph.calls[1]?.url.searchParams.get("metric"),
      "likes,comments,saved,shares,reach,views,total_interactions",
    );
  });

  it("reads account insights with metric_type, since/until and breakdowns", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/insights"),
        () => ({
          data: [
            { name: "accounts_engaged", period: "day", total_value: { value: 310 } },
            {
              name: "reach",
              period: "day",
              total_value: {
                value: 900,
                breakdowns: [
                  {
                    dimension_keys: ["follow_type"],
                    results: [
                      { dimension_values: ["FOLLOWER"], value: 600 },
                      { dimension_values: ["NON_FOLLOWER"], value: 300 },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const rows = await native(adapter).getAccountInsights({
      account,
      metrics: ["accounts_engaged", "reach"],
      period: "day",
      metricType: "total_value",
      since: "2026-10-01T00:00:00Z",
      until: "2026-10-31T00:00:00Z",
      breakdown: ["follow_type"],
      context: context(),
    });

    const query = graph.calls[0]?.url.searchParams;
    assert.equal(query?.get("metric"), "accounts_engaged,reach");
    assert.equal(query?.get("period"), "day");
    assert.equal(query?.get("metric_type"), "total_value");
    assert.equal(query?.get("since"), "1790812800");
    assert.equal(query?.get("until"), "1793404800");
    assert.equal(query?.get("breakdown"), "follow_type");
    assert.deepEqual(rows[0], {
      name: "accounts_engaged",
      period: "day",
      totalValue: { value: 310 },
    });
    assert.equal(rows[1]?.totalValue?.breakdowns?.[0]?.results.length, 2);

    await assert.rejects(
      native(adapter).getAccountInsights({
        account,
        metrics: ["reach"],
        period: "day",
        metricType: "time_series",
        breakdown: ["follow_type"],
        context: context(),
      }),
      /total_value/,
    );
  });

  it("defaults account insights to accounts_engaged, reach, views and total_interactions", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/insights"),
        () => ({ data: [{ name: "accounts_engaged", period: "day", total_value: { value: 12 } }] }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const rows = await native(adapter).getAccountInsights({
      account,
      period: "day",
      context: context(),
    });

    const query = graph.calls[0]?.url.searchParams;

    assert.equal(query?.get("metric"), "accounts_engaged,reach,views,total_interactions");
    assert.equal(query?.get("metric_type"), "total_value");
    assert.deepEqual(rows, [
      { name: "accounts_engaged", period: "day", totalValue: { value: 12 } },
    ]);
  });

  it("reads follower_demographics with a lifetime timeframe [feature:instagram.analytics.demographics]", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/ig1/insights"),
        () => ({
          data: [
            {
              name: "follower_demographics",
              period: "lifetime",
              total_value: {
                breakdowns: [
                  {
                    dimension_keys: ["country"],
                    results: [
                      { dimension_values: ["US"], value: 420 },
                      { dimension_values: ["BR"], value: 99 },
                    ],
                  },
                ],
              },
            },
          ],
        }),
      ],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    const demographics = await native(adapter).getAudienceDemographics({
      account,
      metric: "follower_demographics",
      breakdown: "country",
      timeframe: "this_month",
      context: context(),
    });

    const query = graph.calls[0]?.url.searchParams;
    assert.equal(query?.get("metric"), "follower_demographics");
    assert.equal(query?.get("period"), "lifetime");
    assert.equal(query?.get("metric_type"), "total_value");
    assert.equal(query?.get("timeframe"), "this_month");
    assert.equal(query?.get("breakdown"), "country");
    assert.deepEqual(demographics.totalValue?.breakdowns?.[0]?.results, [
      { dimensionValues: ["US"], value: 420 },
      { dimensionValues: ["BR"], value: 99 },
    ]);
  });
});

describe("Instagram webhooks and setup", () => {
  const decode = (payload: JsonValue) =>
    decodePlatformWebhook({
      platform: "instagram",
      backend: "default",
      body: new TextEncoder().encode(JSON.stringify(payload)),
    });

  it('maps Facebook Login field: "mentions" and story_insights to typed events', async () => {
    const mention = await decode({
      object: "instagram",
      entry: [
        {
          id: "ig1",
          time: 1,
          changes: [{ field: "mentions", value: { media_id: "m1", comment_id: "c1" } }],
        },
      ],
    });

    assert.equal(mention.type, "mention.received");
    assert.equal(mention.originalType, "mentions");

    const insights = await decode({
      object: "instagram",
      entry: [
        {
          id: "ig1",
          time: 1,
          changes: [{ field: "story_insights", value: { media_id: "s1", reach: 40 } }],
        },
      ],
    });

    assert.equal(insights.type, "insights.updated");
    assert.equal(insights.originalType, "story_insights");
  });

  it("maps messaging_postbacks, reactions, seen, referrals and edits to typed events", async () => {
    const messaging = (event: JsonValue) =>
      decode({ object: "instagram", entry: [{ id: "ig1", time: 1, messaging: [event] }] });

    const base = { sender: { id: "igsid1" }, recipient: { id: "ig1" }, timestamp: 1 };

    const cases = [
      [
        { ...base, postback: { mid: "m1", title: "More", payload: "MORE" } },
        "messaging_postbacks",
        "message.postback",
      ],
      [
        { ...base, reaction: { mid: "m1", action: "react", reaction: "love", emoji: "❤️" } },
        "message_reactions",
        "message.reaction",
      ],
      [{ ...base, read: { mid: "m1" } }, "messaging_seen", "message.read"],
      [
        { ...base, referral: { ref: "promo", source: "ADS", type: "OPEN_THREAD" } },
        "messaging_referral",
        "message.referral",
      ],
      [
        { ...base, message_edit: { mid: "m1", text: "edited", num_edit: 1 } },
        "message_edit",
        "message.edited",
      ],
    ] as const;

    for (const [event, originalType, type] of cases) {
      const decoded = await messaging(event);
      assert.equal(decoded.originalType, originalType);
      assert.equal(decoded.type, type);
    }
  });

  it("subscribes webhook fields through /subscribed_apps", async () => {
    const graph = fakeGraph([
      [(call) => call.url.pathname.endsWith("/subscribed_apps"), () => ({ success: true })],
    ]);

    const adapter = instagram({ auth: { accessToken: "t", accountId: "ig1" }, fetch: graph.fetch });

    await native(adapter).subscribeWebhooks({
      account,
      fields: ["comments", "messages", "messaging_postbacks"],
      context: context(),
    });

    assert.equal(graph.calls[0]?.method, "POST");
    assert.equal(
      graph.calls[0]?.url.href,
      "https://graph.instagram.com/v27.0/ig1/subscribed_apps?subscribed_fields=comments%2Cmessages%2Cmessaging_postbacks",
    );

    const page = fakeGraph([
      [(call) => call.url.pathname.endsWith("/subscribed_apps"), () => ({ success: true })],
    ]);

    const facebook = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: page.fetch,
    });

    await native(facebook).subscribeWebhooks({
      account,
      fields: ["mentions"],
      pageId: "1050",
      context: context(),
    });
    assert.equal(page.calls[0]?.url.pathname, "/v27.0/1050/subscribed_apps");

    // Unified Login has no Page, so the Instagram account itself is subscribed.
    await native(facebook).subscribeWebhooks({
      account,
      fields: ["messages", "comments"],
      context: context(),
    });
    assert.equal(
      page.calls[1]?.url.href,
      "https://graph.facebook.com/v27.0/ig1/subscribed_apps?subscribed_fields=messages%2Ccomments",
    );

    await assert.rejects(
      native(adapter).subscribeWebhooks({
        account,
        fields: ["comments"],
        pageId: "1050",
        context: context(),
      }),
      /pageId/,
    );
  });

  it("discovers the Page's instagram_business_account", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.pathname.endsWith("/1050"),
        () => ({
          id: "1050",
          instagram_business_account: { id: "17841400000000001", username: "brand" },
        }),
      ],
    ]);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    const linked = await native(adapter).getPageInstagramAccount({
      pageId: "1050",
      context: context(),
    });

    assert.equal(
      graph.calls[0]?.url.searchParams.get("fields"),
      "instagram_business_account{id,username}",
    );
    assert.deepEqual(linked, { id: "17841400000000001", username: "brand" });
  });

  it("searches catalogs with catalog_product_search and updates product tags", async () => {
    const graph = fakeGraph([
      [
        (call) => call.url.searchParams.get("fields") === "shopping_product_tag_eligibility",
        () => ({ shopping_product_tag_eligibility: true }),
      ],
      [
        (call) => call.url.pathname.endsWith("/ig1/available_catalogs"),
        () => ({
          data: [{ catalog_id: "960179311066902", catalog_name: "Shop", product_count: 12 }],
        }),
      ],
      [
        (call) => call.url.pathname.endsWith("/ig1/catalog_product_search"),
        () => ({
          data: [{ product_id: 3231775643511089, product_name: "Mug", review_status: "approved" }],
          paging: { cursors: { after: "p2" } },
        }),
      ],
      [
        (call) => call.method === "GET" && call.url.pathname.endsWith("/media1/product_tags"),
        () => ({ data: [{ product_id: 3231775643511089, name: "Mug", x: 0.5, y: 0.5 }] }),
      ],
      [
        (call) => call.method === "POST" && call.url.pathname.endsWith("/media1/product_tags"),
        () => ({ success: true }),
      ],
    ]);

    const adapter = instagram({
      auth: { accessToken: "t", accountId: "ig1", flavor: "facebook-login" },
      fetch: graph.fetch,
    });

    assert.equal(
      await native(adapter).getProductTagEligibility({ account, context: context() }),
      true,
    );

    const catalogs = await native(adapter).listAvailableCatalogs({ account, context: context() });
    assert.equal(catalogs.items[0]?.["catalog_id"], "960179311066902");

    const products = await native(adapter).searchCatalogProducts({
      account,
      catalogId: "960179311066902",
      query: "mug",
      context: context(),
    });

    assert.equal(graph.calls[2]?.url.searchParams.get("catalog_id"), "960179311066902");
    assert.equal(graph.calls[2]?.url.searchParams.get("q"), "mug");
    assert.deepEqual(products, {
      items: [{ product_id: 3231775643511089, product_name: "Mug", review_status: "approved" }],
      nextCursor: "p2",
    });

    const tags = await native(adapter).listProductTags({
      account,
      mediaId: "media1",
      context: context(),
    });

    assert.deepEqual(tags, [{ product_id: 3231775643511089, name: "Mug", x: 0.5, y: 0.5 }]);

    await native(adapter).updateProductTags({
      account,
      mediaId: "media1",
      tags: [{ productId: "3231775643511089", x: 0.3, y: 0.6 }],
      context: context(),
    });

    assert.deepEqual(bodyOf(graph.calls[4]), {
      updated_tags: [{ product_id: "3231775643511089", x: 0.3, y: 0.6 }],
    });
  });
});

const fetchNever: typeof globalThis.fetch = async () => {
  throw new Error("unexpected request");
};
