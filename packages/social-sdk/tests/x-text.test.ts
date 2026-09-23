import assert from "node:assert/strict";
import { it } from "node:test";
import { isValidXText } from "../src/platforms/x-text.js";

const fits = (text: string, padding: number) => isValidXText("a".repeat(padding) + text);

it("counts X text by weighted length", () => {
  assert.equal(isValidXText("a".repeat(280)), true);
  assert.equal(isValidXText("a".repeat(281)), false);
  assert.equal(isValidXText("界".repeat(140)), true);
  assert.equal(isValidXText("界".repeat(141)), false);
  assert.equal(isValidXText("\u2019".repeat(280)), true);
  assert.equal(isValidXText("©".repeat(280)), true);
  assert.equal(isValidXText("e\u0301".repeat(280)), true);
});

it("counts each X emoji as two characters", () => {
  for (const emoji of ["😀", "👍🏽", "🇺🇸", "1️⃣", "❤️", "🏳️‍🌈", "👨‍👩‍👧‍👦"]) {
    assert.equal(isValidXText(emoji.repeat(140)), true, emoji);
    assert.equal(isValidXText(emoji.repeat(141)), false, emoji);
  }
});

it("counts each X link as 23 characters", () => {
  for (const link of [
    "https://example.com/" + "a".repeat(300),
    "http://x.co",
    "example.com",
    "sub.example.co.uk/path/",
    "https://en.wikipedia.org/wiki/Primer_(film)",
    "https://example.com/p?q=1&r=2",
  ]) {
    assert.equal(fits(" " + link, 256), true, link);
    assert.equal(fits(" " + link, 257), false, link);
  }
});

it("counts internationalized X links and leaves overlong ones as text", () => {
  for (const link of ["https://example.com/путь", "https://пример.рф", "http://müller.de/x"]) {
    assert.equal(fits(" " + link, 256), true, link);
    assert.equal(fits(" " + link, 257), false, link);
  }

  // Twitter-text counts the protocol twice, so this link is 4,096 characters long by its rules.
  const longest = "https://example.com/" + "a".repeat(4068);

  assert.equal(fits(" " + longest, 256), true);
  assert.equal(isValidXText(longest + "a"), false);
});

it("checks long X text without backtracking", () => {
  const started = performance.now();

  for (const text of ["a.".repeat(12_000), "界".repeat(25_000), "https://" + "a.".repeat(12_000)])
    assert.equal(isValidXText(text), false);

  assert.ok(performance.now() - started < 2_000);
});

it("leaves trailing punctuation and non-links as text", () => {
  assert.equal(fits(" example.com.", 255), true);
  assert.equal(fits(" example.com.", 256), false);
  assert.equal(fits(" (example.org)", 254), true);
  assert.equal(fits(" (example.org)", 255), false);
  assert.equal(fits(" https://t.co/abc/def", 252), true);
  assert.equal(fits(" https://t.co/abc/def", 253), false);

  for (const text of [" file.nope", " v1.2.3", " e.g.", " user@mail.com"]) {
    assert.equal(fits(text, 280 - text.length), true, text);
    assert.equal(fits(text, 281 - text.length), false, text);
  }
});

it("rejects empty X text and invalid characters", () => {
  assert.equal(isValidXText(""), false);
  assert.equal(isValidXText(" "), true);

  for (const character of ["\uFFFE", "\uFEFF", "\uFFFF"])
    assert.equal(isValidXText(`hello${character}`), false);

  // Directional markers are allowed and end a link host.
  for (const character of ["\u202A", "\u202E", "\u2066", "\u2069"]) {
    assert.equal(isValidXText(`hello${character}`), true);
    assert.equal(fits(` https://example.com${character}`, 254), true);
    assert.equal(fits(` https://example.com${character}`, 255), false);
  }
});

it("counts long t.co slugs as text", () => {
  assert.equal(fits(" https://t.co/" + "a".repeat(40), 256), true);
  assert.equal(fits(" https://t.co/" + "a".repeat(41), 225), true);
  assert.equal(fits(" https://t.co/" + "a".repeat(41), 226), false);
});
