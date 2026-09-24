import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import type { SocialAdapter } from "../src/core/adapter.js";
import type { PreparedPublishTarget } from "../src/core/types.js";
import { bluesky } from "../src/platforms/bluesky.js";
import { instagram } from "../src/platforms/instagram.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { threads } from "../src/platforms/threads.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { x } from "../src/platforms/x.js";

let calls = 0;

const offlineFetch = async (): Promise<Response> => {
  calls++;
  throw new Error("Scheduling checks must stay offline");
};

const image = {
  kind: "image" as const,
  source: { kind: "https-url" as const, url: "https://media.example.test/image.jpg" },
  mimeType: "image/jpeg",
  width: 1080,
  height: 1080,
};

const cases: readonly {
  readonly platform: string;
  readonly adapter: Pick<SocialAdapter<unknown>, "capabilities" | "posts">;
  readonly accountId: string;
  readonly availability: "unsupported-by-platform" | "not-implemented-by-adapter";
}[] = [
  {
    platform: "x",
    adapter: x({ auth: { userId: "u1", accessToken: "fixture" }, fetch: offlineFetch }),
    accountId: "u1",
    availability: "not-implemented-by-adapter",
  },
  {
    platform: "threads",
    adapter: threads({ auth: { userId: "u1", accessToken: "fixture" }, fetch: offlineFetch }),
    accountId: "u1",
    availability: "unsupported-by-platform",
  },
  {
    platform: "bluesky",
    adapter: bluesky({
      backend: "default",
      auth: { service: "https://bsky.example", did: "did:plc:test", accessJwt: "fixture" },
      fetch: offlineFetch,
    }),
    accountId: "did:plc:test",
    availability: "unsupported-by-platform",
  },
  {
    platform: "instagram",
    adapter: instagram({ auth: { accessToken: "fixture", accountId: "ig1" }, fetch: offlineFetch }),
    accountId: "ig1",
    availability: "unsupported-by-platform",
  },
  {
    platform: "tiktok",
    adapter: tiktok({
      auth: { accessToken: "fixture", openId: "creator1" },
      verifiedMediaOrigins: ["https://media.example.test"],
      fetch: offlineFetch,
    }),
    accountId: "creator1",
    availability: "unsupported-by-platform",
  },
  {
    platform: "linkedin",
    adapter: linkedin({
      auth: { accessToken: "fixture", author: "urn:li:person:member1" },
      apiVersion: "202609",
      fetch: offlineFetch,
    }),
    accountId: "urn:li:person:member1",
    availability: "unsupported-by-platform",
  },
];

for (const entry of cases) {
  it(`${entry.platform} declares posts.schedule as ${entry.availability} and rejects schedules offline`, () => {
    const declaration = entry.adapter.capabilities.capabilities.find(
      (candidate) =>
        candidate.operation === "posts.schedule" && candidate.platform === entry.platform,
    );

    assert.equal(declaration?.availability, entry.availability);
    assert.ok((declaration?.notes ?? "").length > 0);
    assert.equal(
      entry.adapter.capabilities.capabilities.some(
        (candidate) =>
          candidate.operation === "posts.cancelScheduled" && candidate.availability === "available",
      ),
      false,
    );
    assert.equal(entry.adapter.posts?.cancelScheduled, undefined);

    const account = connectedAccountRef({
      backend: entry.adapter.capabilities.backend,
      platform: entry.platform,
      accountId: entry.accountId,
    });

    const target: PreparedPublishTarget = {
      targetIndex: 0,
      targetKey: entry.platform,
      account,
      content: { text: "caption", media: [image] },
    };

    const before = calls;
    const immediate = entry.adapter.posts?.prepareTarget(target) ?? [];

    const scheduled =
      entry.adapter.posts?.prepareTarget({
        ...target,
        schedule: { at: "2030-01-01T00:00:00Z" },
      }) ?? [];

    const errors = (issues: typeof immediate) =>
      issues.filter((issue) => issue.severity === "error").length;

    assert.ok(errors(scheduled) > errors(immediate));
    assert.equal(calls, before);
  });
}
