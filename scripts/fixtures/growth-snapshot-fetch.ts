// Offline fetch for scripts/growth-snapshot.test.ts, loaded with `bun --preload`.
// It answers every request the snapshot makes from fixed data and rejects
// anything else, so the test never reaches the network. GROWTH_STUB picks how
// the stargazers endpoint answers.

const mode = process.env["GROWTH_STUB"] ?? "ok";

const realFetch = globalThis.fetch;

function json(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

function stargazers(url: URL, authorization: string | null): Response {
  const page = url.searchParams.get("page");

  switch (mode) {
    case "ok":
      return json(200, JSON.stringify([{ starred_at: yesterday() }]));
    case "growth-token-only":
      return authorization === "Bearer growth-token"
        ? json(200, JSON.stringify([{ starred_at: yesterday() }]))
        : json(403, '{"message":"Resource not accessible by integration"}');
    case "403":
    case "npm-500":
      return json(403, '{"message":"Resource not accessible by integration"}');
    case "401":
      return json(401, '{"message":"Requires authentication"}');
    case "403-page-2":
      return page === "1"
        ? json(200, "[]", {
            link: '<https://api.github.com/repositories/1/stargazers?per_page=100&page=2>; rel="last"',
          })
        : json(403, '{"message":"Resource not accessible by integration"}');
    case "403-rate-limit-header":
      return json(403, '{"message":"Forbidden"}', { "x-ratelimit-remaining": "0" });
    case "403-secondary-rate-limit":
      return json(403, '{"message":"You have exceeded a secondary rate limit."}');
    case "403-abuse-detection":
      return json(
        403,
        '{"message":"You have triggered an abuse detection mechanism. Please wait a few minutes before you try again."}',
      );
    case "500":
      return json(500, "{}");
    case "malformed":
      return json(200, '[{"starred_at":5}]');
    default:
      throw new Error(`Unknown GROWTH_STUB ${mode}`);
  }
}

async function stub(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);

  if ((init?.method ?? "GET") !== "GET") throw new Error(`The stub refuses ${url.href}`);

  if (url.href.startsWith("https://api.npmjs.org/downloads/range/"))
    return mode === "npm-500"
      ? json(500, "{}")
      : json(200, '{"downloads":[{"day":"2026-01-01","downloads":4}]}');

  if (url.href.startsWith("https://api.npmjs.org/versions/"))
    return json(200, '{"downloads":{"1.0.0":3}}');

  if (url.pathname === "/repos/opencoredev/social-sdk")
    return json(
      200,
      '{"stargazers_count":5,"forks_count":1,"subscribers_count":2,"open_issues_count":0}',
    );

  if (url.pathname === "/repos/opencoredev/social-sdk/stargazers")
    return stargazers(url, new Headers(init?.headers).get("authorization"));

  if (url.pathname === "/repos/opencoredev/social-sdk/traffic/views")
    return json(200, '{"count":0,"uniques":0,"views":[]}');

  if (url.pathname === "/repos/opencoredev/social-sdk/traffic/clones")
    return json(200, '{"count":0,"uniques":0,"clones":[]}');

  if (url.pathname === "/repos/opencoredev/social-sdk/traffic/popular/referrers")
    return json(200, "[]");

  throw new Error(`The stub has no answer for ${url.href}`);
}

globalThis.fetch = Object.assign(stub, realFetch);
