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

const pdf: MediaAttachment = {
  kind: "document",
  mimeType: "application/pdf",
  source: { kind: "https-url", url: "https://cdn.example.test/report.pdf" },
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

it("maps X quote, poll, labels, sensitive media and geo restriction", async () => {
  const quote = await sent({
    targets: [{ account: account("x"), options: { quotePostId: "1748391029384756102" } }],
    content: { text: "Worth reading" },
  });

  assert.equal(platformData(quote)["quoteTweetId"], "1748391029384756102");

  const poll = await sent({
    targets: [
      {
        account: account("x"),
        options: { poll: { options: ["Dark mode", "Analytics"], durationMinutes: 1440 } },
      },
    ],
    content: { text: "Which next?" },
  });

  assert.deepEqual(platformData(poll)["poll"], {
    options: ["Dark mode", "Analytics"],
    duration_minutes: 1440,
  });

  const labelled = await sent({
    targets: [
      {
        account: account("x"),
        options: {
          paidPartnership: true,
          madeWithAi: true,
          sensitiveMedia: { adultContent: false, graphicViolence: true },
          geoRestriction: { countries: ["US", "ES"] },
          replySettings: "subscribers",
        },
      },
    ],
    content: { text: "Launch", media: [image("a")] },
  });

  assert.deepEqual(platformData(labelled), {
    replySettings: "subscribers",
    paidPartnership: true,
    madeWithAi: true,
    sensitiveMedia: { adultContent: false, graphicViolence: true },
    geoRestriction: { countries: ["US", "ES"] },
  });
});

it("rejects X option combinations Zernio refuses", () => {
  const x = account("x");

  assert.ok(
    issues({
      targets: [{ account: x, options: { poll: { options: ["only"], durationMinutes: 4 } } }],
      content: { text: "poll" },
    }).includes("x.poll"),
  );
  assert.ok(
    issues({
      targets: [
        {
          account: x,
          options: { poll: { options: ["a", "b"], durationMinutes: 60 }, quotePostId: "1" },
        },
      ],
      content: { text: "poll" },
    }).includes("x.poll"),
  );
  assert.ok(
    issues({
      targets: [{ account: x, options: { quotePostId: "1" } }],
      content: { text: "q", media: [image("a")] },
    }).includes("x.quote"),
  );
  assert.ok(
    issues({
      targets: [{ account: x, options: { geoRestriction: { countries: ["us"] } } }],
      content: { text: "geo", media: [image("a")] },
    }).includes("x.geo_restriction"),
  );
  assert.ok(
    issues({
      targets: [{ account: x, options: { sensitiveMedia: { other: true } } }],
      content: { text: "no media" },
    }).includes("x.media_required"),
  );
  assert.ok(
    issues({
      targets: [
        {
          account: x,
          options: { replySettings: "verified" },
          replyTo: {
            kind: "platform-post",
            version: 1,
            backend: "default",
            platform: "x",
            accountId: "acc1",
            postId: "99",
          },
        },
      ],
      content: { text: "reply" },
    }).includes("x.reply_settings"),
  );
});

it("sends X, Threads and Bluesky threads as one threadItems sequence", async () => {
  for (const platform of ["x", "threads", "bluesky"]) {
    const body = await sent({
      targets: [
        {
          account: account(platform),
          options: {
            threadItems: [
              { text: "2/ second" },
              {
                text: "3/ third",
                media: [{ kind: "image", url: "https://cdn.example.test/3.png", altText: "chart" }],
              },
            ],
          },
        },
      ],
      content: { text: "1/ first", media: [image("1")] },
    });

    assert.deepEqual(platformData(body)["threadItems"], [
      {
        content: "1/ first",
        mediaItems: [
          { type: "image", url: "https://cdn.example.test/1.png", mimeType: "image/png" },
        ],
      },
      { content: "2/ second" },
      {
        content: "3/ third",
        mediaItems: [{ type: "image", url: "https://cdn.example.test/3.png", altText: "chart" }],
      },
    ]);
  }

  assert.ok(
    issues({
      targets: [{ account: account("threads"), options: { threadItems: [{}] } }],
      content: { text: "root" },
    }).includes("options.thread_items"),
  );
});

it("maps Threads topic_tag and first comment, and Bluesky langs", async () => {
  const threads = await sent({
    targets: [
      { account: account("threads"), options: { topicTag: "API Design", firstComment: "Links" } },
    ],
    content: { text: "Docs matter" },
  });

  assert.deepEqual(platformData(threads), { topic_tag: "API Design", firstComment: "Links" });
  assert.ok(
    issues({
      targets: [{ account: account("threads"), options: { topicTag: "a.b" } }],
      content: { text: "x" },
    }).includes("threads.topic_tag"),
  );

  const bluesky = await sent({
    targets: [{ account: account("bluesky"), options: { languages: ["pt", "en-US"] } }],
    content: { text: "Olá" },
  });

  assert.deepEqual(platformData(bluesky)["langs"], ["pt", "en-US"]);
});

it("maps YouTube category, tags, playlist, synthetic media and pinned first comment", async () => {
  const body = await sent({
    targets: [
      {
        account: account("youtube"),
        options: {
          title: "Walkthrough",
          visibility: "unlisted",
          madeForKids: false,
          categoryId: "28",
          tags: ["sdk", "typescript"],
          playlistId: "PL123",
          containsSyntheticMedia: true,
          firstComment: "Chapters below",
        },
      },
    ],
    content: { text: "Tour", media: [video] },
  });

  assert.deepEqual(body["tags"], ["sdk", "typescript"]);
  assert.deepEqual(platformData(body), {
    categoryId: "28",
    playlistId: "PL123",
    containsSyntheticMedia: true,
    firstComment: "Chapters below",
    title: "Walkthrough",
    visibility: "unlisted",
    madeForKids: false,
  });
  assert.ok(
    issues({
      targets: [
        {
          account: account("youtube"),
          options: {
            title: "t",
            visibility: "public",
            madeForKids: false,
            tags: [
              "a".repeat(100),
              "b".repeat(100),
              "c".repeat(100),
              "d".repeat(100),
              "e".repeat(101),
            ],
          },
        },
      ],
      content: { media: [video] },
    }).includes("youtube.tags"),
  );
});

it("maps TikTok commercialContentType, video cover and musicSoundInfo", async () => {
  const base = {
    privacy: "PUBLIC_TO_EVERYONE",
    consentGiven: true,
    disableComments: false,
    disableDuet: false,
    disableStitch: false,
    brandedContent: true,
    ownBrand: false,
    aiGenerated: false,
    draft: false,
  } as const;

  const body = await sent({
    targets: [
      {
        account: account("tiktok"),
        options: {
          ...base,
          coverTimestampMs: 2500,
          coverImageUrl: "https://cdn.example.test/cover.jpg",
          musicSoundId: "7350000000000000001",
        },
      },
    ],
    content: { text: "Clip", media: [video] },
  });

  const data = platformData(body);

  assert.equal(data["commercialContentType"], "brand_content");
  assert.equal(data["videoCoverTimestampMs"], 2500);
  assert.equal(data["videoCoverImageUrl"], "https://cdn.example.test/cover.jpg");
  assert.deepEqual(data["musicSoundInfo"], { musicSoundId: "7350000000000000001" });

  const organic = await sent({
    targets: [
      { account: account("tiktok"), options: { ...base, brandedContent: false, ownBrand: true } },
    ],
    content: { text: "Clip", media: [video] },
  });

  assert.equal(platformData(organic)["commercialContentType"], "brand_organic");
  assert.ok(
    issues({
      targets: [
        { account: account("tiktok"), options: { ...base, draft: true, musicSoundId: "1" } },
      ],
      content: { media: [video] },
    }).includes("tiktok.music"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("tiktok"), options: { ...base, coverTimestampMs: 10 } }],
      content: { media: [image("a")] },
    }).includes("tiktok.cover"),
  );
});

