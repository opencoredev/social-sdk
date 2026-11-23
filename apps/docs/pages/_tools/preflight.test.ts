import assert from "node:assert/strict";
import { test } from "node:test";

import { isValidXText } from "../../../../packages/social-sdk/src/platforms/x-text.ts";

import { platformIds } from "./platforms";
import { checkPlatform, preflight, type MediaPlan } from "./preflight";
import { renderResults, summary } from "./preflight-view";

const none: MediaPlan = { kind: "none" };

const verdict = (...args: Parameters<typeof checkPlatform>) => checkPlatform(...args).verdict;

test("passes short text on text platforms", () => {
  for (const platform of ["x", "bluesky", "threads", "linkedin", "facebook"] as const)
    assert.equal(verdict(platform, "Hello", none), "pass", platform);
});

test("fails text-only posts where media is required", () => {
  assert.equal(verdict("instagram", "Hello", none), "fail");
  assert.equal(verdict("tiktok", "Hello", none), "fail");
  assert.match(
    checkPlatform("youtube", "Hello", none).checks.at(-1)?.detail ?? "",
    /exactly one video/,
  );
});

test("fails an empty post", () => {
  assert.equal(verdict("x", "   ", none), "fail");
});

test("applies each platform's text limit in its own unit", () => {
  assert.equal(verdict("x", "a".repeat(280), none), "pass");
  assert.equal(verdict("x", "a".repeat(281), none), "fail");
  assert.equal(
    verdict("x", `${"a".repeat(256)} https://example.com/${"b".repeat(200)}`, none),
    "pass",
  );
  assert.equal(verdict("bluesky", "👨‍👩‍👧".repeat(300), none), "fail", "300 graphemes but 5,400 bytes");
  assert.equal(verdict("bluesky", "a".repeat(300), none), "pass");
  assert.equal(verdict("threads", "😀".repeat(125), none), "pass");
  assert.equal(verdict("threads", "😀".repeat(126), none), "fail");
  assert.equal(verdict("linkedin", "a".repeat(3001), none), "fail");
});

test("reports the text meter with the platform's unit", () => {
  assert.deepEqual(checkPlatform("x", "hi https://a.co", none).meter, {
    used: 26,
    limit: 280,
    unit: "weighted characters",
  });
  assert.deepEqual(checkPlatform("facebook", "hi", none).meter, {
    used: 2,
    limit: 63206,
    unit: "characters",
  });
  assert.equal(verdict("facebook", "a".repeat(63206), none), "pass");
  assert.equal(verdict("facebook", "a".repeat(63207), none), "fail");
});

test("uses TikTok's longer limit for photo posts", () => {
  const text = "a".repeat(3000);

  assert.equal(verdict("tiktok", text, { kind: "video" }), "fail");
  assert.equal(verdict("tiktok", text, { kind: "carousel", count: 3 }), "pass");
});

test("checks Instagram hashtag and @ tag caps", () => {
  const tags = Array.from({ length: 31 }, (_, index) => `#tag${index}`).join(" ");

  assert.equal(verdict("instagram", tags, { kind: "image" }), "fail");
});

test("checks carousel counts", () => {
  assert.equal(verdict("x", "", { kind: "carousel", count: 4 }), "pass");
  assert.equal(verdict("x", "", { kind: "carousel", count: 5 }), "fail");
  assert.equal(verdict("bluesky", "", { kind: "carousel", count: 6 }), "warn");
  assert.equal(verdict("bluesky", "", { kind: "carousel", count: 11 }), "fail");
  assert.equal(verdict("instagram", "", { kind: "carousel", count: 20 }), "pass");
  assert.equal(verdict("tiktok", "", { kind: "carousel", count: 35 }), "pass");
  assert.equal(verdict("facebook", "", { kind: "carousel", count: 11 }), "fail");
  assert.equal(verdict("youtube", "", { kind: "carousel", count: 2 }), "fail");
});

