// Blog URLs with last-modified times, built at /blog/sitemap.xml (see feeds.ts).
// scripts/prune-docs-output.ts merges them into /sitemap.xml and deletes this file.
import type { APIRoute } from "astro";

import { renderSitemap } from "./render";
import { revnuPosts } from "./revnu";

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(renderSitemap(await revnuPosts()), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
