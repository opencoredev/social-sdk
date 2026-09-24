import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import {
  answerMetaWebhookChallenge,
  answerXWebhookChallenge,
  answerYouTubeWebhookChallenge,
  decodePlatformWebhook,
  verifyMetaWebhook,
  verifyTikTokWebhook,
  verifyXWebhook,
  verifyYouTubeWebhook,
} from "../src/server/webhooks.js";
import { SocialError, type AdapterOperationContext } from "../src/core/index.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";
import { x } from "../src/platforms/x.js";
import { youtube } from "../src/platforms/youtube.js";
import { tiktok } from "../src/platforms/tiktok.js";

const secret = "test-webhook-secret";

const encode = (value: string) => new TextEncoder().encode(value);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- fixture serializer.
const json = (value: unknown) => encode(JSON.stringify(value));

const hmac = (algorithm: string, body: Uint8Array | string, key = secret) =>
  createHmac(algorithm, key).update(body);

const context: AdapterOperationContext = {
  backendInstance: "direct",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

async function rejects(promise: Promise<unknown>, code: string, operation?: string) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, code);

    if (operation) assert.equal(error.operation, operation);
    assert.doesNotMatch(error.message, new RegExp(secret));

    return true;
  });
}

const instagramBody = json({
  object: "instagram",
  entry: [
    {
      id: "ig-account-1",
      time: 1_790_000_000,
      changes: [{ field: "comments", value: { id: "comment-1", text: "fixture comment" } }],
    },
  ],
});

it("verifies Meta X-Hub-Signature-256 over the raw body", async () => {
  const headers = new Headers({
    "X-Hub-Signature-256": `sha256=${hmac("sha256", instagramBody).digest("hex")}`,
  });

  const verified = await verifyMetaWebhook({ secret, headers, body: instagramBody });
  assert.deepEqual(verified, {
    valid: true,
    method: "hmac-sha256",
    bodyAuthenticated: true,
    signedTimestamp: false,
  });

  const altered = new Uint8Array(instagramBody);
  altered[altered.length - 2] = 0x20;
  await rejects(verifyMetaWebhook({ secret, headers, body: altered }), "unauthorized");
  await rejects(
    verifyMetaWebhook({ secret: "other-secret", headers, body: instagramBody }),
    "unauthorized",
  );
  await rejects(
    verifyMetaWebhook({ secret, headers: new Headers(), body: instagramBody }),
    "unauthorized",
  );
  await rejects(
    verifyMetaWebhook({
      secret,
      headers: new Headers({ "X-Hub-Signature-256": "sha256=zz" }),
      body: instagramBody,
    }),
    "unauthorized",
  );
  await rejects(verifyMetaWebhook({ secret: "", headers, body: instagramBody }), "unauthorized");
  await rejects(
    verifyMetaWebhook({ secret, headers, body: instagramBody, maxBytes: 8 }),
    "unauthorized",
  );
});

it("answers the Meta verification handshake only for the configured token", async () => {
  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "fixture-verify-token",
    "hub.challenge": "1158201444",
  });

  const response = await answerMetaWebhookChallenge({
    verifyToken: "fixture-verify-token",
    query,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body, "1158201444");
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");

  await rejects(
    answerMetaWebhookChallenge({ verifyToken: "different-token", query }),
    "unauthorized",
    "webhooks.challenge",
  );

  const script = new URLSearchParams(query);
  script.set("hub.challenge", "<script>");
  await rejects(
    answerMetaWebhookChallenge({ verifyToken: "fixture-verify-token", query: script }),
    "unauthorized",
  );

  const unsubscribe = new URLSearchParams(query);
  unsubscribe.set("hub.mode", "unsubscribe");
  await rejects(
    answerMetaWebhookChallenge({ verifyToken: "fixture-verify-token", query: unsubscribe }),
    "unauthorized",
  );
});

