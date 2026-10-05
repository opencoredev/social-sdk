import assert from "node:assert/strict";
import { it } from "node:test";
import { createSocial, connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import { definedFields } from "../src/core/fields.js";
import { beginYouTubeUpload } from "../src/platforms/youtube-upload.js";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "audit",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
});

const account = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel1",
});

const ref = { ...account, postId: "video1" };

const video = {
  id: "video1",
  kind: "youtube#video",
  etag: "etag",
  snippet: {
    channelId: "channel1",
    title: "Old",
    categoryId: "22",
    description: "Old description",
    thumbnails: {},
    publishedAt: "2026-01-01",
  },
  status: {
    privacyStatus: "private",
    publishAt: "2099-01-01T00:00:00Z",
    uploadStatus: "processed",
    selfDeclaredMadeForKids: false,
  },
  statistics: { viewCount: "1" },
};

const media = {
  kind: "video",
  mimeType: "video/mp4",
  source: { kind: "blob", blob: new Blob(["x"]), fingerprint: "audit" },
} satisfies import("../src/index.js").MediaAttachment;

for (const paginated of [false, true]) {
  it(`replies to a distinct comment ID on ${paginated ? "a later" : "the first"} thread page`, async () => {
    const pages: (string | null)[] = [];
    let inserts = 0;
    let legacyErrors = 0;

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async (input, init) => {
        const url = new URL(String(input));

        if (init?.method === "POST") {
          inserts++;
          assert.equal(url.pathname, "/youtube/v3/comments");
          assert.deepEqual(JSON.parse(String(init.body)), {
            snippet: { parentId: "comment1", textOriginal: "Reply" },
          });

          return Response.json({ id: "reply1" });
        }

        if (url.searchParams.has("id")) {
          legacyErrors++;

          return Response.json(
            { error: { errors: [{ reason: "operationNotSupported" }] } },
            { status: 400 },
          );
        }

        assert.equal(url.pathname, "/youtube/v3/commentThreads");
        assert.equal(url.searchParams.get("videoId"), "video1");
        assert.equal(url.searchParams.get("maxResults"), "100");
        const page = url.searchParams.get("pageToken");
        pages.push(page);

        if (paginated && page === null) {
          return Response.json({
            items: [
              { id: "thread0", snippet: { videoId: "video1", topLevelComment: { id: "other" } } },
            ],
            nextPageToken: "second",
          });
        }

        return Response.json({
          items: [
            {
              id: "thread1",
              snippet: {
                videoId: "video1",
                topLevelComment: { id: "comment1", snippet: { textOriginal: "Parent" } },
              },
            },
          ],
        });
      },
    });

    const result = await adapter.comments!.reply!(
      { ...account, kind: "comment", postId: "video1", commentId: "comment1" },
      { text: "Reply" },
      context(),
    );

    assert.equal(result.commentId, "reply1");
    assert.equal(inserts, 1);
    assert.equal(legacyErrors, 0);
    assert.deepEqual(pages, paginated ? [null, "second"] : [null]);
  });
}

for (const mismatch of ["video", "comment", "account"]) {
  it(`does not insert a reply with a mismatched ${mismatch}`, async () => {
    let reads = 0;

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async (_input, init) => {
        assert.notEqual(init?.method, "POST");
        reads++;

        return Response.json({
          items: [
            {
              id: "thread1",
              snippet: {
                videoId: mismatch === "video" ? "other" : "video1",
                topLevelComment: { id: mismatch === "comment" ? "other" : "comment1" },
              },
            },
          ],
        });
      },
    });

    await assert.rejects(
      adapter.comments!.reply!(
        {
          ...account,
          accountId: mismatch === "account" ? "other" : account.accountId,
          kind: "comment",
          postId: "video1",
          commentId: "comment1",
        },
        { text: "Reply" },
        context(),
      ),
      { code: "unauthorized" },
    );
    assert.equal(reads, mismatch === "account" ? 0 : 1);
  });
}

