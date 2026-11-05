import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError } from "../src/core/errors.js";
import { decodeOutcome } from "../src/core/persisted-codec.js";
import type { DeliveryOutcome } from "../src/core/types.js";
import {
  revokeGoogleOAuthToken,
  revokeTikTokOAuthToken,
  revokeXOAuthToken,
} from "../src/server/oauth.js";
import {
  createKeyValueIdempotencyStore,
  MemoryKeyValueStore,
} from "../src/server/schedule-store.js";
import { isJsonValue } from "../src/transport/json.js";
import { upload } from "../src/transport/upload.js";

const account = {
  kind: "connected-account",
  version: 1,
  backend: "default",
  platform: "instagram",
  accountId: "fixture-account",
} as const;

const published: DeliveryOutcome = {
  state: "published",
  targetIndex: 0,
  account,
  observedAt: "2026-11-05T00:00:00.000Z",
  post: { ...account, kind: "platform-post", postId: "fixture-post" },
  issues: [
    { code: "caption.dropped", severity: "warning", message: "The caption did not attach." },
  ],
};

it("published warnings survive the stored outcome codec", () => {
  const stored: unknown = JSON.parse(JSON.stringify(published));
  assert.ok(isJsonValue(stored));

  assert.deepEqual(decodeOutcome(stored, "outcome"), published);
});

it("published warnings survive key-value idempotency replay", async () => {
  const store = createKeyValueIdempotencyStore(new MemoryKeyValueStore());

  const input = {
    scope: "fixture-tenant",
    key: "fixture-key",
    fingerprint: "fixture-hash",
    targetKeys: ["fixture-target"],
  };

  const claim = await store.claim(input);
  assert.equal(claim.kind, "new");

  if (claim.kind !== "new") return;

  await store.saveOutcome({
    claimId: claim.claimId,
    targetKey: "fixture-target",
    outcome: published,
  });
  const replay = await store.claim(input);
  assert.equal(replay.kind, "existing");

  if (replay.kind !== "existing") return;
  assert.deepEqual(replay.outcomes["fixture-target"], published);
});

const revocations: readonly [string, (fetch: typeof globalThis.fetch) => Promise<"revoked">][] = [
  [
    "TikTok",
    (fetch) =>
      revokeTikTokOAuthToken(
        { clientId: "fixture-client", clientSecret: "fixture-secret", fetch },
        { accessToken: "fixture-token" },
      ),
  ],
  ["Google", (fetch) => revokeGoogleOAuthToken({ fetch }, { token: "fixture-token" })],
  [
    "X",
    (fetch) => revokeXOAuthToken({ clientId: "fixture-client", fetch }, { token: "fixture-token" }),
  ],
];

for (const [provider, revoke] of revocations) {
  it(`${provider} revocation with a lost response is an uncertain outcome`, async () => {
    let sent = 0;

    const fetch: typeof globalThis.fetch = async () => {
      sent += 1;
      throw new TypeError("fixture connection lost");
    };

    await assert.rejects(
      revoke(fetch),
      (error: SocialError) =>
        error instanceof SocialError &&
        error.code === "ambiguous_outcome" &&
        error.retryDisposition?.kind === "reconcile-first",
    );
    assert.equal(sent, 1);
  });
}

it("revocation rejected by the provider stays a definite failure", async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({ error: "invalid_token" }, { status: 400 });

  await assert.rejects(
    revokeGoogleOAuthToken({ fetch }, { token: "fixture-token" }),
    (error: SocialError) => error instanceof SocialError && error.code !== "ambiguous_outcome",
  );
});

const pngSource = {
  mimeType: "image/png",
  body: new Blob(["x"]),
  open(): never {
    throw new Error("unexpected open");
  },
};

it("extra upload headers cannot replace the source content type", async () => {
  let sent = new Headers();

  await upload({
    url: "https://media.example.test/upload",
    allowHost: () => true,
    maxBytes: 10,
    headers: { "content-type": "text/plain" },
    source: { ...pngSource, size: 1 },
    fetch: async (_url, init) => {
      sent = new Headers(init?.headers);

      return new Response(null, { status: 200 });
    },
  });

  assert.equal(sent.get("content-type"), "image/png");
});

it("extra upload headers cannot set an unverified content length", async () => {
  let sent = new Headers();

  await upload({
    url: "https://media.example.test/upload",
    allowHost: () => true,
    maxBytes: 10,
    headers: { "Content-Length": "99" },
    source: pngSource,
    fetch: async (_url, init) => {
      sent = new Headers(init?.headers);

      return new Response(null, { status: 200 });
    },
  });

  assert.notEqual(sent.get("content-length"), "99");
});