it("verifies both X signature headers and answers the CRC check", async () => {
  const body = json({ for_user_id: "2244994945", favorite_events: [{ id: "fav-1" }] });
  const signature = `sha256=${hmac("sha256", body).digest("base64")}`;

  for (const name of ["X-Twitter-Webhooks-Signature-OAuth2", "X-Twitter-Webhooks-Signature"]) {
    const verified = await verifyXWebhook({
      secret,
      headers: new Headers({ [name]: signature }),
      body,
    });

    assert.equal(verified.method, "hmac-sha256");
  }

  const headers = new Headers({ "X-Twitter-Webhooks-Signature": signature });
  await rejects(
    verifyXWebhook({ secret, headers, body: json({ for_user_id: "1" }) }),
    "unauthorized",
  );
  await rejects(verifyXWebhook({ secret: "other-secret", headers, body }), "unauthorized");
  await rejects(verifyXWebhook({ secret, headers: new Headers(), body }), "unauthorized");
  await rejects(
    verifyXWebhook({
      secret,
      headers: new Headers({
        "X-Twitter-Webhooks-Signature": `sha256=${hmac("sha256", body).digest("hex")}`,
      }),
      body,
    }),
    "unauthorized",
  );

  const crc = await answerXWebhookChallenge({
    secret,
    query: new URLSearchParams({ crc_token: "fixture-crc-token" }),
  });

  const expected = `sha256=${hmac("sha256", "fixture-crc-token").digest("base64")}`;
  assert.equal(crc.responseToken, expected);
  assert.deepEqual(JSON.parse(crc.body), { response_token: expected });
  assert.equal(crc.headers["Content-Type"], "application/json");

  await rejects(
    answerXWebhookChallenge({ secret, query: new URLSearchParams() }),
    "unauthorized",
    "webhooks.challenge",
  );
  await rejects(
    answerXWebhookChallenge({
      secret,
      query: new URLSearchParams({ crc_token: "a".repeat(1025) }),
    }),
    "unauthorized",
  );
});

const youtubeFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
  <title>YouTube video feed</title>
  <entry>
    <id>yt:video:VIDEO_ID_01</id>
    <yt:videoId>VIDEO_ID_01</yt:videoId>
    <yt:channelId>UC_FIXTURE_CHANNEL</yt:channelId>
    <title>Fixture &amp; video</title>
    <published>2026-09-24T10:00:00+00:00</published>
    <updated>2026-09-24T10:05:00+00:00</updated>
  </entry>
