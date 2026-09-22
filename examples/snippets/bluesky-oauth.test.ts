/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/require-readable-spacing -- fixture intentionally models a minimal OAuth session boundary. */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { OAuthSession } from "@atproto/oauth-client-node";
import {
  createBlueskyOAuthFlow,
  mapBackedBlueskyStores,
  type BlueskyOAuthClientLike,
} from "./bluesky-oauth.js";

const session = { did: "did:plc:fixture" } as unknown as OAuthSession;

describe("Bluesky OAuth recipe boundaries", () => {
  it("preserves state through authorize/callback and restores by DID", async () => {
    let callbackParams = "";
    const client: BlueskyOAuthClientLike = {
      async authorize(handle, options) {
        assert.equal(handle, "alice.test");
        assert.equal(options.state, "app-attempt");
        return new URL("https://pds.example/authorize?state=provider-state");
      },
      async callback(params) {
        callbackParams = params.toString();
        return { session, state: "app-attempt" };
      },
      async restore(did) {
        assert.equal(did, session.did);
        return session;
      },
    };
    const flow = createBlueskyOAuthFlow(client);
    assert.equal(
      await flow.begin({ handle: "alice.test", state: "app-attempt" }),
      "https://pds.example/authorize?state=provider-state",
    );
    const completed = await flow.callback(
      "https://app.example/callback?code=one&state=provider-state",
    );
    assert.equal(callbackParams, "code=one&state=provider-state");
    assert.equal(completed.did, session.did);
    assert.equal(completed.state, "app-attempt");
    assert.equal((await flow.restore(session.did)).did, session.did);
  });

  it("rejects callback strings that are not absolute URLs", async () => {
    const client: BlueskyOAuthClientLike = {
      async authorize() {
        return new URL("https://pds.example/authorize");
      },
      async callback() {
        return { session, state: null };
      },
      async restore() {
        return session;
      },
    };
    await assert.rejects(createBlueskyOAuthFlow(client).callback("not-a-url"));
  });

  it("round-trips state and session rows through the injected store adapter", async () => {
    const rows = { states: new Map(), sessions: new Map() };
    const stores = mapBackedBlueskyStores(rows);
    const state = {
      iss: "https://pds.example",
      dpopJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" } as const,
      authMethod: { method: "none" as const },
      verifier: "fixture-verifier",
    };
    await stores.stateStore.set("attempt", state);
    assert.deepEqual(await stores.stateStore.get("attempt"), state);
    await stores.stateStore.del("attempt");
    assert.equal(await stores.stateStore.get("attempt"), undefined);
  });
});