test("checks image and video sizes in MB", () => {
  assert.equal(verdict("x", "", { kind: "image", sizeMb: 5 }), "pass");
  assert.equal(verdict("x", "", { kind: "image", sizeMb: 5.3 }), "fail", "over 5 MiB");
  assert.equal(verdict("bluesky", "", { kind: "image", sizeMb: 2.1 }), "fail");
  assert.equal(verdict("instagram", "", { kind: "video", sizeMb: 301 }), "fail");
  assert.equal(verdict("linkedin", "", { kind: "video", sizeMb: 0.05 }), "fail", "under 75 KB");
});

test("checks video length", () => {
  assert.equal(verdict("threads", "", { kind: "video", seconds: 300 }), "pass");
  assert.equal(verdict("threads", "", { kind: "video", seconds: 301 }), "fail");
  assert.equal(verdict("instagram", "", { kind: "video", seconds: 2 }), "fail");
  assert.equal(verdict("tiktok", "", { kind: "video", seconds: 601 }), "fail");
  assert.equal(verdict("youtube", "", { kind: "video", seconds: 1200 }), "warn");
  assert.equal(verdict("youtube", "", { kind: "video", seconds: 50_000 }), "fail");
  assert.equal(verdict("x", "", { kind: "video", seconds: 7200 }), "pass", "X checks per account");
  assert.ok(
    checkPlatform("x", "", { kind: "video" }).notes.some((note) =>
      note.includes("depends on the account"),
    ),
  );
});

test("checks every platform in a stable order and summarises the verdicts", () => {
  const results = preflight("Hello", platformIds, none);

  assert.deepEqual(
    results.map((result) => result.platform),
    [...platformIds],
  );
  assert.equal(summary(results), "5 fit, 3 over a limit.");
  assert.equal(summary([]), "Pick at least one platform.");
});

test("escapes post-derived text in the results markup", () => {
  const html = renderResults(preflight("<script>alert(1)</script>", ["x"], none));

  assert.ok(!html.includes("<script>"));
});

test("rejects angle brackets in a YouTube description, as the SDK does", () => {
  const video: MediaPlan = { kind: "video", seconds: 60 };

  const result = checkPlatform("youtube", "1 < 2", video);

  assert.equal(result.verdict, "fail");
  assert.ok(
    result.checks.some((check) => check.verdict === "fail" && /angle brackets/.test(check.detail)),
  );
  assert.equal(verdict("youtube", "1 is less than 2", video), "pass");
});

test("rejects a TikTok video without a length above 0 s, as the SDK does", () => {
  assert.equal(verdict("tiktok", "Hi", { kind: "video", seconds: 0 }), "fail");
  assert.equal(verdict("tiktok", "Hi", { kind: "video" }), "warn", "the length is unknown");
  assert.equal(verdict("tiktok", "Hi", { kind: "video", seconds: 30 }), "pass");
});

test("counts X links on every TLD the SDK knows", () => {
  assert.equal(verdict("x", `${"a".repeat(260)} example.education`, none), "fail");
  assert.equal(verdict("x", `${"a".repeat(255)} example.education`, none), "pass");
});

test("agrees with the SDK's isValidXText on text-only X posts", () => {
  const samples = [
    "a".repeat(280),
    "a".repeat(281),
    `${"a".repeat(260)} example.education`,
    `${"a".repeat(255)} example.education`,
    `${"日".repeat(140)}`,
    `${"日".repeat(141)}`,
    `${"🚀".repeat(140)}`,
    `${"a".repeat(250)} https://example.com/${"b".repeat(300)}`,
    `${"a".repeat(270)} notes.txt`,
    `${"a".repeat(270)} me@example.com`,
  ];

  for (const text of samples)
    assert.equal(verdict("x", text, none) === "pass", isValidXText(text), text.slice(-30));
});

test("rejects X text with Unicode non-characters that the SDK rejects", () => {
  const result = checkPlatform("x", "Hi\uFFFE", none);
  assert.equal(result.verdict, "fail");
  assert.equal(
    result.checks.some((check) => check.verdict === "fail" && check.label === "Characters"),
    true,
  );
  assert.equal(isValidXText("Hi\uFFFE"), false);
});