</feed>`;

it("verifies YouTube hub signatures with the reported algorithm", async () => {
  const body = encode(youtubeFeed);

  for (const [algorithm, method] of [
    ["sha1", "hmac-sha1"],
    ["sha256", "hmac-sha256"],
    ["sha512", "hmac-sha512"],
  ] as const) {
    const headers = new Headers({
      "X-Hub-Signature": `${algorithm}=${hmac(algorithm, body).digest("hex")}`,
    });

    assert.equal((await verifyYouTubeWebhook({ secret, headers, body })).method, method);
  }

  const headers = new Headers({ "X-Hub-Signature": `sha1=${hmac("sha1", body).digest("hex")}` });
  await rejects(
    verifyYouTubeWebhook({ secret, headers, body: encode(`${youtubeFeed} `) }),
    "unauthorized",
  );
  await rejects(verifyYouTubeWebhook({ secret: "other-secret", headers, body }), "unauthorized");
  await rejects(verifyYouTubeWebhook({ secret, headers: new Headers(), body }), "unauthorized");
  await rejects(
    verifyYouTubeWebhook({
      secret,
      headers: new Headers({ "X-Hub-Signature": `md5=${hmac("md5", body).digest("hex")}` }),
      body,
    }),
    "unauthorized",
  );
  await rejects(
    verifyYouTubeWebhook({
      secret,
      headers: new Headers({ "X-Hub-Signature": `sha256=${hmac("sha1", body).digest("hex")}` }),
      body,
    }),
    "unauthorized",
  );
});

it("answers YouTube verification of intent only for expected topics", () => {
  const topic = "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC_FIXTURE_CHANNEL";

  const query = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.topic": topic,
    "hub.challenge": "fixture-challenge-123",
    "hub.lease_seconds": "432000",
  });

  const response = answerYouTubeWebhookChallenge({ query, topics: [topic] });
  assert.equal(response.body, "fixture-challenge-123");
  assert.equal(response.mode, "subscribe");
  assert.equal(response.leaseSeconds, 432_000);
  assert.equal(response.headers["Content-Type"], "application/octet-stream");

  const unsubscribe = new URLSearchParams({
    "hub.mode": "unsubscribe",
    "hub.topic": topic,
    "hub.challenge": "fixture-challenge-456",
  });

  const removed = answerYouTubeWebhookChallenge({ query: unsubscribe, topics: [topic] });
  assert.equal(removed.mode, "unsubscribe");
  assert.equal(removed.leaseSeconds, undefined);

  for (const bad of [
    { topics: ["https://www.youtube.com/xml/feeds/videos.xml?channel_id=OTHER"], query },
    {
      topics: [topic],
      query: new URLSearchParams({ ...Object.fromEntries(query), "hub.mode": "denied" }),
    },
    {
      topics: [topic],
      query: new URLSearchParams({ ...Object.fromEntries(query), "hub.challenge": "<b>" }),
    },
    {
      topics: [topic],
      query: new URLSearchParams({ ...Object.fromEntries(query), "hub.lease_seconds": "-1" }),
    },
  ])
    assert.throws(
      () => answerYouTubeWebhookChallenge(bad),
      (error) =>
        error instanceof SocialError &&
        error.code === "not_found" &&
        error.operation === "webhooks.challenge",
    );
});

const tiktokBody = json({
  client_key: "fixture-client-key",
  event: "post.publish.complete",
  create_time: 1_790_000_000,
  user_openid: "open-id-1",
  content: JSON.stringify({ publish_id: "v_pub_fixture_1", publish_type: "DIRECT_PUBLISH" }),
});

function tiktokHeaders(timestamp: number, body = tiktokBody, key = secret) {
  const signature = createHmac("sha256", key).update(`${timestamp}.`).update(body).digest("hex");

  return new Headers({ "TikTok-Signature": `t=${timestamp},s=${signature}` });
}

it("verifies TikTok-Signature with a timestamp window", async () => {
  const signedAt = 1_790_000_100;
  const now = () => new Date((signedAt + 60) * 1000);

  const verified = await verifyTikTokWebhook({
    secret,
    headers: tiktokHeaders(signedAt),
    body: tiktokBody,
    now,
  });

  assert.deepEqual(verified, {
    valid: true,
    method: "hmac-sha256",
    bodyAuthenticated: true,
    signedTimestamp: true,
    signedAt: new Date(signedAt * 1000).toISOString(),
  });

  await assert.rejects(
    verifyTikTokWebhook({
      secret,
      headers: tiktokHeaders(signedAt),
      body: tiktokBody,
      now: () => new Date((signedAt + 301) * 1000),
    }),
    /outside the accepted window/,
  );

  assert.equal(
    (
      await verifyTikTokWebhook({
        secret,
        headers: tiktokHeaders(signedAt),
        body: tiktokBody,
        now: () => new Date((signedAt + 3000) * 1000),
        toleranceSeconds: 3600,
      })
    ).valid,
    true,
  );

  await rejects(
    verifyTikTokWebhook({ secret, headers: tiktokHeaders(signedAt), body: json({}), now }),
    "unauthorized",
  );
  await rejects(
    verifyTikTokWebhook({
      secret,
      headers: tiktokHeaders(signedAt, tiktokBody, "other-secret"),
      body: tiktokBody,
      now,
    }),
    "unauthorized",
  );
  await rejects(
    verifyTikTokWebhook({ secret, headers: new Headers(), body: tiktokBody, now }),
    "unauthorized",
  );

  const header = tiktokHeaders(signedAt).get("TikTok-Signature") ?? "";
  await rejects(
    verifyTikTokWebhook({
      secret,
      headers: new Headers({ "TikTok-Signature": `${header},t=${signedAt + 1}` }),
      body: tiktokBody,
      now,
    }),
    "unauthorized",
  );
  await rejects(
    verifyTikTokWebhook({
      secret,
      headers: tiktokHeaders(signedAt),
      body: tiktokBody,
      now,
      toleranceSeconds: 0,
    }),
    "invalid_config",
  );
});

it("decodes Instagram deliveries and keeps batches as one event", async () => {
  const event = await decodePlatformWebhook({
    platform: "instagram",
    backend: "direct",
    body: instagramBody,
    receivedAt: "2026-09-24T00:00:00.000Z",
  });

  assert.equal(event.provider, "instagram");
  assert.equal(event.type, "comment.received");
  assert.equal(event.identity, "body-digest");
  assert.equal(event.id, createHash("sha256").update(instagramBody).digest("hex"));
  assert.deepEqual(event.accountIds, ["ig-account-1"]);

  const again = await decodePlatformWebhook({
    platform: "instagram",
    backend: "direct",
    body: instagramBody,
  });

  assert.equal(again.id, event.id);

  const batch = await decodePlatformWebhook({
    platform: "instagram",
    backend: "direct",
    body: json({
      object: "instagram",
      entry: [
        {
          id: "ig-1",
          time: 1,
          messaging: [{ sender: { id: "s" }, message: { mid: "m1", text: "hi" } }],
        },
        {
          id: "ig-2",
          time: 1,
          messaging: [{ sender: { id: "s" }, message: { mid: "m2", is_echo: true } }],
        },
      ],
    }),
  });

  assert.equal(batch.type, "unknown");
  assert.equal(batch.originalType, "messages,message_echoes");
  assert.deepEqual(batch.accountIds, ["ig-1", "ig-2"]);

  await rejects(
    decodePlatformWebhook({
      platform: "instagram",
      backend: "direct",
      body: json({ object: "page", entry: [] }),
    }),
    "invalid_input",
    "webhooks.decode",
  );
});

it("decodes Threads deliveries by field", async () => {
  const reply = await decodePlatformWebhook({
    platform: "threads",
    backend: "direct",
    body: json({
      app_id: "app-1",
      topic: "moderate",
      target_id: "reply-1",
      time: 1_790_000_000,
      values: {
        field: "replies",
        value: { id: "reply-1", root_post: { id: "post-1", owner_id: "threads-user-1" } },
      },
    }),
  });

  assert.equal(reply.type, "comment.received");
  assert.deepEqual(reply.accountIds, ["threads-user-1"]);

  const removed = await decodePlatformWebhook({
    platform: "threads",
    backend: "direct",
    body: json({
      app_id: "app-1",
      topic: "moderate",
      target_id: "post-1",
      time: 1,
      values: { field: "delete", value: { id: "post-1", owner: { owner_id: "threads-user-2" } } },
    }),
  });

  assert.equal(removed.type, "post.removed");
  assert.deepEqual(removed.accountIds, ["threads-user-2"]);

  const publish = await decodePlatformWebhook({
    platform: "threads",
    backend: "direct",
    body: json({
      app_id: "app-1",
      topic: "interaction",
      time: 1,
      values: { field: "publish", value: { id: "p" } },
    }),
  });

  assert.equal(publish.type, "unknown");
  assert.deepEqual(publish.accountIds, []);
});

it("decodes X Account Activity deliveries and redacts secret-like fields", async () => {
  const dm = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: json({
      for_user_id: "2244994945",
      direct_message_events: [{ id: "dm-1", type: "message_create" }],
      access_token: "fixture-private-token",
    }),
  });

  assert.equal(dm.type, "message.received");
  assert.equal(dm.originalType, "direct_message_events");
  assert.deepEqual(dm.accountIds, ["2244994945"]);
  assert.equal(dm.data["access_token"], "[redacted]");
  assert.doesNotMatch(JSON.stringify(dm), /fixture-private-token/);

  const revoke = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: json({
      user_event: {
        revoke: {
          date_time: "2026-09-24T00:00:00Z",
          target: { app_id: "1" },
          source: { user_id: "user-9" },
        },
      },
    }),
  });

  assert.equal(revoke.type, "account.updated");
  assert.deepEqual(revoke.accountIds, ["user-9"]);

  const deleted = await decodePlatformWebhook({
    platform: "x",
    backend: "direct",
    body: json({ for_user_id: "1", tweet_delete_events: [{ status: { id: "t1", user_id: "1" } }] }),
  });

  assert.equal(deleted.type, "post.removed");
});

it("decodes YouTube Atom feeds and tombstones without expanding declarations", async () => {
  const feed = await decodePlatformWebhook({
    platform: "youtube",
    backend: "direct",
    body: encode(youtubeFeed),
  });

  assert.equal(feed.type, "unknown");
  assert.equal(feed.originalType, "yt:video");
  assert.deepEqual(feed.accountIds, ["UC_FIXTURE_CHANNEL"]);
  assert.deepEqual(feed.data, {
    videos: [
      {
        videoId: "VIDEO_ID_01",
        channelId: "UC_FIXTURE_CHANNEL",
        title: "Fixture & video",
        published: "2026-09-24T10:00:00+00:00",
        updated: "2026-09-24T10:05:00+00:00",
      },
    ],
    deleted: [],
  });

  const tombstone = await decodePlatformWebhook({
    platform: "youtube",
    backend: "direct",
    body: encode(`<feed xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">
  <at:deleted-entry ref="yt:video:VIDEO_ID_02" when="2026-09-24T11:00:00+00:00">
    <link href="https://www.youtube.com/watch?v=VIDEO_ID_02"/>
    <at:by><name>Fixture</name><uri>https://www.youtube.com/channel/UC_FIXTURE_CHANNEL</uri></at:by>
  </at:deleted-entry>