for (const resource of ["playlists", "playlistItems"] as const) {
  it(`${resource} updates inject IDs, select written parts, and reject conflicts`, async () => {
    let calls = 0;

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        assert.equal(url.searchParams.get("part"), "snippet");
        assert.equal(url.searchParams.has("id"), false);
        assert.equal(url.searchParams.has("playlistId"), false);
        assert.deepEqual(JSON.parse(String(init?.body)), {
          id: "selected",
          snippet: { title: "Next", position: 1 },
        });
        // An existing contentDetails.note is preserved because that part is not written.

        return Response.json({ id: "selected", contentDetails: { note: "Keep" } });
      },
    });

    const input = {
      action: "update",
      playlistId: "selected",
      playlistItemId: "selected",
      body: { snippet: { title: "Next", position: 1 } },
      context: context(),
    } as const;

    const result = await adapter.native![resource](input);
    assert.deepEqual(result["contentDetails"], { note: "Keep" });
    await assert.rejects(
      adapter.native![resource]({
        ...input,
        body: { id: "conflict", snippet: {} },
        context: context(),
      }),
      { code: "invalid_input" },
    );
    assert.equal(calls, 1);
  });
}

it("video patches write only mutable fields, clear null fields, and clear schedules for public privacy", async () => {
  let written: unknown;

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (_input, init) => {
      if (init?.method === "PUT") {
        written = JSON.parse(String(init.body));

        return Response.json({ id: "video1" });
      }

      return Response.json({ items: [video] });
    },
  });

  await adapter.native!.updateVideo({
    videoId: "video1",
    body: { snippet: { title: "Next", description: null }, status: { privacyStatus: "public" } },
    context: context(),
  });
  assert.deepEqual(written, {
    id: "video1",
    snippet: { title: "Next", categoryId: "22" },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  });
  await assert.rejects(
    adapter.native!.updateVideo({
      videoId: "video1",
      body: { statistics: {} },
      context: context(),
    }),
    { code: "invalid_input" },
  );
  await assert.rejects(
    adapter.native!.updateVideo({
      videoId: "video1",
      body: { snippet: { categoryId: null } },
      context: context(),
    }),
    { code: "invalid_input" },
  );
});

it("resume and query allow the upload minimum despite a short budget and honor abort", async () => {
  const session = {
    url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test",
    size: 1,
    mimeType: "video/mp4",
    channelId: "channel1",
  };

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));

      return new Response(null, { status: 308 });
    },
  });

  const short = () => ({ ...context(), retryBudget: { maxAttempts: 1, maxElapsedMs: 5 } });
  assert.equal((await adapter.native!.queryUpload(session, short())).state, "incomplete");
  assert.equal((await adapter.native!.resumeUpload(session, media, short())).state, "incomplete");

  for (const action of ["query", "resume"]) {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...short(), signal: controller.signal };
    await assert.rejects(
      action === "query"
        ? adapter.native!.queryUpload(session, ctx)
        : adapter.native!.resumeUpload(session, media, ctx),
      { code: "cancelled" },
    );
  }
});

it("caption replacement selects id unless isDraft is explicitly written", async () => {
  const parts: (string | null)[] = [];
  const bodies: string[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      parts.push(new URL(String(input)).searchParams.get("part"));
      bodies.push(await new Response(init?.body).text());

      return Response.json({ id: "c1" });
    },
  });

  await adapter.native!.captions({
    action: "update",
    videoId: "video1",
    captionId: "c1",
    caption: media,
    context: context(),
  });
  await adapter.native!.captions({
    action: "update",
    videoId: "video1",
    captionId: "c1",
    caption: media,
    body: { snippet: { isDraft: false } },
    context: context(),
  });
  await adapter.native!.captions({
    action: "update",
    videoId: "video1",
    captionId: "c1",
    body: { snippet: { isDraft: true } },
    context: context(),
  });
  assert.deepEqual(parts, ["id", "snippet", "snippet"]);
  assert.match(bodies[0] ?? "", /\{"id":"c1"\}/);
});

it("caption downloads map auth and throttling and bound fetch and body reads", async () => {
  for (const [status, code] of [
    [401, "reconnect_required"],
    [403, "missing_permission"],
    [429, "rate_limited"],
  ] as const) {
    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async () => new Response(null, { status, headers: { "Retry-After": "2" } }),
    });

    await assert.rejects(
      adapter.native!.captions({
        action: "download",
        videoId: "video1",
        captionId: "c1",
        context: context(),
      }),
      { code },
    );
  }

  for (const bodyHung of [false, true]) {
    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: () =>
        bodyHung
          ? Promise.resolve(
              new Response(new ReadableStream({ pull: () => new Promise<void>(() => undefined) })),
            )
          : new Promise<Response>(() => undefined),
    });

    await assert.rejects(
      adapter.native!.captions({
        action: "download",
        videoId: "video1",
        captionId: "c1",
        context: { ...context(), retryBudget: { maxAttempts: 1, maxElapsedMs: 10 } },
      }),
      { code: "timeout" },
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      adapter.native!.captions({
        action: "download",
        videoId: "video1",
        captionId: "c1",
        context: { ...context(), signal: controller.signal },
      }),
      { code: "cancelled" },
    );
  }
});

