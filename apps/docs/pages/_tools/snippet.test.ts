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