</feed>`),
  });

  assert.equal(tombstone.type, "post.removed");
  assert.deepEqual(tombstone.accountIds, ["UC_FIXTURE_CHANNEL"]);

  for (const body of [
    `<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY x "y">]><feed><entry></entry></feed>`,
    "<feed></feed>",
    "not xml",
  ])
    await rejects(
      decodePlatformWebhook({ platform: "youtube", backend: "direct", body: encode(body) }),
      "invalid_input",
    );
});

it("decodes TikTok events with the publish ID and creation time", async () => {
  const event = await decodePlatformWebhook({
    platform: "tiktok",
    backend: "direct",
    body: tiktokBody,
  });

  assert.equal(event.type, "publication.updated");
  assert.equal(event.originalType, "post.publish.complete");
  assert.equal(event.backendRecordId, "v_pub_fixture_1");
  assert.equal(event.occurredAt, new Date(1_790_000_000 * 1000).toISOString());
  assert.deepEqual(event.accountIds, ["open-id-1"]);
  assert.deepEqual(event.data["content"], {
    publish_id: "v_pub_fixture_1",
    publish_type: "DIRECT_PUBLISH",
  });

  const revoked = await decodePlatformWebhook({
    platform: "tiktok",
    backend: "direct",
    body: json({
      client_key: "k",
      event: "authorization.removed",
      create_time: 1,
      user_openid: "open-id-2",
      content: '{"reason":1}',
    }),
  });

  assert.equal(revoked.type, "account.updated");
  assert.equal(revoked.backendRecordId, undefined);

  await rejects(
    decodePlatformWebhook({
      platform: "tiktok",
      backend: "direct",
      body: json({ create_time: 1 }),
    }),
    "invalid_input",
  );
});

it("wires webhook verification into each direct adapter", async () => {
  const noFetch = async (): Promise<Response> => {
    throw new Error("webhook handling must not call the network");
  };

  const clock = () => new Date(1_790_000_100_000);

  const cases = [
    {
      adapter: instagram({
        auth: { accountId: "ig1", accessToken: "token" },
        fetch: noFetch,
        webhookSecret: secret,
      }),
      headers: new Headers({
        "X-Hub-Signature-256": `sha256=${hmac("sha256", instagramBody).digest("hex")}`,
      }),
      body: instagramBody,
      provider: "instagram",
    },
    {
      adapter: x({
        auth: { userId: "u1", accessToken: "token" },
        fetch: noFetch,
        webhookSecret: secret,
      }),
      headers: new Headers({
        "X-Twitter-Webhooks-Signature": `sha256=${hmac("sha256", json({ for_user_id: "u1", favorite_events: [] })).digest("base64")}`,
      }),
      body: json({ for_user_id: "u1", favorite_events: [] }),
      provider: "x",
    },
    {
      adapter: youtube({
        auth: { accessToken: "jwt", channelId: "ch" },
        fetch: noFetch,
        webhookSecret: secret,
      }),
      headers: new Headers({
        "X-Hub-Signature": `sha1=${hmac("sha1", encode(youtubeFeed)).digest("hex")}`,
      }),
      body: encode(youtubeFeed),
      provider: "youtube",
    },
    {
      adapter: tiktok({
        auth: { accessToken: "test", openId: "creator1" },
        verifiedMediaOrigins: ["https://media.example.test"],
        fetch: noFetch,
        clock,
        webhookSecret: secret,
      }),
      headers: tiktokHeaders(1_790_000_100),
      body: tiktokBody,
      provider: "tiktok",
    },
  ];

  const threadsBody = json({
    app_id: "a",
    time: 1,
    values: { field: "publish", value: { id: "p" } },
  });

  cases.push({
    adapter: threads({
      auth: { userId: "u1", accessToken: "token" },
      fetch: noFetch,
      webhookSecret: secret,
    }),
    headers: new Headers({
      "X-Hub-Signature-256": `sha256=${hmac("sha256", threadsBody).digest("hex")}`,
    }),
    body: threadsBody,
    provider: "threads",
  });

  for (const { adapter, headers, body, provider } of cases) {
    assert.ok(
      adapter.capabilities.capabilities.some(
        (entry) => entry.operation === "webhooks.verify" && entry.availability === "available",
      ),
      provider,
    );

    const webhooks = adapter.webhooks;
    assert.ok(webhooks, provider);
    assert.deepEqual(await webhooks.verify({ headers, body }, context), {
      valid: true,
      method: "hmac",
    });

    const event = await webhooks.decode({ headers, body }, context);
    assert.equal(event["provider"], provider);
    assert.equal(event["backend"], "direct");

    await rejects(webhooks.verify({ headers: new Headers(), body }, context), "unauthorized");
  }

  const unconfigured = x({ auth: { userId: "u1", accessToken: "token" }, fetch: noFetch });
  await rejects(
    unconfigured.webhooks!.verify({ headers: cases[1]!.headers, body: cases[1]!.body }, context),
    "unauthorized",
  );
});