it("live broadcast writes and reads include contentDetails", async () => {
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input) => {
      assert.equal(
        new URL(String(input)).searchParams.get("part"),
        "snippet,status,contentDetails",
      );

      return Response.json({});
    },
  });

  await adapter.native!.liveBroadcasts({
    action: "insert",
    body: { snippet: {}, status: {}, contentDetails: { enableAutoStart: true } },
    context: context(),
  });
  await adapter.native!.liveBroadcasts({ action: "list", context: context() });
});

it("both video deletion surfaces reject a different channel before DELETE", async () => {
  const methods: string[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (_input, init) => {
      methods.push(init?.method ?? "GET");

      return Response.json({
        items: [{ ...video, snippet: { ...video.snippet, channelId: "different" } }],
      });
    },
  });

  await assert.rejects(adapter.native!.deleteVideo({ videoId: "video1", context: context() }), {
    code: "unauthorized",
  });
  await assert.rejects(
    adapter.posts!.removeFromPlatform!({ ...ref, kind: "platform-post" }, context()),
    { code: "unauthorized" },
  );
  assert.deepEqual(methods, ["GET", "GET"]);
});

it("preparation rejects angle brackets in descriptions", () => {
  const social = createSocial({
    backend: youtube({ auth: { accessToken: "test", channelId: "channel1" } }),
  });

  for (const text of ["<tag", "tag>"])
    assert.equal(
      social.posts.prepare({
        targets: [
          { account, options: { title: "Title", visibility: "private", madeForKids: false } },
        ],
        content: { text, media: [media] },
      }).ok,
      false,
    );
});

it("channel upload caps are quota errors with a sanitized reason and no automatic retry", async () => {
  await assert.rejects(
    beginYouTubeUpload(
      { channelId: "channel1", size: 1, mimeType: "video/mp4", metadata: {} },
      {
        accessToken: "test",
        fetch: async () =>
          Response.json(
            { error: { errors: [{ reason: "uploadLimitExceeded" }] } },
            { status: 403 },
          ),
      },
    ),
    {
      code: "rate_limited",
      upstreamCode: "uploadLimitExceeded",
      retryDisposition: { kind: "never" },
    },
  );
});

it("subscription insert requires a channel and sends no list filters", async () => {
  let calls = 0;

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      calls++;
      assert.equal(new URL(String(input)).search, "?part=snippet");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        snippet: { resourceId: { kind: "youtube#channel", channelId: "target" } },
      });

      return Response.json({});
    },
  });

  await assert.rejects(adapter.native!.subscriptions({ action: "insert", context: context() }), {
    code: "invalid_input",
  });
  await adapter.native!.subscriptions({
    action: "insert",
    channelId: "target",
    context: context(),
  });
  assert.equal(calls, 1);
});

it("subscription list sends channelId as a query filter", async () => {
  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(url.searchParams.get("channelId"), "target");
      assert.equal(url.searchParams.has("mine"), false);
      assert.equal(url.searchParams.get("pageToken"), "next");

      return Response.json({ items: [] });
    },
  });

  await adapter.native!.subscriptions({
    action: "list",
    channelId: "target",
    pageToken: "next",
    context: context(),
  });
});

it("YouTube account reads traverse pages until the configured channel is found", async () => {
  const context = {
    backendInstance: "company",
    correlationId: "integration",
    retryBudget: { maxAttempts: 3, maxElapsedMs: 1000 },
  };

  const calls: URL[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "selected" },
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);

      return url.searchParams.has("pageToken")
        ? Response.json({ items: [{ id: "selected", snippet: { title: "Selected" } }] })
        : Response.json({ items: [], nextPageToken: "page-two" });
    },
  });

  assert.ok(adapter.accounts?.get);

  const record = await adapter.accounts.get(
    connectedAccountRef({
      backend: "company",
      platform: "youtube",
      accountId: "selected",
    }),
    context,
  );

  assert.equal(record.displayName, "Selected");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.searchParams.get("pageToken"), "page-two");
  assert.equal(calls[0]?.searchParams.get("maxResults"), "50");
});

