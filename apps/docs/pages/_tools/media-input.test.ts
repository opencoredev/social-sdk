import assert from "node:assert/strict";
import { test } from "node:test";

import { parseMedia, type RawField, type RawMedia } from "./media-input";

const field = (value: string, badInput = false): RawField => ({ value, badInput });

const raw = (changes: Partial<RawMedia>): RawMedia => ({
  kind: "none",
  count: field("4"),
  seconds: field(""),
  size: field(""),
  ...changes,
});

test("parses valid media fields into a plan", () => {
  assert.deepEqual(parseMedia(raw({ kind: "carousel", count: field("4"), size: field("2.5") })), {
    kind: "ok",
    media: { kind: "carousel", count: 4, sizeMb: 2.5 },
  });
  assert.deepEqual(parseMedia(raw({ kind: "video", seconds: field("0") })), {
    kind: "ok",
    media: { kind: "video", seconds: 0, sizeMb: undefined },
  });
  assert.deepEqual(parseMedia(raw({ kind: "image" })), {
    kind: "ok",
    media: { kind: "image", sizeMb: undefined },
  });
});

test("rejects a negative or fractional item count instead of clamping it", () => {
  for (const value of ["-99", "2.5", "0", ""]) {
    const parsed = parseMedia(raw({ kind: "carousel", count: field(value) }));

    assert.equal(parsed.kind, "error", value);
    assert.deepEqual(
      parsed.kind === "error" ? parsed.errors.map((error) => error.field) : [],
      ["count"],
      value,
    );
  }
});

test("rejects a negative length and a size of 0 or less", () => {
  const video = parseMedia(raw({ kind: "video", seconds: field("-5"), size: field("-1") }));

  assert.equal(video.kind, "error");
  assert.deepEqual(video.kind === "error" ? video.errors.map((error) => error.field) : [], [
    "seconds",
    "size",
  ]);
  assert.equal(parseMedia(raw({ kind: "image", size: field("0") })).kind, "error");
});

test("reports a number field the browser could not read", () => {
  const parsed = parseMedia(raw({ kind: "video", seconds: field("", true) }));

  assert.deepEqual(parsed, {
    kind: "error",
    errors: [{ field: "seconds", message: "Enter a number." }],
  });
});

test("ignores fields that don't apply to the chosen media", () => {
  assert.deepEqual(parseMedia(raw({ kind: "none", count: field("-99"), size: field("-1") })), {
    kind: "ok",
    media: { kind: "none" },
  });
  assert.equal(parseMedia(raw({ kind: "image", count: field("-99") })).kind, "ok");
});
