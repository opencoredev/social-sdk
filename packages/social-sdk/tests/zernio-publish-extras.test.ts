import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef, type PublishRequest } from "../src/index.js";
import { zernio } from "../src/cloud/zernio.js";
import { isJsonValue } from "../src/transport/json.js";
import { array, object } from "../src/transport/validation.js";
import type { JsonObject, MediaAttachment } from "../src/core/types.js";

const image = (name: string): MediaAttachment => ({
  kind: "image",
  mimeType: "image/png",
  source: { kind: "https-url", url: `https://cdn.example.test/${name}.png` },
});

const video: MediaAttachment = {
  kind: "video",
  mimeType: "video/mp4",
  source: { kind: "https-url", url: "https://cdn.example.test/clip.mp4" },
};

const account = (platform: string) =>
  connectedAccountRef({ backend: "default", platform, accountId: "acc1" });

function parse(init?: RequestInit): JsonObject {
  const parsed: unknown = JSON.parse(String(init?.body));

  if (!isJsonValue(parsed)) throw new Error("Fixture body must be JSON.");

  return object(parsed);
}

/** Publish one target and return the create-post body Zernio received. */
async function sent(request: PublishRequest): Promise<JsonObject> {
  let captured: JsonObject | undefined;
  const target = request.targets[0];

  if (!target) throw new Error("A target is required.");

  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      fetch: async (input, init) => {
        assert.equal(new URL(String(input)).pathname, "/api/v1/posts");
        captured = parse(init);

        return Response.json({
          post: {
            _id: "post1",
            status: "published",
            platforms: [
              {
                platform: object(array(captured["platforms"])[0])["platform"] ?? "",
                accountId: "acc1",
                status: "published",
                platformPostId: "native1",
              },
            ],
          },
        });
      },
    }),
  });

  const result = await social.posts.publish(request);

  assert.equal(result.outcomes[0]?.state, "published", JSON.stringify(result.outcomes[0]));

  if (!captured) throw new Error("Zernio received no create request.");

  return captured;
}

function platformData(body: JsonObject): JsonObject {
  return object(object(array(body["platforms"])[0])["platformSpecificData"]);
}

function issues(request: PublishRequest): readonly string[] {
  const social = createSocial({
    backend: zernio({
      apiKey: "test",
      fetch: async () => {
        throw new Error("Preparation must not dispatch.");
      },
    }),
  });

  return social.posts.prepare(request).issues.map((issue) => issue.code);
}

const pinImage = image("pin");

it("maps per-attachment thumbnail and subtitles [feature:zernio.media.item_options]", async () => {
  const body = await sent({
    targets: [
      {
        account: account("youtube"),
        options: {
          title: "Launch",
          visibility: "public",
          madeForKids: false,
          mediaOptions: [
            {
              subtitles: [
                { url: "https://cdn.example.test/en.srt", language: "en" },
                { url: "https://cdn.example.test/pt.vtt", language: "pt-BR" },
              ],
            },
          ],
        },
      },
    ],
    content: {
      text: "Launch video",
      media: [
        { ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.test/t.jpg" } },
      ],
    },
  });

  assert.deepEqual(array(body["mediaItems"])[0], {
    type: "video",
    url: "https://cdn.example.test/clip.mp4",
    mimeType: "video/mp4",
    thumbnail: "https://cdn.example.test/t.jpg",
    subtitles: [
      { url: "https://cdn.example.test/en.srt", language: "en" },
      { url: "https://cdn.example.test/pt.vtt", language: "pt-BR" },
    ],
  });

  const reel = await sent({
    targets: [{ account: account("instagram"), options: { placement: "reels" } }],
    content: {
      text: "Reel",
      media: [
        { ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.test/c.jpg" } },
      ],
    },
  });

  assert.equal(
    object(array(reel["mediaItems"])[0])["instagramThumbnail"],
    "https://cdn.example.test/c.jpg",
  );

  const twice = [
    { url: "https://cdn.example.test/a.srt", language: "en" },
    { url: "https://cdn.example.test/b.srt", language: "en" },
  ];

  assert.ok(
    issues({
      targets: [{ account: account("x"), options: { mediaOptions: [{ subtitles: twice }] } }],
      content: { text: "x", media: [video] },
    }).includes("media.options"),
  );
  assert.ok(
    issues({
      targets: [
        {
          account: account("x"),
          options: {
            mediaOptions: [{ subtitles: [{ url: "https://a.test/a.srt", language: "en" }] }],
          },
        },
      ],
      content: { text: "x", media: [image("a")] },
    }).includes("media.options"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("x"), options: { mediaOptions: [{ skipProcessing: true }] } }],
      content: { text: "x", media: [video] },
    }).includes("media.options"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("x") }],
      content: {
        text: "x",
        media: [
          { ...video, thumbnail: { kind: "https-url", url: "https://cdn.example.test/t.jpg" } },
        ],
      },
    }).includes("media.thumbnail"),
  );
});

