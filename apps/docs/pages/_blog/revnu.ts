// Build-time client for the Revnu Content API, which supplies the blog's posts.
// https://revnu.com/docs/content-api
//
// Pages render at build time, so the key never reaches the browser. Every
// response is decoded before use. A post that is missing from the list
// endpoint has been removed, so it never gets a page, a feed item, or a
// sitemap entry; the next build after a removal drops it everywhere.

const DEFAULT_BASE = "https://revnu.com/api/content/v1";

/** Where the pages are served. Revnu's canonicalUrl should be this plus canonicalPath. */
const BLOG_ORIGIN = "https://social-sdk.dev/blog";

/** Posts per list request. The API allows up to 200. */
const PAGE_SIZE = 100;

/** How many times one request waits out a 429 before the build fails. */
const MAX_RATE_LIMIT_WAITS = 3;

/** One request may take this long before the build fails instead of hanging. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Detail requests in flight at once. */
const DETAIL_CONCURRENCY = 4;

export type Summary = {
  slug: string;
  title: string;
  description: string;
  canonicalPath: string;
  canonicalUrl: string;
  publishedAt: Date;
  updatedAt: Date | null;
};

/** One Open Graph or Twitter value, with its structured detail tags such as image width. */
export type MetaValue = { content: string; details: { key: string; content: string }[] };

/** One headMeta.openGraph or headMeta.twitter field, kept as Revnu sent it. */
export type MetaField = { key: string; values: MetaValue[] };

export type HeadMeta = {
  title: string;
  description: string;
  openGraph: MetaField[];
  twitter: MetaField[];
};

export type Faq = { question: string; answer: string };

/** A JSON-LD entry, embedded exactly as Revnu sent it. */
export type JsonLd = JsonObject;

export type Post = Summary & {
  html: string;
  toc: { text: string; slug: string }[];
  heroImageUrl: string | null;
  faqItems: Faq[];
  citations: string[];
  headMeta: HeadMeta;
  jsonLd: JsonLd[];
  related: { title: string; canonicalPath: string }[];
};

type Settings = { kind: "configured"; key: string; base: string } | { kind: "missing" };

type Configured = Extract<Settings, { kind: "configured" }>;

type Page = { posts: Summary[]; cursor: string | null };

// ---------- decoding ----------

type Json = null | boolean | number | string | readonly Json[] | JsonObject;

interface JsonObject {
  readonly [key: string]: Json;
}

type Field = Json | undefined;

class DecodeError extends Error {}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return value.every(isJson);

  return typeof value === "object" && Object.values(value).every(isJson);
}

function isObject(value: Field): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isList(value: Field): value is readonly Json[] {
  return Array.isArray(value);
}

function isText(value: Field): value is string {
  return typeof value === "string";
}

function isNumber(value: Field): value is number {
  return typeof value === "number";
}

function isScalar(value: Field): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function record(value: Field, at: string): JsonObject {
  if (!isObject(value)) throw new DecodeError(`${at} is not an object`);

  return value;
}

function text(value: Field, at: string): string {
  if (!isText(value)) throw new DecodeError(`${at} is not a string`);

  return value;
}

function optionalText(value: Field, at: string): string | null {
  return value === undefined || value === null ? null : text(value, at);
}

function optionalList(value: Field, at: string): readonly Json[] {
  if (value === undefined || value === null) return [];

  if (!isList(value)) throw new DecodeError(`${at} is not an array`);

  return value;
}

function time(value: Field, at: string): Date {
  if (!isNumber(value)) throw new DecodeError(`${at} is not an epoch-millisecond number`);

  return new Date(value);
}

function optionalTime(value: Field, at: string): Date | null {
  return value === undefined || value === null ? null : time(value, at);
}

/** canonicalPath is a route key: one leading slash, no trailing slash, safe segments. */
function canonicalPath(value: Field, at: string): string {
  const path = text(value, at);

  if (!/^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)+$/.test(path))
    throw new DecodeError(`${at} is not a route path like /slug or /prefix/slug`);

  return path;
}