it("caption downloads cancel stalled bodies and late fetch responses", async () => {
  for (const lateHeaders of [false, true]) {
    let cancelled = false;
    let release: ((response: Response) => void) | undefined;

    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
        cancel: () => {
          cancelled = true;
        },
      }),
    );

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: () =>
        lateHeaders
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(response),
    });

    await assert.rejects(
      adapter.native!.captions({
        action: "download",
        videoId: "video1",
        captionId: "c1",
        context: { ...context(), retryBudget: { maxAttempts: 1, maxElapsedMs: 10 } },
      }),
      { code: "timeout" },
    );

    if (lateHeaders) {
      assert.ok(release);
      release(response);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(cancelled, true);
    assert.equal(response.body?.locked, false);
  }
});

it("account reads return a found channel before checking subsequent page tokens", async () => {
  for (const repeatedToken of [false, true]) {
    let calls = 0;

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async () => {
        calls++;

        return Response.json({
          items: calls === 100 ? [{ id: "channel1", snippet: { title: "Selected" } }] : [],
          nextPageToken: repeatedToken && calls === 100 ? "page-99" : `page-${calls}`,
        });
      },
    });

    assert.ok(adapter.accounts?.get);
    const record = await adapter.accounts.get(account, context());
    assert.equal(record.displayName, "Selected");
    assert.equal(calls, 100);
  }
});

it("account reads stop after 100 pages when the selected channel is absent", async () => {
  let calls = 0;

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async () => {
      calls++;

      return Response.json({ items: [], nextPageToken: `page-${calls}` });
    },
  });

  assert.ok(adapter.accounts?.get);
  await assert.rejects(adapter.accounts.get(account, context()), { code: "upstream_failure" });
  assert.equal(calls, 100);
});

it("video edits preserve tags unless callers replace or explicitly clear them", async () => {
  for (const patch of [{ title: "Next" }, { tags: ["new"] }, { tags: null }]) {
    let written: unknown;

    const adapter = youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async (_input, init) => {
        if (init?.method === "PUT") {
          written = JSON.parse(String(init.body));

          return Response.json({ id: "video1" });
        }

        return Response.json({
          items: [{ ...video, snippet: { ...video.snippet, tags: ["old"] } }],
        });
      },
    });

    await adapter.native!.updateVideo({
      videoId: "video1",
      body: { snippet: patch },
      context: context(),
    });
    const expectedTags = "tags" in patch ? patch.tags : ["old"];

    assert.deepEqual(written, {
      id: "video1",
      snippet: {
        title: "title" in patch ? patch.title : "Old",
        categoryId: "22",
        description: "Old description",
        ...definedFields({ tags: expectedTags ?? undefined }),
      },
      status: {
        privacyStatus: "private",
        publishAt: "2099-01-01T00:00:00Z",
        selfDeclaredMadeForKids: false,
      },
    });
  }
});

it("reply lookup rejects repeated page tokens without inserting a comment", async () => {
  let calls = 0;
  let writes = 0;

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (_input, init) => {
      if (init?.method === "POST") writes++;
      calls++;

      return Response.json({ items: [], nextPageToken: calls <= 2 ? "repeated" : undefined });
    },
  });

  assert.ok(adapter.comments?.reply);
  await assert.rejects(
    adapter.comments.reply(
      { ...ref, kind: "comment", commentId: "missing" },
      { text: "Reply" },
      context(),
    ),
    { code: "upstream_failure" },
  );
  assert.equal(calls, 2);
  assert.equal(writes, 0);
});

it("caption updates reject empty changes and retain metadata-only draft updates", async () => {
  let calls = 0;

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (_input, init) => {
      calls++;
      const draft = calls === 1;

      assert.equal(init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), { id: "c1", snippet: { isDraft: draft } });

      return Response.json({ id: "c1" });
    },
  });

  for (const body of [
    undefined,
    {},
    { snippet: { name: "Unsupported change" } },
    { snippet: { isDraft: null } },
    { snippet: { isDraft: "false" } },
  ]) {
    await assert.rejects(
      adapter.native!.captions({
        action: "update",
        videoId: "video1",
        captionId: "c1",
        ...definedFields({ body }),
        context: context(),
      }),
      { code: "invalid_input" },
    );
  }

  assert.equal(calls, 0);

  for (const isDraft of [true, false]) {
    await adapter.native!.captions({
      action: "update",
      videoId: "video1",
      captionId: "c1",
      body: { snippet: { isDraft } },
      context: context(),
    });
  }

  assert.equal(calls, 2);
});