it("maps Instagram Stories, Reels options, collaborators, userTags and disclosure", async () => {
  const story = await sent({
    targets: [{ account: account("instagram"), options: { placement: "story" } }],
    content: { media: [image("s")] },
  });

  assert.deepEqual(platformData(story), { contentType: "story" });

  const reel = await sent({
    targets: [
      {
        account: account("instagram"),
        options: {
          placement: "reels",
          shareToFeed: false,
          collaborators: ["partner_one"],
          userTags: [{ username: "friend" }],
          locationId: "105890561436614",
          trialReel: "performance",
          thumbOffsetMs: 1500,
          audioName: "Studio take",
          aiGenerated: true,
          brandedContentSponsors: ["brandpartner"],
          paidPartnership: true,
          commentsEnabled: false,
          firstComment: "Link in bio",
        },
      },
    ],
    content: { text: "New reel", media: [video] },
  });

  assert.deepEqual(platformData(reel), {
    collaborators: ["partner_one"],
    userTags: [{ username: "friend" }],
    locationId: "105890561436614",
    trialParams: { graduationStrategy: "SS_PERFORMANCE" },
    thumbOffset: 1500,
    audioName: "Studio take",
    isAiGenerated: true,
    isPaidPartnership: true,
    brandedContentSponsors: ["brandpartner"],
    commentsEnabled: false,
    firstComment: "Link in bio",
    shareToFeed: false,
  });

  const manual = await sent({
    targets: [{ account: account("instagram"), options: { trialReel: "manual" } }],
    content: { media: [video] },
  });

  assert.deepEqual(platformData(manual)["trialParams"], { graduationStrategy: "MANUAL" });

  const carousel = await sent({
    targets: [
      {
        account: account("instagram"),
        options: { userTags: [{ username: "friend", x: 0.5, y: 0.25, mediaIndex: 1 }] },
      },
    ],
    content: { media: [image("1"), image("2")] },
  });

  assert.deepEqual(platformData(carousel)["userTags"], [
    { username: "friend", x: 0.5, y: 0.25, mediaIndex: 1 },
  ]);

  for (const [options, media, code] of [
    [{ placement: "reels" }, [image("a")], "instagram.placement"],
    [{ placement: "feed" }, [video], "instagram.placement"],
    [{ placement: "story", collaborators: ["a"] }, [image("a")], "instagram.story_options"],
    [{ audioName: "x" }, [image("a")], "instagram.reel_options"],
    [{ userTags: [{ username: "friend" }] }, [image("a")], "instagram.user_tags"],
    [{ collaborators: ["a", "b", "c", "d"] }, [image("a")], "instagram.collaborators"],
  ] as const)
    assert.ok(
      issues({
        targets: [{ account: account("instagram"), options }],
        content: { media },
      }).includes(code),
      code,
    );
});