function decodeSummary(value: Json, at: string): Summary {
  const raw = record(value, at);

  return {
    slug: text(raw.slug, `${at}.slug`),
    title: text(raw.title, `${at}.title`),
    description: optionalText(raw.metaDescription, `${at}.metaDescription`) ?? "",
    canonicalPath: canonicalPath(raw.canonicalPath, `${at}.canonicalPath`),
    canonicalUrl: text(raw.canonicalUrl, `${at}.canonicalUrl`),
    publishedAt: time(raw.publishedAt, `${at}.publishedAt`),
    updatedAt: optionalTime(raw.updatedAt, `${at}.updatedAt`),
  };
}

function decodePage(value: Json): Page {
  const raw = record(value, "list response");

  return {
    posts: optionalList(raw.posts, "list response.posts").map((post, index) =>
      decodeSummary(post, `posts[${index}]`),
    ),
    cursor: optionalText(raw.cursor, "list response.cursor"),
  };
}

/**
 * Keeps every scalar in a headMeta group, and objects with a `url` (images,
 * videos) along with their scalar details. Anything else has no meta-tag form.
 */
function decodeMetaGroup(value: Field): MetaField[] {
  if (!isObject(value)) return [];

  return Object.entries(value).map(([key, raw]) => ({
    key,
    values: (isList(raw) ? raw : [raw]).flatMap((item): MetaValue[] => {
      if (isScalar(item)) return [{ content: String(item), details: [] }];

      if (!isObject(item) || !isScalar(item.url)) return [];

      return [
        {
          content: String(item.url),
          details: Object.entries(item).flatMap(([detail, content]) =>
            detail !== "url" && isScalar(content)
              ? [{ key: detail, content: String(content) }]
              : [],
          ),
        },
      ];
    }),
  }));
}

function decodePost(value: Json, summary: Summary): Post {
  const at = `post ${summary.slug}`;
  const raw = record(value, at);
  const post = record(raw.post, `${at}.post`);
  const body = record(post.body, `${at}.post.body`);
  const head = record(raw.headMeta, `${at}.headMeta`);

  return {
    // The list is the source of truth for routing and dates, so the summary wins.
    ...summary,
    html: text(body.html, `${at}.post.body.html`),
    toc: optionalList(post.toc, `${at}.post.toc`).map((item, index) => {
      const entry = record(item, `${at}.post.toc[${index}]`);

      return {
        text: text(entry.text, `${at}.post.toc[${index}].text`),
        slug: text(entry.slug, `${at}.post.toc[${index}].slug`),
      };
    }),
    heroImageUrl: optionalText(post.heroImageUrl, `${at}.post.heroImageUrl`),
    faqItems: optionalList(post.faqItems, `${at}.post.faqItems`).map((item, index) => {
      const faq = record(item, `${at}.post.faqItems[${index}]`);

      return {
        question: text(faq.question, `${at}.post.faqItems[${index}].question`),
        answer: text(faq.answer, `${at}.post.faqItems[${index}].answer`),
      };
    }),
    citations: optionalList(post.citations, `${at}.post.citations`).map((url, index) =>
      text(url, `${at}.post.citations[${index}]`),
    ),
    headMeta: {
      title: optionalText(head.title, `${at}.headMeta.title`) ?? summary.title,
      description:
        optionalText(head.description, `${at}.headMeta.description`) ?? summary.description,
      openGraph: decodeMetaGroup(head.openGraph),
      twitter: decodeMetaGroup(head.twitter),
    },
    jsonLd: optionalList(raw.jsonLd, `${at}.jsonLd`).map((entry, index) =>
      record(entry, `${at}.jsonLd[${index}]`),
    ),
    related: optionalList(raw.related, `${at}.related`).map((item, index) => {
      const related = record(item, `${at}.related[${index}]`);

      return {
        title: text(related.title, `${at}.related[${index}].title`),
        canonicalPath: canonicalPath(
          related.canonicalPath,
          `${at}.related[${index}].canonicalPath`,
        ),
      };
    }),
  };
}

// ---------- transport ----------

function settings(): Settings {
  const key = process.env.REVNU_CONTENT_API_KEY?.trim();

  if (!key) return { kind: "missing" };
  // REVNU_CONTENT_API_URL exists so the build can be tested against a local stub.
  const base = process.env.REVNU_CONTENT_API_URL?.trim() || DEFAULT_BASE;

  return { kind: "configured", key, base: base.replace(/\/+$/, "") };
}

