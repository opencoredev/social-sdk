// Offline checks for the Revnu blog: a local server stands in for the Content API.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { renderPost, renderRss, renderSitemap, rewriteLinks } from "./render";

const KEY = "rvc_test";

const day = 86_400_000;

const summaries = Array.from({ length: 3 }, (_, index) => ({
  slug: `post-${3 - index}`,
  title: `Post <${3 - index}> & co`,
  metaDescription: `About post ${3 - index}.`,
  canonicalPath: index === 0 ? "/guides/post-3" : `/post-${3 - index}`,
  canonicalUrl: `https://social-sdk.dev/blog${index === 0 ? "/guides/post-3" : `/post-${3 - index}`}`,
  publishedAt: 1_760_000_000_000 + (3 - index) * day,
  updatedAt: null,
}));

let requests: string[] = [];

let rateLimited = false;

let server: Server;

type Reply = { status: number; body: object; headers?: Record<string, string> };

function reply({ url, authorization }: { url: URL; authorization: string | undefined }): Reply {
  requests.push(url.pathname + url.search);

  if (authorization !== `Bearer ${KEY}`) return { status: 404, body: { error: "not_found" } };

  if (!rateLimited) {
    rateLimited = true;

    return { status: 429, body: {}, headers: { "retry-after": "0" } };
  }

  if (url.pathname === "/posts") {
    // Two posts per page, so the client must follow the cursor.
    const start = Number(url.searchParams.get("cursor") ?? 0);

    return {
      status: 200,
      body: {
        blog: {},
        nav: {},
        posts: summaries.slice(start, start + 2),
        cursor: start + 2 < summaries.length ? String(start + 2) : null,
      },
    };
  }

  const slug = url.pathname.replace("/posts/", "");
  // post-1 vanishes between the list and detail requests.
  const summary = summaries.find((post) => post.slug === slug && slug !== "post-1");

  if (!summary) return { status: 404, body: { error: "not_found" } };

  return {
    status: 200,
    body: {
      blog: {},
      post: {
        ...summary,
        body: { markdown: "", html: '<p><a href="/post-2">next</a></p>' },
        toc: [],
        heroImageUrl: null,
        faqItems: [{ question: "Q?", answer: "A." }],
        citations: [],
      },
      headMeta: {
        title: `${summary.title} | Social SDK`,
        description: summary.metaDescription,
        canonical: summary.canonicalUrl,
        openGraph: { url: "https://elsewhere.example/", images: [{ url: "https://img/1.png" }] },
        twitter: { card: "summary" },
      },
      jsonLd: [{ "@type": "Article", headline: "</script><b>x</b>" }],
      related: [
        { slug: "post-2", title: "Two", canonicalPath: "/post-2" },
        { slug: "post-1", title: "Gone", canonicalPath: "/post-1" },
      ],
    },
  };
}

function isTcpAddress(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const result = reply({ url, authorization: request.headers.authorization });

    response.writeHead(result.status, { "content-type": "application/json", ...result.headers });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!isTcpAddress(address)) throw new Error("expected a TCP address");

  process.env.REVNU_CONTENT_API_KEY = KEY;
  process.env.REVNU_CONTENT_API_URL = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

test("loads every page of posts, waits out a 429, and drops posts that 404", async () => {
  requests = [];
  const { revnuPosts } = await import("./revnu");
  const posts = await revnuPosts();

  assert.deepEqual(
    posts.map((post) => post.canonicalPath),
    ["/guides/post-3", "/post-2"],
  );
  assert.deepEqual(
    requests.filter((path) => path.startsWith("/posts?")),
    ["/posts?limit=100", "/posts?limit=100", "/posts?limit=100&cursor=2"],
  );

  const [post] = posts;

  if (!post) throw new Error("expected a post");

  const html = renderPost({ post, published: new Set(posts.map((item) => item.canonicalPath)) });
  const has = (fragment: string) => assert.ok(html.includes(fragment), fragment);
  const lacks = (fragment: string) => assert.ok(!html.includes(fragment), fragment);

  has('<link rel="canonical" href="https://social-sdk.dev/blog/guides/post-3" />');
  has('<meta property="og:url" content="https://social-sdk.dev/blog/guides/post-3" />');
  lacks("elsewhere.example");
  has('<meta property="og:image" content="https://img/1.png" />');
  has('<meta name="twitter:card" content="summary" />');
  has("\\u003c/script>\\u003cb>x\\u003c/b>");
  has("<h1>Post &lt;3&gt; &amp; co</h1>");
  has('href="/blog/post-2"');
  lacks("/blog/post-1");
  has("<dt>Q?</dt>");

  const rss = renderRss(posts);

  assert.ok(rss.includes("<title>Post &lt;3&gt; &amp; co</title>"));
  assert.equal(rss.match(/<item>/g)?.length, 2);

  const sitemap = renderSitemap(posts);
  const updated = new Date(summaries[1]?.publishedAt ?? 0).toISOString();

  assert.ok(
    sitemap.includes(`<loc>https://social-sdk.dev/blog/post-2</loc><lastmod>${updated}</lastmod>`),
  );
  assert.ok(!sitemap.includes("/blog/post-1<"));
});

test("rewrites root-relative links into the blog and leaves others alone", () => {
  assert.equal(
    rewriteLinks('<a href="/x">x</a><a href="//cdn/y">y</a><a href="/">home</a>'),
    '<a href="/blog/x">x</a><a href="//cdn/y">y</a><a href="/blog">home</a>',
  );
});
