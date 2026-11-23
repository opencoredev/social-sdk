import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addLastmod,
  lastChange,
  pageSources,
  type GitDates,
  type PageSource,
} from "./sitemap-dates";

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
    "youtube-analytics-api",
    "youtube-data-api",
    "facebook-page-access-token",
    "ayrshare-alternatives",
    "youtube-upload-api",
    "linkedin-posts-api",
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
  assert.ok(!index?.files.includes("_guides/youtube-analytics-api.ts"));
  assert.ok(!index?.files.includes("_guides/youtube-data-api.ts"));
  assert.ok(!index?.files.includes("_guides/facebook-page-access-token.ts"));
  assert.ok(!index?.files.includes("_guides/ayrshare-alternatives.ts"));
  assert.ok(!index?.files.includes("_guides/youtube-upload-api.ts"));
  assert.ok(!index?.files.includes("_guides/linkedin-posts-api.ts"));
  assert.ok(!index?.files.includes("_guides/social-media-apis.ts"));
  assert.ok(!index?.files.includes("_guides/buffer-api.ts"));
  assert.ok(!index?.files.includes("_guides/bluesky-api.ts"));
  assert.ok(!index?.files.includes("_guides/threads-api.ts"));
  assert.ok(!index?.files.includes("_guides/x-api-pricing.ts"));
  assert.deepEqual(
    index?.ranges.map((range) => `${range.file} ${range.from}`),
    [
      "_info/pages.ts ^export type Shell",
      "_guides/youtube-analytics-api.ts ^  slug:",
      "_guides/youtube-data-api.ts ^  slug:",
      "_guides/facebook-page-access-token.ts ^  slug:",
      "_guides/ayrshare-alternatives.ts ^  slug:",
      "_guides/youtube-upload-api.ts ^  slug:",
      "_guides/linkedin-posts-api.ts ^  slug:",
      "_guides/social-media-apis.ts ^  slug:",
      "_guides/buffer-api.ts ^  slug:",
      "_guides/bluesky-api.ts ^  slug:",
      "_guides/threads-api.ts ^  slug:",
      "_guides/x-api-pricing.ts ^  slug:",
    ],
  );
});

test("dates every tool page from its own modules and the shared tool shell", () => {
  for (const path of ["/tools", "/tools/api-cost-calculator", "/tools/platform-limits"]) {
    const source = pageSources.get(path);

    assert.ok(source?.files.includes("_tools/tools.ts"), path);
    assert.ok(source?.files.includes("_info/info.html"), path);
    assert.deepEqual(
      source?.ranges.map((range) => range.from),
      ["^export type Shell"],
      path,
    );
  }

  assert.ok(pageSources.get("/tools/api-cost-calculator")?.files.includes("_tools/cost.ts"));
  assert.ok(pageSources.get("/tools/platform-limits")?.files.includes("_tools/preflight.ts"));
  // The index lists the tools; a calculator change must not re-date it.
  assert.ok(!pageSources.get("/tools")?.files.includes("_tools/cost.ts"));
});

const source: PageSource = {
  files: ["about.astro"],
  ranges: [{ file: "_info/pages.ts", from: "^a", to: "^b" }],
};

function fakeGit(
  dates: Record<string, string>,
  uncommitted: readonly string[] = [],
): GitDates & { asked: string[][] } {
  const asked: string[][] = [];

  return {
    asked,
    logDate: (args) => {
      asked.push([...args]);

      return dates[args.join(" ")];
    },
    hasUncommittedChanges: (paths) => paths.some((path) => uncommitted.includes(path)),
    now: () => "2026-11-23T12:00:00.000Z",
  };
}

test("dates a clean source by its latest commit across files and ranges", () => {
  const git = fakeGit({
    "-- about.astro": "2026-10-01T10:00:00-04:00",
    "-s -L /^a/,/^b/:_info/pages.ts": "2026-11-02T09:00:00Z",
  });

  assert.equal(lastChange(source, git), "2026-11-02T09:00:00Z");
  assert.equal(git.asked.length, 2);
});

test("dates a source with uncommitted or new files by the build time", () => {
  const git = fakeGit({}, ["_info/pages.ts"]);

  assert.equal(lastChange(source, git), "2026-11-23T12:00:00.000Z");
  assert.equal(git.asked.length, 0);
});

test("fails on a committed source that git has no date for", () => {
  assert.throws(() => lastChange(source, fakeGit({})), /git has no commit date/);
});
