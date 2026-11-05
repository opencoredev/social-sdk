import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedAccountRef, type AdapterOperationContext } from "../src/core/index.js";
import { instagram } from "../src/platforms/instagram.js";

const account = connectedAccountRef({
  backend: "instagram",
  platform: "instagram",
  accountId: "123",
});

const context: AdapterOperationContext = {
  backendInstance: "instagram",
  correlationId: "review-meta-audio",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

// Meta's search example uses `audio`, not Graph's usual `data` envelope.
// https://developers.facebook.com/documentation/instagram-platform/content-publishing/audio-api.md
test("Instagram searchAudio returns assets from Meta's documented audio envelope", async () => {
  const asset = {
    audio_id: "587784541076604",
    title: "Birthday Wish",
    audio_type: "music",
    display_artist: "Shuba",
    duration_in_ms: 153760,
  };

  const calls: URL[] = [];

  const adapter = instagram({
    auth: { accountId: "123", accessToken: "offline-fixture", flavor: "facebook-login" },
    fetch: async (input) => {
      calls.push(new URL(String(input)));

      return Response.json({ audio: [asset] });
    },
  });

  assert.ok(adapter.native);
  const operation = adapter.native.searchAudio({ account, audioType: "music", context });
  await assert.doesNotReject(operation, "Meta's documented audio envelope must be accepted");
  const result = await operation;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.pathname, "/v27.0/ig_audio");
  assert.deepEqual(result.items, [asset]);
});

// Meta's single-asset response spells the cover field `..._url`, whereas search uses `..._uri`.
test("Instagram getAudio retains cover_artwork_thumbnail_url from the documented metadata response", async () => {
  const adapter = instagram({
    auth: { accountId: "123", accessToken: "offline-fixture", flavor: "facebook-login" },
    fetch: async () =>
      Response.json({
        audio_id: "587784541076604",
        title: "Birthday Wish",
        audio_type: "music",
        cover_artwork_thumbnail_url: "https://cdn.example.com/audio-cover.jpg",
      }),
  });

  assert.ok(adapter.native);
  const result = await adapter.native.getAudio({ account, audioId: "587784541076604", context });
  assert.equal(result["audio_id"], "587784541076604");
  assert.equal(result["cover_artwork_thumbnail_url"], "https://cdn.example.com/audio-cover.jpg");
});
