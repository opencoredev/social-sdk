// RSS feed of every blog post, newest first. Served at /blog/rss.xml (see feeds.ts).
import type { APIRoute } from "astro";

import { renderRss } from "./render";
import { revnuPosts } from "./revnu";

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(renderRss(await revnuPosts()), {
    headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
  });
