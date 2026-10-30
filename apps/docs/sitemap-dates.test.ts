import assert from "node:assert/strict";
import { test } from "node:test";

import { addLastmod, pageSources, type PageSource } from "./sitemap-dates";

const origin = "https://social-sdk.dev";

test("dates an undated mapped entry from its sources", () => {
  const seen: PageSource[] = [];

  const dated = addLastmod({
    entry: `  <url><loc>${origin}/privacy</loc></url>`,
    origin,
    dateOf: (source) => {
      seen.push(source);

      return "2026-09-23T18:05:04-04:00";
    },
  });

  assert.equal(
    dated,
    `  <url><loc>${origin}/privacy</loc><lastmod>2026-09-23T18:05:04-04:00</lastmod></url>`,
  );
  assert.deepEqual(seen, [pageSources.get("/privacy")]);
});

test("reads the site root as /", () => {
  assert.ok(
    addLastmod({ entry: `<url><loc>${origin}/</loc></url>`, origin, dateOf: () => "d" }).includes(
      "<lastmod>d</lastmod>",
    ),
  );
});

test("keeps an existing lastmod", () => {
  const entry = `<url><loc>${origin}/docs</loc><lastmod>2026-10-05</lastmod></url>`;

  assert.equal(
    addLastmod({
      entry,
      origin,
      dateOf: () => {
        throw new Error("should not be called");
      },
    }),
    entry,
  );
});

test("rejects an undated page with no mapped sources", () => {
  assert.throws(
    () =>
      addLastmod({ entry: `<url><loc>${origin}/new-page</loc></url>`, origin, dateOf: () => "d" }),
    /add it to pageSources/,
  );
});

test("dates each info page by its own copy, not the other pages'", () => {
  const ranges = (path: string) => pageSources.get(path)?.ranges.map((range) => range.from);

  assert.ok(ranges("/about")?.includes("^export const about: InfoPage"));
  assert.ok(!ranges("/about")?.some((from) => from.includes("privacy")));
  assert.ok(!pageSources.get("/about")?.files.includes("_info/pages.ts"));
});

test("dates info pages by every shared part of pages.ts", () => {
  const froms = pageSources.get("/contact")?.ranges.map((range) => range.from) ?? [];

  for (const shared of ["^import shell", "^export type Shell", "^export function renderInfoPage"])
    assert.ok(froms.includes(shared), shared);
});

test("dates the empty blog index by the shell helpers only", () => {
  assert.deepEqual(
    pageSources.get("/blog")?.ranges.map((range) => range.from),
    ["^export type Shell"],
  );
});

test("dates every guide by its page, its copy, and the shared rendering", () => {
  for (const slug of [
    "social-media-apis",
    "buffer-api",
    "bluesky-api",
    "threads-api",
    "x-api-pricing",
  ]) {
    const guide = pageSources.get(`/guides/${slug}`);

    assert.ok(guide?.files.includes("_info/info.html"));
    assert.ok(guide?.files.includes(`guides/${slug}.astro`));
    assert.ok(guide?.files.includes(`_guides/${slug}.ts`));
    // The guide list in guides.ts changes when any guide is added; it must not
    // re-date the other guides.
    assert.ok(!guide?.files.includes("_guides/guides.ts"));
    assert.deepEqual(
      guide?.ranges.map((range) => `${range.file} ${range.from}`),
      [
        "_guides/guides.ts ^export type Guide",
        "_guides/guides.ts ^export function guidePath",
        "_guides/guides.ts ^export function renderGuide[(]",
        "_info/pages.ts ^export type Shell",
      ],
    );
  }
});

test("dates the guides index by guide metadata, not guide bodies", () => {
  const index = pageSources.get("/guides");

  assert.ok(!index?.files.includes("_guides"));
  assert.ok(!index?.files.includes("_guides/social-media-apis.ts"));
  assert.ok(!index?.files.includes("_guides/buffer-api.ts"));
  assert.ok(!index?.files.includes("_guides/bluesky-api.ts"));
  assert.ok(!index?.files.includes("_guides/threads-api.ts"));
  assert.ok(!index?.files.includes("_guides/x-api-pricing.ts"));
  assert.deepEqual(
    index?.ranges.map((range) => `${range.file} ${range.from}`),
    [
      "_info/pages.ts ^export type Shell",
      "_guides/social-media-apis.ts ^  slug:",
      "_guides/buffer-api.ts ^  slug:",
      "_guides/bluesky-api.ts ^  slug:",
      "_guides/threads-api.ts ^  slug:",
      "_guides/x-api-pricing.ts ^  slug:",
    ],
  );
});
