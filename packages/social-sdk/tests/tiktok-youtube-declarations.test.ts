import assert from "node:assert/strict";
import { it } from "node:test";
import type { CapabilityDeclaration } from "../src/core/types.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { youtube } from "../src/platforms/youtube.js";

const noNetwork: typeof globalThis.fetch = async () => {
  throw new Error("declarations make no requests");
};

function declaration(
  declarations: readonly CapabilityDeclaration[],
  operation: string,
): CapabilityDeclaration | undefined {
  return declarations.find((entry) => entry.operation === operation);
}

it("TikTok declares video.upload, video.list and user.info.stats where each is needed [feature:tiktok.auth.scope.video_upload_list_stats]", () => {
  const { capabilities } = tiktok({
    auth: { accessToken: "test", openId: "creator1" },
    verifiedMediaOrigins: ["https://media.example.test"],
    fetch: noNetwork,
  }).capabilities;

  assert.deepEqual(declaration(capabilities, "posts.draft")?.requiredScopes, ["video.upload"]);
  assert.deepEqual(declaration(capabilities, "posts.list")?.requiredScopes, ["video.list"]);
  assert.deepEqual(declaration(capabilities, "analytics.account.read")?.requiredScopes, [
    "user.info.stats",
  ]);
});

it("YouTube no longer warns that unverified API projects upload privately [feature:youtube.publish.unverified_project_privacy]", () => {
  const { capabilities } = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: noNetwork,
  }).capabilities;

  const notes = declaration(capabilities, "posts.publish")?.notes ?? "";

  assert.match(notes, /no longer forces uploads from unverified API projects to private/);
  assert.doesNotMatch(notes, /restricted to private visibility/);
});

it("YouTube Analytics reads declare youtube.readonly alongside yt-analytics.readonly [feature:youtube.analytics.reports.query]", () => {
  const { capabilities } = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: noNetwork,
  }).capabilities;

  // reports.query and groupItems.list need youtube.readonly as well (Google revision history, 2018-06-18).
  const analyticsAndDataRead = [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.readonly",
  ];

  assert.deepEqual(
    declaration(capabilities, "analytics.report.read")?.requiredScopes,
    analyticsAndDataRead,
  );
  assert.deepEqual(
    declaration(capabilities, "analytics.youtube.read")?.requiredScopes,
    analyticsAndDataRead,
  );
  assert.deepEqual(
    declaration(capabilities, "analytics.groups")?.requiredScopes,
    analyticsAndDataRead,
  );
  // The Reporting API accepts yt-analytics.readonly alone.
  assert.deepEqual(declaration(capabilities, "analytics.reporting.bulk")?.requiredScopes, [
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ]);
});
