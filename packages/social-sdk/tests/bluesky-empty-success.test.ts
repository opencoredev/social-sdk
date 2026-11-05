import { strict as assert } from "node:assert";
import { it } from "node:test";
import { bluesky } from "../src/platforms/bluesky.js";
import { connectedAccountRef } from "../src/core/index.js";

const did = "did:plc:review";

const account = connectedAccountRef({ backend: "default", platform: "bluesky", accountId: did });

const post = {
  uri: `at://${did}/app.bsky.feed.post/3kpost`,
  cid: "bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
};

function fixture() {
  const calls: string[] = [];

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch: async (input) => {
      calls.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
      // The official OpenAPI responses for these five procedures have no content.

      return new Response(null, { status: 200 });
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, calls };
}

it("createBookmark accepts the documented empty success response", async () => {
  const { native, calls } = fixture();
  await assert.doesNotReject(native.createBookmark({ account, post }));
  assert.deepEqual(calls, ["/xrpc/app.bsky.bookmark.createBookmark"]);
});

it("deleteBookmark accepts the documented empty success response", async () => {
  const { native, calls } = fixture();
  await assert.doesNotReject(native.deleteBookmark({ account, uri: post.uri }));
  assert.deepEqual(calls, ["/xrpc/app.bsky.bookmark.deleteBookmark"]);
});

it("muteThread accepts the documented empty success response", async () => {
  const { native, calls } = fixture();
  await assert.doesNotReject(native.muteThread({ account, rootUri: post.uri }));
  assert.deepEqual(calls, ["/xrpc/app.bsky.graph.muteThread"]);
});

it("unmuteThread accepts the documented empty success response", async () => {
  const { native, calls } = fixture();
  await assert.doesNotReject(native.unmuteThread({ account, rootUri: post.uri }));
  assert.deepEqual(calls, ["/xrpc/app.bsky.graph.unmuteThread"]);
});

it("putPreferences accepts the documented empty success response", async () => {
  const { native, calls } = fixture();
  await assert.doesNotReject(native.putPreferences({ account, preferences: [] }));
  assert.deepEqual(calls, ["/xrpc/app.bsky.actor.putPreferences"]);
});