type Fetched = { kind: "ok"; body: Json } | { kind: "not-found" };

async function request(config: Configured, path: string): Promise<Fetched> {
  for (let waits = 0; ; waits++) {
    const response = await fetch(`${config.base}${path}`, {
      headers: { Authorization: `Bearer ${config.key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.ok) {
      const body: unknown = await response.json();

      if (!isJson(body)) throw new DecodeError(`[blog] Revnu ${path} returned invalid JSON.`);

      return { kind: "ok", body };
    }

    if (response.status === 404) return { kind: "not-found" };

    if (response.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
      const header = response.headers.get("retry-after");
      const seconds = header === null ? Number.NaN : Number(header);
      const delay = Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) : 5;
      console.warn(`[blog] Revnu rate limited ${path}; waiting ${delay}s.`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      continue;
    }

    // The path is logged, never the key or the response body.
    throw new Error(`[blog] Revnu ${path} answered ${response.status}.`);
  }
}

async function listAll(config: Configured): Promise<Summary[]> {
  const posts: Summary[] = [];
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });

    if (cursor !== null) query.set("cursor", cursor);

    const result = await request(config, `/posts?${query}`);

    // On the list endpoint a 404 means the key is unknown or revoked.
    if (result.kind === "not-found")
      throw new Error("[blog] Revnu rejected REVNU_CONTENT_API_KEY (unknown or revoked).");

    const page = decodePage(result.body);

    if (page.cursor !== null && cursors.has(page.cursor))
      throw new Error("[blog] Revnu returned a cursor it already returned.");

    for (const post of page.posts) {
      if (seen.has(post.canonicalPath))
        throw new Error(`[blog] Two Revnu posts share the path ${post.canonicalPath}.`);
      seen.add(post.canonicalPath);

      // The page is served at BLOG_ORIGIN + canonicalPath. A different canonical
      // (another host, or a trailing slash this site redirects) needs fixing in Revnu.
      if (post.canonicalUrl !== `${BLOG_ORIGIN}${post.canonicalPath}`)
        console.warn(
          `[blog] Revnu canonicalUrl for ${post.canonicalPath} is ${post.canonicalUrl}, not ${BLOG_ORIGIN}${post.canonicalPath}.`,
        );
      posts.push(post);
    }

    cursor = page.cursor;

    if (cursor !== null) cursors.add(cursor);
  } while (cursor !== null);

  return posts;
}

async function loadAll(): Promise<Post[]> {
  const config = settings();

  if (config.kind === "missing") {
    // A production deploy without the key would silently wipe every post, so it
    // fails instead and the previous deployment stays live.
    if (process.env.VERCEL_ENV === "production")
      throw new Error("[blog] REVNU_CONTENT_API_KEY is not set for this production build.");
    console.warn("[blog] REVNU_CONTENT_API_KEY is not set; building the blog with no posts.");

    return [];
  }

  const summaries = await listAll(config);
  const posts: (Post | null)[] = Array.from({ length: summaries.length }, () => null);
  let next = 0;

  const worker = async () => {
    while (next < summaries.length) {
      const index = next++;
      const summary = summaries[index];

      if (summary === undefined) return;

      const result = await request(config, `/posts/${encodeURIComponent(summary.slug)}`);

      if (result.kind === "not-found") {
        // Removed between the list and detail requests: treat it as removed.
        console.warn(`[blog] Revnu post ${summary.slug} disappeared during the build; skipping.`);
        continue;
      }

      posts[index] = decodePost(result.body, summary);
    }
  };

  await Promise.all(Array.from({ length: DETAIL_CONCURRENCY }, worker));

  const loaded = posts.filter((post): post is Post => post !== null);

  // The API already sorts newest first; sorting again keeps the order stable.
  return loaded.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

let cache: Promise<Post[]> | undefined;

/** Every published Revnu post, newest first. Fetched once per build. */
export function revnuPosts(): Promise<Post[]> {
  cache ??= loadAll();

  return cache;
}
