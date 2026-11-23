import assert from "node:assert/strict";
import { test } from "node:test";

import { renderPlatformLimits, scopesHtml } from "./platform-limits";

test("leaves Facebook unchecked and out of the default snippet", () => {
  const html = renderPlatformLimits();

  assert.match(html, /<input type="checkbox" name="platforms" value="facebook" \/>/);
  assert.match(html, /<input type="checkbox" name="platforms" value="x" checked \/>/);

  const snippet = /<code[^>]*id="snippet"[^>]*>([\s\S]*?)<\/code>/.exec(html)?.[1] ?? "";

  assert.ok(snippet.includes("social-sdk/youtube"), "the snippet is found");
  assert.ok(!snippet.includes("facebook"));
});

test("breaks scope tokens only between their parts", () => {
  assert.equal(
    scopesHtml("instagram_business_basic, video.publish"),
    "instagram_<wbr>business_<wbr>basic, video.<wbr>publish",
  );
  assert.equal(scopesHtml("a <b>"), "a &lt;b&gt;");
});

test("cites a rate-limit source for X, Bluesky, and Instagram", () => {
  const html = renderPlatformLimits();

  for (const url of [
    "https://docs.x.com/x-api/fundamentals/rate-limits",
    "https://bsky.network/docs/rate-limits/",
    "https://developers.facebook.com/documentation/instagram-platform/content-publishing/",
    "https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login",
  ])
    assert.ok(html.includes(`href="${url}"`), url);
});
