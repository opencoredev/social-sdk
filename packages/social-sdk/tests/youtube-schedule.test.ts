import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { youtube } from "../src/platforms/youtube.js";
import type { JsonObject, JsonValue } from "../src/core/types.js";
import { parseJson } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

const account = connectedAccountRef({
  backend: "default",
  platform: "youtube",
  accountId: "channel1",
});

const clock = () => new Date("2026-09-24T12:00:00.000Z");

const publishAt = "2026-10-01T15:00:00.000Z";

const job = {
  kind: "scheduled-job" as const,
  version: 1 as const,
  backend: "default",
  platform: "youtube" as const,
  accountId: "channel1",
  jobId: "video1",
};

const listed = (status: JsonObject) => ({
  items: [{ id: "video1", snippet: { channelId: "channel1", title: "Example" }, status }],
});

const pending = {
  uploadStatus: "processed",
  privacyStatus: "private",
  publishAt,
  license: "youtube",
  embeddable: true,
  publicStatsViewable: false,
  madeForKids: false,
  selfDeclaredMadeForKids: false,
  containsSyntheticMedia: true,
};

it("YouTube reports a scheduled upload as scheduled with a job reference", async () => {
  const social = createSocial({
    clock,
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      clock,
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          const body = object(parseJson(String(init.body)));

          assert.deepEqual(body["status"], {
            privacyStatus: "private",
            selfDeclaredMadeForKids: false,
            publishAt,
          });

          return new Response(null, {
            headers: {
              location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=secret",
            },
          });
        }

        return Response.json({
          id: "video1",
          status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt },
        });
      },
    }),
  });

  const result = await social.posts.publish({
    targets: [{ account, options: { title: "Example", visibility: "public", madeForKids: false } }],
    content: {
      media: [
        {
          kind: "video",
          mimeType: "video/mp4",
          source: { kind: "blob", blob: new Blob([new Uint8Array(100)]), fingerprint: "v1" },
        },
      ],
    },
    schedule: { at: publishAt },
  });

  const outcome = result.outcomes[0];
  assert.equal(outcome?.state, "scheduled");
  assert.equal(result.status, "pending");
  assert.deepEqual(outcome?.state === "scheduled" ? outcome.job : undefined, job);
});

it("YouTube cancels a schedule by clearing publishAt and preserving the other status fields", async () => {
  const calls: { method: string; url: URL; body?: JsonValue }[] = [];

  const social = createSocial({
    clock,
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      clock,
      fetch: async (input, init) => {
        const method = init?.method ?? "GET";
        const url = new URL(String(input));

        if (method === "GET") {
          calls.push({ method, url });

          return Response.json(listed(pending));
        }

        const body = object(parseJson(String(init?.body)));

        calls.push({ method, url, body });

        return Response.json({
          id: "video1",
          status: { ...object(body["status"]), uploadStatus: "processed", madeForKids: false },
        });
      },
    }),
  });

  assert.deepEqual(await social.posts.cancelScheduled(job), {
    state: "cancelled",
    backendRecord: "retained",
  });
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT"],
  );
  assert.equal(calls[0]?.url.searchParams.get("id"), "video1");
  assert.equal(calls[1]?.url.pathname, "/youtube/v3/videos");
  assert.equal(calls[1]?.url.searchParams.get("part"), "status");
  assert.deepEqual(calls[1]?.body, {
    id: "video1",
    status: {
      privacyStatus: "private",
      license: "youtube",
      embeddable: true,
      publicStatsViewable: false,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    },
  });
});

it("YouTube refuses to cancel a video that is not waiting for a future publish time", async () => {
  const statuses = [
    { ...pending, privacyStatus: "public" },
    { ...pending, publishAt: "2026-09-24T11:59:59.000Z" },
    { uploadStatus: "processed", privacyStatus: "private", selfDeclaredMadeForKids: false },
    { ...pending, publishAt: "not a date" },
  ];

  for (const status of statuses) {
    const methods: string[] = [];

    const social = createSocial({
      backend: youtube({
        auth: { accessToken: "test", channelId: "channel1" },
        clock,
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json(listed(status));
        },
      }),
    });

    await assert.rejects(social.posts.cancelScheduled(job), { code: "invalid_input" });
    assert.deepEqual(methods, ["GET"]);
  }
});

it("YouTube does not write when it cannot preserve the made-for-kids declaration", async () => {
  const methods: string[] = [];
  const { selfDeclaredMadeForKids: _omitted, ...status } = pending;

  const social = createSocial({
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      clock,
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");

        return Response.json(listed(status));
      },
    }),
  });

  await assert.rejects(social.posts.cancelScheduled(job), { code: "upstream_failure" });
  assert.deepEqual(methods, ["GET"]);
});

it("YouTube reports an unconfirmed or lost schedule cancellation as ambiguous without retrying", async () => {
  const responses = [
    () => Response.json({ id: "video1", status: { ...pending } }),
    () => Response.json({ id: "video1" }),
    () => Response.json({ error: { code: 503 } }, { status: 503 }),
  ];

  for (const respond of responses) {
    const methods: string[] = [];

    const social = createSocial({
      backend: youtube({
        auth: { accessToken: "test", channelId: "channel1" },
        clock,
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return init?.method === "PUT" ? respond() : Response.json(listed(pending));
        },
      }),
    });

    await assert.rejects(social.posts.cancelScheduled(job), {
      name: "SocialError",
      code: "ambiguous_outcome",
      retryDisposition: { kind: "reconcile-first" },
    });
    assert.deepEqual(methods, ["GET", "PUT"]);
  }
});

it("YouTube schedule cancellation rejects another channel before any request", async () => {
  let calls = 0;

  const social = createSocial({
    backend: youtube({
      auth: { accessToken: "test", channelId: "channel1" },
      fetch: async () => {
        calls++;

        return Response.json({});
      },
    }),
  });

  await assert.rejects(social.posts.cancelScheduled({ ...job, accountId: "channel2" }), {
    code: "unauthorized",
  });
  assert.equal(calls, 0);
});
