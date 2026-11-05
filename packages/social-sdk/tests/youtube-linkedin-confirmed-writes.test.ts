import assert from "node:assert/strict";
import { it } from "node:test";
import { createSocial, SocialError, type AdapterOperationContext } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { youtube, type YouTubeNative } from "../src/platforms/youtube.js";
import type { JsonObject } from "../src/core/types.js";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "confirmed-writes",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

function uncertain(error: SocialError): boolean {
  return (
    error instanceof SocialError &&
    error.code === "ambiguous_outcome" &&
    error.retryDisposition.kind === "reconcile-first"
  );
}

/** Success bodies that do not confirm a created resource: no ID, an empty ID, a numeric ID, and non-objects. */
const unconfirmed: readonly { readonly name: string; readonly body: unknown }[] = [
  { name: "missing id", body: {} },
  { name: "empty id", body: { id: "" } },
  { name: "blank id", body: { id: "  " } },
  { name: "numeric id", body: { id: 7 } },
  { name: "null body", body: null },
  { name: "array body", body: [] },
];

function youtubeNative(respond: () => Response) {
  const requests: { method: string; url: URL; body: RequestInit["body"] }[] = [];

  const native = youtube({
    auth: { accessToken: "fixture-only", channelId: "channel1" },
    fetch: async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: new URL(String(input)),
        body: init?.body,
      });

      return respond();
    },
  }).native;

  assert.ok(native);

  return { native, requests };
}

const caption = {
  kind: "document",
  filename: "captions.vtt",
  mimeType: "text/vtt",
  source: { kind: "blob", blob: new Blob(["WEBVTT"]), fingerprint: "caption" },
} as const;

const image = {
  kind: "image",
  mimeType: "image/png",
  source: { kind: "blob", blob: new Blob(["png"], { type: "image/png" }), fingerprint: "image" },
} as const;

/** One call per resource create; each sends exactly one write. */
const creates: readonly {
  readonly name: string;
  readonly run: (native: YouTubeNative) => Promise<JsonObject | Blob | void>;
}[] = [
  {
    name: "playlists.insert",
    run: (native) =>
      native.playlists({
        action: "insert",
        body: { snippet: { title: "Releases" } },
        context: context(),
      }),
  },
  {
    name: "playlists.update",
    run: (native) =>
      // An update must answer with the playlist it addressed.
      native.playlists({
        action: "update",
        playlistId: "created1",
        body: { snippet: { title: "Releases" } },
        context: context(),
      }),
  },
  {
    name: "playlistItems.insert",
    run: (native) =>
      native.playlistItems({
        action: "insert",
        body: {
          snippet: {
            playlistId: "playlist1",
            resourceId: { kind: "youtube#video", videoId: "video1" },
          },
        },
        context: context(),
      }),
  },
  {
    name: "subscriptions.insert",
    run: (native) =>
      native.subscriptions({ action: "insert", channelId: "target", context: context() }),
  },
  {
    name: "reportingJobs.create",
    run: (native) =>
      native.reportingJobs({
        action: "create",
        reportTypeId: "channel_basic_a2",
        name: "Review",
        context: context(),
      }),
  },
  {
    name: "analyticsGroups.insert",
    run: (native) =>
      native.analyticsGroups({
        action: "insert",
        title: "Review",
        itemType: "youtube#video",
        context: context(),
      }),
  },
  {
    name: "analyticsGroupItems.insert",
    run: (native) =>
      native.analyticsGroupItems({
        action: "insert",
        groupId: "group1",
        resource: { kind: "youtube#video", id: "video1" },
        context: context(),
      }),
  },
  {
    name: "liveBroadcasts.insert",
    run: (native) =>
      native.liveBroadcasts({
        action: "insert",
        body: { snippet: { title: "Live" }, status: { privacyStatus: "private" } },
        context: context(),
      }),
  },
  {
    name: "liveStreams.insert",
    run: (native) =>
      native.liveStreams({
        action: "insert",
        body: {
          snippet: { title: "Stream" },
          cdn: { ingestionType: "rtmp", resolution: "variable", frameRate: "variable" },
        },
        context: context(),
      }),
  },
  {
    name: "liveChatMessages.insert",
    run: (native) =>
      native.liveChatMessages({
        action: "insert",
        body: { snippet: { liveChatId: "chat1", type: "textMessageEvent" } },
        context: context(),
      }),
  },
  {
    name: "liveChatModerators.insert",
    run: (native) =>
      native.liveChatModerators({
        action: "insert",
        body: { snippet: { liveChatId: "chat1", moderatorDetails: {} } },
        context: context(),
      }),
  },
  {
    name: "liveChatBans.insert",
    run: (native) =>
      native.liveChatBans({
        action: "insert",
        body: { snippet: { liveChatId: "chat1", type: "permanent" } },
        context: context(),
      }),
  },
  {
    name: "channelSections.insert",
    run: (native) =>
      native.channelSections({
        action: "insert",
        body: { snippet: { type: "recentUploads" } },
        context: context(),
      }),
  },
  {
    name: "commentThreads.insert",
    run: (native) =>
      native.commentThreads({
        action: "insert",
        videoId: "video1",
        text: "Hello",
        context: context(),
      }),
  },
  {
    name: "captions.insert",
    run: (native) =>
      native.captions({
        action: "insert",
        videoId: "video1",
        caption,
        body: { snippet: { language: "en", name: "English" } },
        context: context(),
      }),
  },
  {
    name: "playlistImages.insert",
    run: (native) =>
      native.playlistImages({
        action: "insert",
        playlistId: "playlist1",
        image,
        context: context(),
      }),
  },
];

