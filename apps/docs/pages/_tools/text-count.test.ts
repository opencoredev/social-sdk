import assert from "node:assert/strict";
import { test } from "node:test";

import {
  graphemeCount,
  tagCounts,
  threadsLength,
  utf16Length,
  utf8Bytes,
  xWeightedLength,
} from "./text-count";

test("counts graphemes, so a joined emoji is one", () => {
  assert.equal(graphemeCount("hi 👨‍👩‍👧"), 4);
  assert.equal(graphemeCount("é"), 1);
});

test("counts UTF-8 bytes and UTF-16 length", () => {
  assert.equal(utf8Bytes("😀"), 4);
  assert.equal(utf16Length("😀"), 2);
});

test("counts Threads emoji by UTF-8 bytes, as the docs example says", () => {
  assert.equal(threadsLength("😀".repeat(125)), 500);
  assert.equal(threadsLength("😀".repeat(126)), 504);
  assert.equal(threadsLength("héllo"), 5);
});

test("weighs X text: Latin 1, CJK and emoji 2", () => {
  assert.deepEqual(xWeightedLength("hello"), { weighted: 5, urls: 0 });
  assert.equal(xWeightedLength("日本").weighted, 4);
  assert.equal(xWeightedLength("🚀").weighted, 2);
  assert.equal(xWeightedLength("👨‍👩‍👧").weighted, 2);
});

test("counts every URL as 23, with or without a protocol", () => {
  const long = `https://example.com/${"a".repeat(80)}`;

  assert.deepEqual(xWeightedLength(`Read ${long}`), { weighted: 5 + 23, urls: 1 });
  assert.deepEqual(xWeightedLength("Docs at social-sdk.dev/docs."), {
    weighted: 8 + 23 + 1,
    urls: 1,
  });
  assert.deepEqual(xWeightedLength("a https://a.co b http://b.io"), {
    weighted: 2 + 23 + 3 + 23,
    urls: 2,
  });
});

test("does not treat an email address or file name as a URL", () => {
  assert.equal(xWeightedLength("me@example.com").urls, 0);
  assert.equal(xWeightedLength("notes.txt").urls, 0);
});

test("counts hashtags and @ tags like the Instagram adapter", () => {
  assert.deepEqual(tagCounts("#one #two a#not @me @you.too email@x.com"), {
    hashtags: 2,
    mentions: 2,
  });
});

test("counts a bare link on any TLD X links, as the SDK does", () => {
  const text = `${"a".repeat(260)} example.education`;

  assert.deepEqual(xWeightedLength(text), { weighted: 260 + 1 + 23, urls: 1 });
  assert.equal(xWeightedLength("see example.education").urls, 1);
});