it("maps evergreen recycling with gap and gapFreq", async () => {
  const body = await sent({
    targets: [
      {
        account: account("x"),
        options: {
          recycling: {
            gap: 2,
            gapFreq: "week",
            expireCount: 5,
            contentVariations: ["Version one", "Version two"],
          },
        },
      },
    ],
    content: { text: "Evergreen tip" },
  });

  assert.deepEqual(body["recycling"], {
    enabled: true,
    gap: 2,
    gapFreq: "week",
    expireCount: 5,
    contentVariations: ["Version one", "Version two"],
  });
  assert.ok(
    issues({
      targets: [{ account: account("x"), options: { recycling: { gap: 0, gapFreq: "day" } } }],
      content: { text: "x" },
    }).includes("recycling"),
  );
  assert.ok(
    issues({
      targets: [
        { account: account("x"), options: { recycling: { gap: 1, contentVariations: ["only"] } } },
      ],
      content: { text: "x" },
    }).includes("recycling"),
  );
});

it("maps X longVideo and photo mediaTaggedUsers", async () => {
  const photo = await sent({
    targets: [{ account: account("x"), options: { mediaTaggedUsers: ["@jack", "opencore_dev"] } }],
    content: { text: "Team photo", media: [image("team")] },
  });

  assert.deepEqual(platformData(photo)["mediaTaggedUsers"], ["@jack", "opencore_dev"]);

  const long = await sent({
    targets: [{ account: account("x"), options: { longVideo: true } }],
    content: { text: "Full talk", media: [video] },
  });

  assert.equal(platformData(long)["longVideo"], true);
  assert.ok(
    issues({
      targets: [{ account: account("x"), options: { mediaTaggedUsers: ["jack"] } }],
      content: { text: "x", media: [video] },
    }).includes("x.media_tags"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("x"), options: { mediaTaggedUsers: ["not a name"] } }],
      content: { text: "x", media: [image("a")] },
    }).includes("x.media_tags"),
  );
});

it("targets one facebook-page of a connection with pageId", async () => {
  const body = await sent({
    targets: [{ account: account("facebook"), options: { pageId: "102938475610" } }],
    content: { text: "Second Page" },
  });

  assert.equal(platformData(body)["pageId"], "102938475610");
  assert.ok(
    issues({
      targets: [{ account: account("facebook"), options: { pageId: "my-page" } }],
      content: { text: "x" },
    }).includes("facebook.page"),
  );
});

it("maps Pinterest boardSectionId and video cover key frame", async () => {
  const pin = await sent({
    targets: [
      {
        account: account("pinterest"),
        options: { boardId: "b1", boardSectionId: "s1", title: "Pin" },
      },
    ],
    content: { text: "Pin", media: [pinImage] },
  });

  assert.equal(platformData(pin)["boardId"], "b1");
  assert.equal(platformData(pin)["boardSectionId"], "s1");

  const videoPin = await sent({
    targets: [
      { account: account("pinterest"), options: { boardId: "b1", coverImageKeyFrameTime: 3 } },
    ],
    content: { text: "Video pin", media: [video] },
  });

  assert.equal(platformData(videoPin)["coverImageKeyFrameTime"], 3);
  assert.ok(
    issues({
      targets: [{ account: account("pinterest"), options: { boardSectionId: "s1" } }],
      content: { text: "x", media: [pinImage] },
    }).includes("pinterest.board_section"),
  );
  assert.ok(
    issues({
      targets: [
        { account: account("pinterest"), options: { boardId: "b1", coverImageKeyFrameTime: 3 } },
      ],
      content: { text: "x", media: [pinImage] },
    }).includes("pinterest.cover"),
  );
});

it("maps YouTube notifySubscribers false", async () => {
  const body = await sent({
    targets: [
      {
        account: account("youtube"),
        options: {
          title: "Quiet upload",
          visibility: "unlisted",
          madeForKids: false,
          notifySubscribers: false,
        },
      },
    ],
    content: { text: "Quiet", media: [video] },
  });

  assert.equal(platformData(body)["notifySubscribers"], false);
});

it("maps Google Business EVENT and OFFER posts with topicType, couponCode and callToAction", async () => {
  const event = await sent({
    targets: [
      {
        account: account("google-business"),
        options: {
          topicType: "EVENT",
          eventTitle: "Grand opening",
          eventStart: "2026-12-05T09:00",
          eventEnd: "2026-12-06",
          callToActionType: "LEARN_MORE",
          callToActionUrl: "https://example.com/opening",
          languageCode: "en",
        },
      },
    ],
    content: { text: "Join us" },
  });

  assert.deepEqual(platformData(event), {
    topicType: "EVENT",
    languageCode: "en",
    callToAction: { type: "LEARN_MORE", url: "https://example.com/opening" },
    event: {
      title: "Grand opening",
      schedule: {
        startDate: { year: 2026, month: 12, day: 5 },
        endDate: { year: 2026, month: 12, day: 6 },
        startTime: { hours: 9, minutes: 0 },
      },
    },
  });

  const offer = await sent({
    targets: [
      {
        account: account("google-business"),
        options: {
          topicType: "OFFER",
          eventTitle: "Winter sale",
          eventStart: "2026-12-01",
          eventEnd: "2026-12-31",
          offerCouponCode: "SAVE20",
          offerRedeemUrl: "https://example.com/redeem",
          offerTerms: "One per customer.",
        },
      },
    ],
    content: { text: "20% off" },
  });

  assert.deepEqual(platformData(offer)["offer"], {
    couponCode: "SAVE20",
    redeemOnlineUrl: "https://example.com/redeem",
    termsConditions: "One per customer.",
  });
  assert.ok(
    issues({
      targets: [{ account: account("google-business"), options: { topicType: "EVENT" } }],
      content: { text: "x" },
    }).includes("google_business.event"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("google-business"), options: { offerCouponCode: "SAVE20" } }],
      content: { text: "x" },
    }).includes("google_business.offer"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("google-business"), options: { callToActionType: "BOOK" } }],
      content: { text: "x" },
    }).includes("google_business.call_to_action"),
  );
});