for (const create of creates) {
  for (const { name, body } of unconfirmed) {
    it(`YouTube ${create.name} keeps a ${name} success uncertain after one write`, async () => {
      const { native, requests } = youtubeNative(() => Response.json(body));

      try {
        await assert.rejects(create.run(native), uncertain);
      } finally {
        assert.equal(requests.filter(({ method }) => method !== "GET").length, 1);
      }
    });
  }

  it(`YouTube ${create.name} returns the created resource when it carries its ID`, async () => {
    const { native, requests } = youtubeNative(() =>
      Response.json({ id: "created1", snippet: { channelId: "channel1" } }),
    );

    const result = await create.run(native);

    assert.deepEqual(result, { id: "created1", snippet: { channelId: "channel1" } });
    assert.equal(requests.filter(({ method }) => method !== "GET").length, 1);
  });
}

it("YouTube Analytics group items still treat 204 No Content as already present", async () => {
  // https://developers.google.com/youtube/analytics/reference/groupItems/insert#response
  const { native, requests } = youtubeNative(() => new Response(null, { status: 204 }));

  const result = await native.analyticsGroupItems({
    action: "insert",
    groupId: "group1",
    resource: { kind: "youtube#video", id: "video1" },
    context: context(),
  });

  assert.deepEqual(result, { alreadyInGroup: true });
  assert.equal(requests.length, 1);
});

it("YouTube comment replies keep an unidentified reply uncertain through createSocial", async () => {
  for (const { body } of unconfirmed) {
    let writes = 0;

    const social = createSocial({
      backend: youtube({
        auth: { accessToken: "fixture-only", channelId: "channel1" },
        fetch: async (_input, init) => {
          if (init?.method === "POST") {
            writes++;

            return Response.json(body);
          }

          return Response.json({
            items: [{ snippet: { videoId: "video1", topLevelComment: { id: "comment1" } } }],
          });
        },
      }),
    });

    try {
      await assert.rejects(
        social.comments.reply(
          {
            kind: "comment",
            version: 1,
            backend: "default",
            platform: "youtube",
            accountId: "channel1",
            postId: "video1",
            commentId: "comment1",
          },
          { text: "Thanks" },
        ),
        uncertain,
      );
    } finally {
      assert.equal(writes, 1);
    }
  }
});

it("YouTube playlists write and read localizations [feature:youtube.other.playlists.localizations]", async () => {
  // https://developers.google.com/youtube/v3/docs/playlists/insert and /update accept
  // localizations.(key).title/description alongside snippet.defaultLanguage.
  const { native, requests } = youtubeNative(() => Response.json({ id: "playlist1" }));

  const localizations = { fr: { title: "Versions", description: "Vidéos des versions" } };

  await native.playlists({
    action: "insert",
    body: { snippet: { title: "Releases", defaultLanguage: "en" }, localizations },
    context: context(),
  });
  await native.playlists({
    action: "update",
    playlistId: "playlist1",
    body: { snippet: { title: "Releases", defaultLanguage: "en" }, localizations },
    context: context(),
  });
  await native.playlists({
    action: "list",
    playlistId: "playlist1",
    parts: ["snippet", "localizations"],
    context: context(),
  });
  await native.playlists({ action: "list", playlistId: "playlist1", context: context() });

  assert.deepEqual(
    requests.map(({ method, url }) => [method, url.pathname, url.searchParams.get("part")]),
    [
      ["POST", "/youtube/v3/playlists", "snippet,localizations"],
      ["PUT", "/youtube/v3/playlists", "snippet,localizations"],
      ["GET", "/youtube/v3/playlists", "snippet,localizations"],
      ["GET", "/youtube/v3/playlists", "snippet,status,contentDetails"],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[0]?.body)), {
    snippet: { title: "Releases", defaultLanguage: "en" },
    localizations,
  });
  assert.deepEqual(JSON.parse(String(requests[1]?.body)), {
    id: "playlist1",
    snippet: { title: "Releases", defaultLanguage: "en" },
    localizations,
  });
});