it("maps Instagram Reel catalog audio and muteAudio", async () => {
  const reel = await sent({
    targets: [
      {
        account: account("instagram"),
        options: {
          audioConfiguration: { audioId: "482851939985510", audioVolume: 80, videoVolume: 0 },
          muteAudio: true,
        },
      },
    ],
    content: { media: [video] },
  });

  assert.deepEqual(platformData(reel), {
    audioConfiguration: { audioId: "482851939985510", audioVolume: 80, videoVolume: 0 },
    muteAudio: true,
  });

  const story = await sent({
    targets: [{ account: account("instagram"), options: { placement: "story", muteAudio: false } }],
    content: { media: [video] },
  });

  assert.deepEqual(platformData(story), { contentType: "story", muteAudio: false });

  for (const [options, media, code] of [
    [{ audioConfiguration: { audioId: "1" } }, [image("a")], "instagram.reel_options"],
    [
      { placement: "story", audioConfiguration: { audioId: "1" } },
      [video],
      "instagram.reel_options",
    ],
    [{ audioConfiguration: { audioId: "" } }, [video], "instagram.audio_configuration"],
    [
      { audioConfiguration: { audioId: "1", audioVolume: 101 } },
      [video],
      "instagram.audio_configuration",
    ],
    [
      { audioConfiguration: { audioId: "1", videoVolume: 2.5 } },
      [video],
      "instagram.audio_configuration",
    ],
    [{ audioConfiguration: { audioId: "1", volume: 5 } }, [video], "instagram.audio_configuration"],
    [{ muteAudio: true }, [image("a")], "instagram.mute_audio"],
    [{ muteAudio: "yes" }, [video], "instagram.mute_audio"],
  ] as const)
    assert.ok(
      issues({
        targets: [{ account: account("instagram"), options }],
        content: { media },
      }).includes(code),
      code,
    );
});

it("maps Facebook Reels, Stories, collaborators, link carouselCards and geo restriction", async () => {
  const reel = await sent({
    targets: [
      {
        account: account("facebook"),
        options: { reel: true, collaborators: ["1234567890"], firstComment: "More soon" },
      },
    ],
    content: { text: "Reel", media: [video] },
  });

  assert.deepEqual(platformData(reel), {
    contentType: "reel",
    collaborators: ["1234567890"],
    firstComment: "More soon",
  });

  const story = await sent({
    targets: [{ account: account("facebook"), options: { story: true } }],
    content: { media: [image("s")] },
  });

  assert.deepEqual(platformData(story), { contentType: "story" });

  const carousel = await sent({
    targets: [
      {
        account: account("facebook"),
        options: {
          carouselCards: [
            { link: "https://example.com/a", name: "Guide A" },
            { link: "https://example.com/b", description: "Read" },
          ],
          carouselLink: "https://example.com/guides",
          geoRestriction: { countries: ["DE"] },
        },
      },
    ],
    content: { text: "Pick one", media: [image("a"), image("b")] },
  });

  assert.deepEqual(platformData(carousel), {
    facebookSettings: {
      carouselCards: [
        { link: "https://example.com/a", name: "Guide A" },
        { link: "https://example.com/b", description: "Read" },
      ],
      carouselLink: "https://example.com/guides",
    },
    geoRestriction: { countries: ["DE"] },
  });

  for (const [options, media, code] of [
    [
      { carouselCards: [{ link: "https://example.com/a" }, { link: "https://example.com/b" }] },
      [image("a")],
      "facebook.carousel",
    ],
    [{ reel: true }, [image("a")], "facebook.reel"],
    [{ reel: true, story: true }, [video], "facebook.placement"],
    [{ collaborators: ["123"] }, [image("a")], "facebook.collaborators"],
  ] as const)
    assert.ok(
      issues({ targets: [{ account: account("facebook"), options }], content: { media } }).includes(
        code,
      ),
      code,
    );
});

