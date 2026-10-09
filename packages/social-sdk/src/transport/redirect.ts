/** Statuses that `fetch` rejects under `redirect: "error"` in Node.js and Bun. */
const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Sends one request without following redirects.
 *
 * Cloudflare Workers reject `redirect: "error"`, so the request uses `"manual"` and a
 * redirect response rejects with a `TypeError`, as `fetch` does for `"error"` in Node.js
 * and Bun. `allowStatuses` lets a caller receive a provider status that reuses a redirect
 * code without a `Location` header, such as YouTube's `308 Resume Incomplete`.
 */
export async function fetchWithoutRedirects(
  fetcher: typeof globalThis.fetch,
  input: string | URL,
  init: RequestInit,
  allowStatuses: readonly number[] = [],
): Promise<Response> {
  const response = await fetcher(input, { ...init, redirect: "manual" });

  if (
    response.type === "opaqueredirect" ||
    (redirectStatuses.has(response.status) &&
      (!allowStatuses.includes(response.status) || response.headers.has("location")))
  ) {
    void response.body?.cancel().catch(() => undefined);
    throw new TypeError("Upstream response redirected; redirects are not followed.");
  }

  return response;
}