it("YouTube playlist localizations need defaultLanguage and a valid map before any request", async () => {
  const { native, requests } = youtubeNative(() => Response.json({ id: "playlist1" }));

  const rejected: readonly Parameters<YouTubeNative["playlists"]>[0][] = [
    {
      action: "insert",
      body: { snippet: { title: "Releases" }, localizations: { fr: { title: "Versions" } } },
      context: context(),
    },
    {
      action: "update",
      playlistId: "playlist1",
      body: { localizations: { fr: { title: "Versions" } } },
      context: context(),
    },
    {
      action: "insert",
      body: {
        snippet: { title: "Releases", defaultLanguage: "en" },
        localizations: { fr: { title: 7 } },
      },
      context: context(),
    },
    {
      action: "insert",
      body: {
        snippet: { title: "Releases", defaultLanguage: "en" },
        localizations: { "not a tag": { title: "Versions" } },
      },
      context: context(),
    },
    {
      action: "insert",
      body: { snippet: { title: "Releases", defaultLanguage: "en" }, localizations: {} },
      context: context(),
    },
  ];

  for (const input of rejected)
    await assert.rejects(native.playlists(input), { code: "invalid_input" });

  await assert.rejects(
    native.playlists({
      action: "list",
      playlistId: "playlist1",
      parts: [],
      context: context(),
    }),
    { code: "invalid_input" },
  );
  assert.equal(requests.length, 0);
});

const linkedInAuthor = "urn:li:person:member1";

const linkedInPost = "urn:li:share:123";

const linkedInComment = "urn:li:comment:(urn:li:activity:123,456)";

function linkedInReply(answer: () => Response) {
  let writes = 0;

  const social = createSocial({
    backend: linkedin({
      auth: { author: linkedInAuthor, accessToken: "fixture-only" },
      apiVersion: "202610",
      fetch: async (input, init) => {
        if (init?.method === "POST") {
          writes++;

          return answer();
        }

        return Response.json(
          new URL(String(input)).pathname.startsWith("/rest/posts/")
            ? { id: linkedInPost, author: linkedInAuthor, lifecycleState: "PUBLISHED" }
            : { commentUrn: linkedInComment, object: linkedInPost },
        );
      },
    }),
  });

  const reply = () =>
    social.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "linkedin",
        accountId: linkedInAuthor,
        postId: linkedInPost,
        commentId: linkedInComment,
      },
      { text: "Review" },
    );

  return { reply, writes: () => writes };
}

it("LinkedIn comment replies keep a reply without a valid comment URN uncertain", async () => {
  // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api
  // returns the created comment with its composite commentUrn.
  const bodies: readonly unknown[] = [
    null,
    [],
    {},
    { commentUrn: "" },
    { commentUrn: 7 },
    { commentUrn: "urn:li:share:123" },
  ];

  for (const body of bodies) {
    const { reply, writes } = linkedInReply(() => Response.json(body));

    try {
      await assert.rejects(reply(), uncertain);
    } finally {
      assert.equal(writes(), 1);
    }
  }
});

it("LinkedIn comment replies return the created comment URN after one write", async () => {
  const created = "urn:li:comment:(urn:li:activity:123,457)";

  const { reply, writes } = linkedInReply(() => Response.json({ commentUrn: created }));

  const result = await reply();

  assert.equal(result.commentId, created);
  assert.equal(writes(), 1);
});

it("LinkedIn comment replies reject invalid input before any write", async () => {
  let requests = 0;

  const social = createSocial({
    backend: linkedin({
      auth: { author: linkedInAuthor, accessToken: "fixture-only" },
      apiVersion: "202610",
      fetch: async () => {
        requests++;

        return Response.json({});
      },
    }),
  });

  await assert.rejects(
    social.comments.reply(
      {
        kind: "comment",
        version: 1,
        backend: "default",
        platform: "linkedin",
        accountId: linkedInAuthor,
        postId: linkedInPost,
        commentId: linkedInComment,
      },
      { text: " " },
    ),
    { code: "invalid_input" },
  );
  assert.equal(requests, 0);
});
