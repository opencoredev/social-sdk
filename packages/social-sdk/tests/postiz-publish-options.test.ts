import { it } from "node:test";
import assert from "node:assert/strict";
import {
  connectedAccountRef,
  createSocial,
  type ConnectedAccountRef,
  type Platform,
  type PublishOptionsFor,
} from "../src/index.js";
import { postiz } from "../src/cloud/postiz.js";
import type { JsonObject, JsonValue, MediaAttachment, PublishContent } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object, string } from "../src/transport/validation.js";

const clock = () => new Date("2026-09-24T12:00:00.000Z");

const identifiers: Partial<Record<Platform, string>> = {
  x: "x",
  instagram: "instagram",
  facebook: "facebook",
  youtube: "youtube",
  tiktok: "tiktok",
  linkedin: "linkedin-page",
  pinterest: "pinterest",
  reddit: "reddit",
  "google-business": "gmb",
};

const image = (name: string): MediaAttachment => ({
  kind: "image",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.jpg` },
  mimeType: "image/jpeg",
});

const video: MediaAttachment = {
  kind: "video",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
  mimeType: "video/mp4",
};

const tiktokChoices = {
  privacy: "PUBLIC_TO_EVERYONE",
  consentGiven: true,
  disableComments: false,
  disableDuet: false,
  disableStitch: false,
  brandedContent: false,
  ownBrand: false,
  aiGenerated: false,
  draft: false,
};

const youtubeChoices = { title: "Launch", visibility: "public", madeForKids: false };

/** Publish one target through a fake Postiz and return the create request and its uploads. */
async function publish(
  platform: Platform,
  content: PublishContent,
  options: PublishOptionsFor<Platform>,
  schedule?: { readonly at: string },
) {
  const uploads: string[] = [];
  const creates: JsonObject[] = [];
  const provider = string(identifiers[platform]);

  const adapter = postiz({
    apiKey: "test",
    clock,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const parsed: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      const body = isJsonValue(parsed) ? object(parsed) : {};

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
            publishDate: schedule?.at ?? "2026-09-24T12:00:00.000Z",
            state: creates[0]?.["type"] === "draft" ? "DRAFT" : "QUEUE",
            group: "5e1f0c3a-8b2d-4f6e-9a7c-1d3b5f7e9a20",
            integration: { id: "int1", providerIdentifier: provider },
          },
        ],
      });
    },
  });

  const social = createSocial({ backend: adapter, clock });
  const account = connectedAccountRef({ backend: "default", platform, accountId: "int1" });
  const request = { targets: [{ account, options }], content, ...definedFields({ schedule }) };
  const prepared = social.posts.prepare(request);
  const result = prepared.ok ? await social.posts.publish(request) : undefined;
  const create = creates[0];

  return {
    issues: prepared.issues.map((issue) => issue.code),
    outcome: result?.outcomes[0],
    create,
    post: create === undefined ? undefined : object(array(create["posts"])[0]),
    uploads,
  };
}

const settingsOf = (post: JsonObject | undefined): JsonValue | undefined =>
  post === undefined ? undefined : post["settings"];

const valueOf = (post: JsonObject | undefined): readonly JsonValue[] =>
  post === undefined ? [] : array(post["value"]);

it("Postiz saves a draft with type draft and reports it as accepted", async () => {
  const at = "2026-09-26T09:00:00.000Z";

  const { create, outcome } = await publish(
    "x",
    { text: "Draft me" },
    { saveToDraft: true },
    { at },
  );

  assert.deepEqual({ type: create?.["type"], date: create?.["date"] }, { type: "draft", date: at });
  assert.equal(outcome?.state, "accepted");
});

it("Postiz sends thread parts with their delay [feature:postiz.publish.thread_parts]", async () => {
  const { post, issues } = await publish(
    "x",
    { text: "1/ Launch", media: [image("cover")] },
    { thread: [{ text: "2/ Details" }, { text: "3/ Link in reply", delayMinutes: 5 }] },
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(valueOf(post), [
    {
      content: "1/ Launch",
      image: [{ id: "m-cover.jpg", path: "https://uploads.postiz.com/cover.jpg" }],
    },
    { content: "2/ Details", image: [] },
    { content: "3/ Link in reply", image: [], delay: 5 },
  ]);

  const bad = await publish("x", { text: "hi" }, { thread: [{ text: "ok", delayMinutes: 1.5 }] });

  assert.ok(bad.issues.includes("postiz.thread"));
  assert.equal(bad.create, undefined);

  const youtube = await publish(
    "youtube",
    { text: "Watch", media: [video] },
    { ...youtubeChoices, thread: [{ text: "Comment" }] },
  );

  assert.ok(youtube.issues.includes("postiz.thread_unsupported"));
});

it("Postiz sends workspace tags by name [feature:postiz.publish.tags]", async () => {
  const { create } = await publish("x", { text: "Tagged" }, { workspaceTags: ["Launch", "Q3"] });

  assert.deepEqual(create?.["tags"], [
    { value: "Launch", label: "Launch" },
    { value: "Q3", label: "Q3" },
  ]);

  const bad = await publish("x", { text: "Tagged" }, { workspaceTags: [""] });

  assert.ok(bad.issues.includes("postiz.tags"));
});

it("Postiz shortens links only when asked [feature:postiz.publish.short_link]", async () => {
  assert.equal(
    (await publish("x", { text: "https://example.test/a" }, {})).create?.["shortLink"],
    false,
  );
  assert.equal(
    (await publish("x", { text: "https://example.test/a" }, { shortLink: true })).create?.[
      "shortLink"
    ],
    true,
  );
});

it("Postiz sets the video cover frame with thumbnailTimestamp", async () => {
  const { post } = await publish(
    "instagram",
    { text: "Reel", media: [video] },
    { thumbnailTimestamp: 3000 },
  );

  assert.deepEqual(valueOf(post)[0], {
    content: "Reel",
    image: [
      { id: "m-clip.mp4", path: "https://uploads.postiz.com/clip.mp4", thumbnailTimestamp: 3000 },
    ],
  });

  const inbox = await publish(
    "tiktok",
    { text: "Draft", media: [video] },
    { ...tiktokChoices, draft: true, thumbnailTimestamp: 1000 },
  );

  assert.ok(inbox.issues.includes("tiktok.cover_frame"));

  const photos = await publish(
    "instagram",
    { text: "Photo", media: [image("a")] },
    { thumbnailTimestamp: 1000 },
  );

  assert.ok(photos.issues.includes("postiz.cover_frame"));
});

it("Postiz maps X reply audience, community, and disclosures", async () => {
  const { post } = await publish(
    "x",
    { text: "Community post" },
    {
      replySettings: "subscribers",
      community: "https://x.com/i/communities/1493446837214187523",
      aiGenerated: true,
      paidPartnership: true,
    },
  );

  assert.deepEqual(settingsOf(post), {
    who_can_reply_post: "subscribers",
    community: "https://x.com/i/communities/1493446837214187523",
    made_with_ai: true,
    paid_partnership: true,
  });

  assert.equal(
    object(settingsOf((await publish("x", { text: "v" }, { replySettings: "verified" })).post))[
      "who_can_reply_post"
    ],
    "verified",
  );

  const bad = await publish("x", { text: "hi" }, { community: "https://x.com/someone" });

  assert.ok(bad.issues.includes("x.community"));
  assert.ok(
    (await publish("x", { text: "hi" }, { replySettings: "nobody" })).issues.includes(
      "x.reply_settings",
    ),
  );
});

it("Postiz publishes an X article with article_title and article_status", async () => {
  const { post } = await publish(
    "x",
    { text: "<p>Why we rebuilt our scheduler</p>" },
    { article: { title: "Why we rebuilt", status: "published" } },
  );

  assert.deepEqual(settingsOf(post), {
    who_can_reply_post: "everyone",
    post_type: "article",
    article_title: "Why we rebuilt",
    article_status: "published",
  });

  const draftThread = await publish(
    "x",
    { text: "<p>Body</p>" },
    { article: { title: "T", status: "draft" }, thread: [{ text: "reply" }] },
  );

  assert.ok(draftThread.issues.includes("x.article_thread"));
  assert.ok(
    (
      await publish(
        "x",
        { text: "<p>Body</p>", media: [video] },
        { article: { title: "T", status: "published" } },
      )
    ).issues.includes("x.article_media"),
  );
});

it("Postiz posts an Instagram story [feature:postiz.publish.instagram.story]", async () => {
  const { post } = await publish("instagram", { media: [image("story")] }, { postType: "story" });

  assert.deepEqual(settingsOf(post), { post_type: "story" });

  const two = await publish(
    "instagram",
    { media: [image("a"), image("b")] },
    { postType: "story" },
  );

  assert.ok(two.issues.includes("instagram.story_media"));
});

it("Postiz maps Instagram trial reels, collaborators, and reel audio", async () => {
  const { post } = await publish(
    "instagram",
    { text: "Trial", media: [video] },
    {
      trialReel: true,
      graduationStrategy: "SS_PERFORMANCE",
      collaborators: ["@partner", "friend"],
      audio: { id: "587784541076604", audioVolume: 80, videoVolume: 20 },
    },
  );

  assert.deepEqual(settingsOf(post), {
    post_type: "post",
    is_trial_reel: true,
    graduation_strategy: "SS_PERFORMANCE",
    collaborators: [{ label: "partner" }, { label: "friend" }],
    audio: { id: "587784541076604", audio_volume: 80, video_volume: 20 },
  });

  const photo = await publish(
    "instagram",
    { text: "Photo", media: [image("a")] },
    { trialReel: true, audio: { id: "1" } },
  );

  assert.ok(photo.issues.includes("instagram.trial_reel"));
  assert.ok(photo.issues.includes("instagram.audio"));
  assert.ok(
    (
      await publish("instagram", { media: [video] }, { audio: { id: "1", audioVolume: 101 } })
    ).issues.includes("instagram.audio"),
  );
  assert.ok(
    (
      await publish("instagram", { media: [video] }, { graduationStrategy: "MANUAL" })
    ).issues.includes("instagram.graduation_strategy"),
  );
});

it("Postiz maps the shared trialReel values to a trial reel and its graduation strategy", async () => {
  const account: ConnectedAccountRef<"instagram"> = connectedAccountRef({
    backend: "default",
    platform: "instagram",
    accountId: "int1",
  });

  const manual: PublishOptionsFor<"instagram"> = { trialReel: "manual" };
  const performance: PublishOptionsFor<"instagram"> = { trialReel: "performance" };

  const cases: readonly { options: PublishOptionsFor<"instagram">; strategy: string }[] = [
    { options: manual, strategy: "MANUAL" },
    { options: performance, strategy: "SS_PERFORMANCE" },
  ];

  for (const { options, strategy } of cases) {
    const { post, issues } = await publish(account.platform, { media: [video] }, options);

    assert.deepEqual(issues, []);
    assert.deepEqual(settingsOf(post), {
      post_type: "post",
      is_trial_reel: true,
      graduation_strategy: strategy,
    });
  }

  const photo = await publish(account.platform, { media: [image("a")] }, manual);

  assert.ok(photo.issues.includes("instagram.trial_reel"));

  // The shared value already names the strategy, so a second one is a conflict.
  const both = await publish(
    account.platform,
    { media: [video] },
    { trialReel: "manual", graduationStrategy: "SS_PERFORMANCE" },
  );

  assert.ok(both.issues.includes("instagram.graduation_strategy"));
  assert.ok(
    (
      await publish(account.platform, { media: [video] }, { trialReel: "sometimes" })
    ).issues.includes("instagram.trial_reel"),
  );
});

it("Postiz sends a Facebook link as url [feature:postiz.publish.facebook.link_url]", async () => {
  const { post, issues } = await publish(
    "facebook",
    {
      text: "New on the blog",
      link: { url: "https://example.test/blog/post" },
    },
    {},
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(settingsOf(post), { url: "https://example.test/blog/post" });

  const titled = await publish(
    "facebook",
    { text: "x", link: { url: "https://example.test/a", title: "A" } },
    {},
  );

  assert.ok(titled.issues.includes("link.explicit_text"));
});

it("Postiz posts Facebook stories [feature:postiz.publish.facebook.story]", async () => {
  const { post } = await publish(
    "facebook",
    { media: [image("a"), image("b")] },
    { postType: "story" },
  );

  assert.deepEqual(settingsOf(post), { post_type: "story" });
  assert.ok(
    (await publish("facebook", { text: "no media" }, { postType: "story" })).issues.includes(
      "facebook.story_media",
    ),
  );
});

it("Postiz sets a Facebook text background with text_format_preset_id", async () => {
  const { post } = await publish(
    "facebook",
    { text: "Short and bright" },
    {
      textFormatPresetId: "106018623298955",
    },
  );

  assert.deepEqual(settingsOf(post), { text_format_preset_id: "106018623298955" });
  assert.ok(
    (
      await publish("facebook", { text: "x".repeat(131) }, { textFormatPresetId: "1" })
    ).issues.includes("facebook.text_background"),
  );
});

it("Postiz titles a Facebook video [feature:postiz.publish.facebook.video_title]", async () => {
  const { post } = await publish(
    "facebook",
    { text: "Behind the scenes", media: [video] },
    { title: "Product launch" },
  );

  assert.deepEqual(settingsOf(post), { title: "Product launch" });
  assert.ok(
    (
      await publish("facebook", { text: "Photo", media: [image("a")] }, { title: "No" })
    ).issues.includes("facebook.title"),
  );
});

it("Postiz uploads a YouTube thumbnail into settings [feature:postiz.publish.youtube.thumbnail]", async () => {
  const { post, uploads } = await publish(
    "youtube",
    {
      text: "Watch",
      media: [
        {
          ...video,
          thumbnail: { kind: "https-url", url: "https://cdn.example.test/thumb.png" },
        },
      ],
    },
    youtubeChoices,
  );

  assert.deepEqual(uploads, [
    "https://cdn.example.test/thumb.png",
    "https://cdn.example.test/clip.mp4",
  ]);
  assert.deepEqual(settingsOf(post), {
    title: "Launch",
    type: "public",
    selfDeclaredMadeForKids: "no",
    thumbnail: { id: "m-thumb.png", path: "https://uploads.postiz.com/thumb.png" },
  });
  assert.deepEqual(valueOf(post)[0], {
    content: "Watch",
    image: [{ id: "m-clip.mp4", path: "https://uploads.postiz.com/clip.mp4" }],
  });

  const bad = await publish(
    "youtube",
    {
      text: "Watch",
      media: [{ ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.test/t" } }],
    },
    youtubeChoices,
  );

  assert.ok(bad.issues.includes("youtube.thumbnail_source"));
});

it("Postiz sends YouTube video tags [feature:postiz.publish.youtube.tags]", async () => {
  const { post } = await publish(
    "youtube",
    { text: "Watch", media: [video] },
    { ...youtubeChoices, tags: ["tech", "tutorial"] },
  );

  assert.deepEqual(object(settingsOf(post))["tags"], [
    { value: "tech", label: "tech" },
    { value: "tutorial", label: "tutorial" },
  ]);
});

it("Postiz asks TikTok to add music to a photo post [feature:postiz.publish.tiktok.auto_add_music]", async () => {
  const { post } = await publish(
    "tiktok",
    { text: "Photos", media: [image("a"), image("b")] },
    { ...tiktokChoices, autoAddMusic: true },
  );

  assert.equal(object(settingsOf(post))["autoAddMusic"], "yes");
  assert.equal(
    object(
      settingsOf(
        (await publish("tiktok", { text: "Photos", media: [image("a")] }, tiktokChoices)).post,
      ),
    )["autoAddMusic"],
    "no",
  );
  assert.ok(
    (
      await publish(
        "tiktok",
        { text: "Clip", media: [video] },
        { ...tiktokChoices, autoAddMusic: true },
      )
    ).issues.includes("tiktok.auto_add_music"),
  );
});

it("Postiz sends a TikTok title on direct posts and drafts [feature:postiz.publish.tiktok.title]", async () => {
  for (const draft of [false, true]) {
    const { post, issues } = await publish(
      "tiktok",
      { text: "Caption", media: [video] },
      { ...tiktokChoices, draft, title: "Ninety characters at most" },
    );

    assert.ok(!issues.includes("tiktok.title"));

    const settings = object(settingsOf(post));

    assert.equal(settings["title"], "Ninety characters at most");
    assert.equal(settings["content_posting_method"], draft ? "UPLOAD" : "DIRECT_POST");
  }

  assert.ok(
    (
      await publish("tiktok", { media: [video] }, { ...tiktokChoices, title: "x".repeat(91) })
    ).issues.includes("tiktok.title"),
  );
});

it("Postiz posts LinkedIn images as a carousel with post_as_images_carousel", async () => {
  const { post } = await publish(
    "linkedin",
    { text: "Showcase", media: [image("a"), image("b")] },
    { carousel: true, carouselName: "Product Showcase" },
  );

  assert.deepEqual(settingsOf(post), {
    post_as_images_carousel: true,
    carousel_name: "Product Showcase",
  });
  assert.ok(
    (
      await publish("linkedin", { text: "One", media: [image("a")] }, { carousel: true })
    ).issues.includes("linkedin.carousel"),
  );
});

it("Postiz passes LinkedIn company mention markup through unchanged [feature:postiz.publish.linkedin.company_mention]", async () => {
  const text =
    '<p>Built with <span data-mention-id="1035" data-mention-label="Microsoft">@Microsoft</span></p>';

  const { post } = await publish("linkedin", { text }, {});

  assert.equal(object(valueOf(post)[0])["content"], text);
});

it("Postiz sends a Pinterest dominant color [feature:postiz.publish.pinterest]", async () => {
  const { post } = await publish(
    "pinterest",
    { text: "Pin", media: [image("pin")] },
    { boardId: "123", title: "My Pin", link: "https://example.test", dominantColor: "#FF5733" },
  );

  assert.deepEqual(settingsOf(post), {
    board: "123",
    title: "My Pin",
    link: "https://example.test",
    dominant_color: "#FF5733",
  });
  assert.ok(
    (
      await publish(
        "pinterest",
        { media: [image("pin")] },
        { boardId: "123", dominantColor: "red" },
      )
    ).issues.includes("pinterest.dominant_color"),
  );
});

it("Postiz sends a Reddit link post from content.link", async () => {
  const { post, issues } = await publish(
    "reddit",
    { text: "Read this", link: { url: "https://example.test/article" } },
    { subreddit: "typescript", title: "A good article" },
  );

  assert.deepEqual(issues, []);
  assert.deepEqual(settingsOf(post), {
    subreddit: [
      {
        value: {
          subreddit: "/r/typescript",
          title: "A good article",
          type: "link",
          is_flair_required: false,
          url: "https://example.test/article",
        },
      },
    ],
  });
});

it("Postiz maps Google Business topicType, call to action, events, and offers", async () => {
  const event = await publish(
    "google-business",
    { text: "Open day" },
    {
      topicType: "EVENT",
      callToAction: { type: "LEARN_MORE", url: "https://example.test/open-day" },
      event: {
        title: "Open day",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        startTime: "09:00",
        endTime: "17:00",
      },
    },
  );

  assert.deepEqual(settingsOf(event.post), {
    topicType: "EVENT",
    callToActionType: "LEARN_MORE",
    callToActionUrl: "https://example.test/open-day",
    eventTitle: "Open day",
    eventStartDate: "2026-10-01",
    eventEndDate: "2026-10-02",
    eventStartTime: "09:00",
    eventEndTime: "17:00",
  });

  const offer = await publish(
    "google-business",
    { text: "20% off" },
    {
      topicType: "OFFER",
      event: { startDate: "2026-10-01", endDate: "2026-10-31" },
      offer: {
        couponCode: "SAVE20",
        redeemUrl: "https://example.test/redeem",
        terms: "One per person",
      },
    },
  );

  assert.deepEqual(settingsOf(offer.post), {
    topicType: "OFFER",
    eventStartDate: "2026-10-01",
    eventEndDate: "2026-10-31",
    offerCouponCode: "SAVE20",
    offerRedeemUrl: "https://example.test/redeem",
    offerTerms: "One per person",
  });

  assert.ok(
    (await publish("google-business", { text: "x" }, { topicType: "EVENT" })).issues.includes(
      "google_business.event",
    ),
  );
  assert.ok(
    (
      await publish("google-business", { text: "x" }, { callToAction: { type: "BOOK" } })
    ).issues.includes("google_business.cta"),
  );
  assert.ok(
    (
      await publish("google-business", { text: "x" }, { offer: { couponCode: "A" } })
    ).issues.includes("google_business.offer"),
  );
});