it("maps LinkedIn documentTitle, reshareUrl, disableLinkPreview, polls and first comment", async () => {
  const document = await sent({
    targets: [{ account: account("linkedin"), options: { documentTitle: "2027 Report" } }],
    content: { text: "Our report", media: [pdf] },
  });

  assert.deepEqual(platformData(document), { documentTitle: "2027 Report" });
  assert.equal(object(array(document["mediaItems"])[0])["type"], "document");

  const reshare = await sent({
    targets: [
      {
        account: account("linkedin"),
        options: { reshare: "urn:li:share:7000000000000000000", disableLinkPreview: true },
      },
    ],
    content: { text: "Worth a read" },
  });

  assert.deepEqual(platformData(reshare), {
    reshareUrl: "urn:li:share:7000000000000000000",
    disableLinkPreview: true,
  });

  const poll = await sent({
    targets: [
      {
        account: account("linkedin"),
        options: {
          poll: { question: "Ship it?", options: ["Yes", "No"], duration: "THREE_DAYS" },
          firstComment: "Vote please",
        },
      },
    ],
    content: { text: "Quick poll" },
  });

  assert.deepEqual(platformData(poll), {
    poll: { question: "Ship it?", options: ["Yes", "No"], duration: "THREE_DAYS" },
    firstComment: "Vote please",
  });

  assert.ok(
    issues({
      targets: [{ account: account("linkedin"), options: { documentTitle: "t" } }],
      content: { text: "no document" },
    }).includes("linkedin.document_title"),
  );
  assert.ok(
    issues({
      targets: [{ account: account("x") }],
      content: { text: "doc", media: [pdf] },
    }).includes("media.document"),
  );
});

it("unpublishes Pinterest, Reddit, Discord, Telegram and Google Business posts [feature:zernio.delete.unpublish]", async () => {
  for (const platform of ["pinterest", "reddit", "discord", "telegram", "google-business"]) {
    const calls: string[] = [];
    const wire = platform === "google-business" ? "googlebusiness" : platform;

    const social = createSocial({
      backend: zernio({
        apiKey: "test",
        fetch: async (input, init) => {
          calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

          if (init?.method === "POST") {
            assert.deepEqual(parse(init), { platform: wire });

            return Response.json({ success: true });
          }

          return Response.json({
            post: {
              _id: "record",
              platforms: [
                { platform: wire, accountId: "acc1", status: "published", platformPostId: "n1" },
              ],
            },
          });
        },
      }),
    });

    await social.posts.removeFromPlatform({
      kind: "platform-post",
      version: 1,
      backend: "default",
      platform,
      accountId: "acc1",
      postId: "n1",
      native: { backendRecordId: "record" },
    });
    assert.deepEqual(calls, ["GET /api/v1/posts/record", "POST /api/v1/posts/record/unpublish"]);
  }

  const capabilities = zernio({ apiKey: "test" }).capabilities.capabilities;

  for (const platform of ["instagram", "tiktok", "snapchat"])
    assert.ok(
      !capabilities.some(
        (entry) => entry.platform === platform && entry.operation === "posts.removeFromPlatform",
      ),
      platform,
    );
});

it("deletes draft, failed and cancelled Zernio records but never scheduled or published ones", async () => {
  const deletable = ["draft", "failed", "cancelled"];

  for (const status of [...deletable, "scheduled", "published", "partial"]) {
    const deleted = deletable.includes(status);
    const methods: string[] = [];

    const social = createSocial({
      backend: zernio({
        apiKey: "test",
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json(
            init?.method === "DELETE"
              ? { message: "Post deleted successfully" }
              : {
                  post: {
                    _id: "record",
                    status,
                    platforms: [{ platform: "threads", accountId: "acc1", status: "failed" }],
                  },
                },
          );
        },
      }),
    });

    const ref = {
      kind: "backend-post",
      version: 1,
      backend: "default",
      platform: "threads",
      accountId: "acc1",
      recordId: "record",
    } as const;

    if (deleted) {
      await social.posts.deleteBackendRecord(ref);
      assert.deepEqual(methods, ["GET", "DELETE"], status);
    } else {
      await assert.rejects(social.posts.deleteBackendRecord(ref), { code: "invalid_input" });
      assert.deepEqual(methods, ["GET"], status);
    }
  }
});
