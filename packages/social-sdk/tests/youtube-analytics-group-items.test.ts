import assert from "node:assert/strict";
import { it } from "node:test";
import { youtube } from "../src/platforms/youtube.js";
import type { AdapterOperationContext } from "../src/index.js";

const context = (): AdapterOperationContext => ({
  backendInstance: "default",
  correlationId: "review-youtube-group-items",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
});

// https://developers.google.com/youtube/analytics/reference/groupItems/insert#response
// An item already in the group produces HTTP 204, which is a successful insertion result.
it("accepts the documented 204 when an Analytics group already contains the item", async () => {
  const requests: { url: URL; method: string }[] = [];

  const adapter = youtube({
    auth: { accessToken: "offline-test-token", channelId: "channel1" },
    fetch: async (input, init) => {
      requests.push({ url: new URL(String(input)), method: init?.method ?? "GET" });

      return new Response(null, { status: 204 });
    },
  });

  const native = adapter.native;

  assert.ok(native);

  const result = await native.analyticsGroupItems({
    action: "insert",
    groupId: "group1",
    resource: { kind: "youtube#video", id: "video1" },
    context: context(),
  });

  assert.deepEqual(result, { alreadyInGroup: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.url.href, "https://youtubeanalytics.googleapis.com/v2/groupItems");
});
