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
