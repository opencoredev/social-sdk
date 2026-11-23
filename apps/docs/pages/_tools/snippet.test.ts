import assert from "node:assert/strict";
import { test } from "node:test";

import { platformIds } from "./platforms";
import { FACEBOOK_SUBPATH_NOTE, npmPlatformIds, socialSnippet } from "./snippet";

test("imports only the selected adapters, in a stable order", () => {
  const code = socialSnippet(["threads", "x"], "Hi");

  assert.ok(
    code.indexOf('from "@opencoredev/social-sdk/x"') <
      code.indexOf('from "@opencoredev/social-sdk/threads"'),
  );
  assert.ok(!code.includes("/bluesky"));
  assert.ok(!code.includes("MediaAttachment"));
});

test("adds media for platforms that need it", () => {
  const code = socialSnippet(["youtube", "instagram"], "Hi");

  assert.ok(code.includes("uploadedVideo"));
  assert.ok(code.includes("hostedVideo"));
  assert.ok(code.includes("madeForKids: false"));
});

test("notes that the Facebook subpath isn't on npm yet", () => {
  assert.ok(socialSnippet(["facebook"], "Hi").includes(FACEBOOK_SUBPATH_NOTE));
  assert.ok(!socialSnippet(["x"], "Hi").includes(FACEBOOK_SUBPATH_NOTE));
});

test("embeds the post text as a string literal", () => {
  assert.ok(socialSnippet(["x"], 'Say "hi"\n`now`').includes('text: "Say \\"hi\\"\\n`now`"'));
});

test("prepares before it publishes", () => {
  const code = socialSnippet(platformIds, "Hi");

  assert.ok(
    code.indexOf("social.posts.prepare(request)") < code.indexOf("social.posts.publish(request)"),
  );
});

test("asks for a platform when none is selected", () => {
  assert.match(socialSnippet([], "Hi"), /Pick at least one platform/);
});

test("the default platforms are the ones npm 0.5.0 ships, without Facebook", () => {
  assert.deepEqual(
    [...npmPlatformIds],
    platformIds.filter((id) => id !== "facebook"),
  );
  assert.ok(!socialSnippet(npmPlatformIds, "Hi").includes("facebook"));
});

test("preserves selected image and carousel media in the generated snippet", () => {
  const threadsImage = socialSnippet(["threads"], "", { kind: "image" });

  assert.ok(threadsImage.includes("hostedImage"));
  assert.ok(threadsImage.includes("content: { media: [hostedImage] }"));
  assert.ok(threadsImage.includes('content: { text: "" },'));

  const carousel = socialSnippet(["x", "threads"], "Gallery", { kind: "carousel", count: 4 });

  assert.ok(carousel.includes("uploadedImages"));
  assert.ok(carousel.includes("hostedImages"));
  assert.ok(carousel.includes("length: 4"));
});

test("notes that TikTok inbox drafts transfer the video without the caption", () => {
  const code = socialSnippet(["tiktok"], "Hi", { kind: "video", seconds: 15 });

  assert.ok(code.includes("add the caption in TikTok"));
  assert.ok(code.includes("durationSeconds: 15"));
});

test("includes width and height on uploaded images so 5-10 image Bluesky galleries prepare cleanly", () => {
  const gallery = socialSnippet(["bluesky"], "Gallery", { kind: "carousel", count: 6 });

  assert.ok(gallery.includes("width: 1200"));
  assert.ok(gallery.includes("height: 675"));
  assert.ok(gallery.includes("length: 6"));
});

test("uses draft inbox options with photoCoverIndex for TikTok photo posts", () => {
  const photo = socialSnippet(["tiktok"], "Launch photos", { kind: "carousel", count: 3 });

  assert.ok(photo.includes("draft: true"));
  assert.ok(photo.includes("photoCoverIndex: 0"));
  assert.ok(photo.includes("hostedImages"));
});

test("uploads Bluesky videos and LinkedIn media by reference", () => {
  const video = socialSnippet(["bluesky", "linkedin"], "Demo", { kind: "video", seconds: 25 });

  assert.ok(video.includes("social.media.upload(uploadedVideo, blueskyAccount)"));
  assert.ok(video.includes("blueskyNative.getVideoJobStatus"));
  assert.ok(video.includes('source: { kind: "media-ref", ref: blueskyVideoRef }'));
  assert.ok(video.includes("social.media.upload(uploadedVideo, linkedinAccount)"));
  assert.ok(video.includes("linkedinNative.waitForVideo"));
  assert.ok(video.includes('linkedinStatus["status"] !== "AVAILABLE"'));
  assert.ok(video.includes('source: { kind: "media-ref", ref: linkedinVideoRef }'));

  const liCarousel = socialSnippet(["linkedin"], "Slides", { kind: "carousel", count: 3 });

  assert.ok(liCarousel.includes("social.media.upload(item, linkedinAccount)"));
  assert.ok(liCarousel.includes("content: { media: linkedinImages }"));
});