it("maps Telegram parseMode, disableNotification and protectContent", async () => {
  const body = await sent({
    targets: [
      {
        account: account("telegram"),
        options: {
          parseMode: "MarkdownV2",
          disableWebPagePreview: true,
          disableNotification: true,
          protectContent: true,
        },
      },
    ],
    content: { text: "*Release* notes" },
  });

  assert.deepEqual(platformData(body), {
    parseMode: "MarkdownV2",
    disableWebPagePreview: true,
    disableNotification: true,
    protectContent: true,
  });
  assert.ok(
    issues({
      targets: [{ account: account("telegram"), options: { parseMode: "BBCode" } }],
      content: { text: "x" },
    }).includes("telegram.parse_mode"),
  );
});

it("maps Reddit flairText, spoiler, sendreplies and videogif", async () => {
  const text = await sent({
    targets: [
      {
        account: account("reddit"),
        options: {
          subreddit: "typescript",
          title: "SDK release",
          flairText: "Release",
          spoiler: true,
          sendReplies: false,
          forceSelf: true,
        },
      },
    ],
    content: { text: "Notes" },
  });

  assert.deepEqual(platformData(text), {
    subreddit: "typescript",
    title: "SDK release",
    flairText: "Release",
    spoiler: true,
    sendreplies: false,
    forceSelf: true,
  });

  const gif = await sent({
    targets: [
      {
        account: account("reddit"),
        options: {
          subreddit: "gifs",
          title: "Loop",
          videoGif: true,
          videoPosterUrl: "https://cdn.example.test/poster.jpg",
        },
      },
    ],
    content: { text: "Loop", media: [video] },
  });

  assert.equal(platformData(gif)["videogif"], true);
  assert.equal(platformData(gif)["videoPosterUrl"], "https://cdn.example.test/poster.jpg");
  assert.ok(
    issues({
      targets: [
        { account: account("reddit"), options: { subreddit: "gifs", title: "t", videoGif: true } },
      ],
      content: { text: "x" },
    }).includes("reddit.video"),
  );
});

it("maps Discord embeds, poll, forum posts with forumThreadName and threadFromMessage", async () => {
  const embed = await sent({
    targets: [
      {
        account: account("discord"),
        options: {
          channelId: "111",
          embeds: [
            { title: "v2.0", description: "Out now", url: "https://example.com", color: 5814783 },
          ],
          crosspost: true,
          tts: false,
          webhookUsername: "Release bot",
          threadFromMessage: { name: "Discussion", autoArchiveDuration: 1440 },
        },
      },
    ],
    content: { text: "Release" },
  });

  assert.deepEqual(platformData(embed), {
    channelId: "111",
    embeds: [{ title: "v2.0", description: "Out now", url: "https://example.com", color: 5814783 }],
    crosspost: true,
    threadFromMessage: { name: "Discussion", autoArchiveDuration: 1440 },
    tts: false,
    webhookUsername: "Release bot",
  });

  const forum = await sent({
    targets: [
      {
        account: account("discord"),
        options: {
          channelId: "222",
          forumThreadName: "Feedback thread",
          forumAppliedTags: ["333"],
          poll: { question: "Ship it?", answers: ["Yes", "No"], durationHours: 48 },
        },
      },
    ],
    content: { text: "Vote" },
  });

  assert.deepEqual(platformData(forum), {
    channelId: "222",
    poll: {
      question: { text: "Ship it?" },
      answers: [{ poll_media: { text: "Yes" } }, { poll_media: { text: "No" } }],
      duration: 48,
    },
    forumThreadName: "Feedback thread",
    forumAppliedTags: ["333"],
  });
  assert.ok(
    issues({
      targets: [
        { account: account("discord"), options: { channelId: "1", forumAppliedTags: ["3"] } },
      ],
      content: { text: "x" },
    }).includes("discord.forum"),
  );
  assert.ok(
    issues({
      targets: [
        {
          account: account("discord"),
          options: { channelId: "1", poll: { question: "Q", answers: ["A"] } },
        },
      ],
      content: { text: "x", media: [image("a")] },
    }).includes("discord.poll"),
  );
  assert.ok(
    issues({
      targets: [
        { account: account("discord"), options: { channelId: "1", embeds: [{ color: "blue" }] } },
      ],
      content: { text: "x" },
    }).includes("discord.embeds"),
  );
});
