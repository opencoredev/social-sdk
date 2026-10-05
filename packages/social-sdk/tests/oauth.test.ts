import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  exchangeLongLivedOAuthToken,
  instagramOAuth,
  linkedinOAuth,
  refreshOAuthToken,
  tiktokOAuth,
  xOAuth,
  youtubeOAuth,
} from "../src/server/oauth.js";
import type { ConnectionAttempt } from "../src/server/connections.js";
import type { JsonValue } from "../src/core/types.js";
import { isString } from "../src/transport/validation.js";

const attempt: ConnectionAttempt = {
  id: "a",
  backend: "direct",
  tenantId: "t",
  principalId: "p",
  platforms: ["x"],
  capabilities: [],
  redirectUri: "https://app.test/cb",
  state: "state",
  codeVerifier: "verifier",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(),
};

describe("direct OAuth providers", () => {
  it("uses documented X authorization host, publish scopes, and Basic client authentication", async () => {
    let request: RequestInit | undefined;

    const provider = xOAuth({
      clientId: "client",
      clientSecret: "secret",
      fetch: async (_url, init) => {
        if (init?.method === "POST") {
          request = init;

          return new Response(JSON.stringify({ access_token: "at", user_id: "42" }), {
            headers: { "content-type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ data: { id: "42", name: "Ada" } }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const started = await provider.start({
      platforms: ["x"],
      capabilities: [],
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      codeChallenge: "challenge",
    });

    const auth = new URL(started.authorizationUrl);
    assert.equal(auth.origin + auth.pathname, "https://x.com/i/oauth2/authorize");
    assert.match(auth.searchParams.get("scope") ?? "", /tweet\.write/);
    await provider.complete({ callbackUrl: `${attempt.redirectUri}?code=c&state=state`, attempt });
    const headers = new Headers(request?.headers);
    assert.equal(headers.get("authorization"), `Basic ${btoa("client:secret")}`);
    const body = request?.body;
    assert.ok(body instanceof URLSearchParams);
    assert.equal(body.has("client_secret"), false);
  });

  it("does not add PKCE parameters to TikTok web authorization", async () => {
    const started = await tiktokOAuth({ clientId: "client" }).start({
      platforms: ["tiktok"],
      capabilities: [],
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      codeChallenge: "challenge",
    });

    const url = new URL(started.authorizationUrl);
    assert.equal(url.searchParams.has("code_challenge"), false);
    assert.equal(url.searchParams.has("code_challenge_method"), false);
  });

  it("creates PKCE authorization URL and persists discovered account", async () => {
    let saved = "";

    const provider = xOAuth({
      clientId: "client",
      fetch: async (_url, init) => {
        if (init?.method === "POST")
          return new Response(
            JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
            { status: 200 },
          );

        return new Response(JSON.stringify({ data: { id: "42", name: "Ada" } }), { status: 200 });
      },
      credentialSink: {
        save: async ({ account }) => {
          saved = account.ref.accountId;
        },
      },
    });

    const started = await provider.start({
      platforms: ["x"],
      capabilities: [],
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      codeChallenge: "challenge",
    });

    assert.equal(new URL(started.authorizationUrl).searchParams.get("code_challenge"), "challenge");

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt,
    });

    assert.equal(accounts[0]?.ref.accountId, "42");
    assert.equal(saved, "42");
  });
  it("keeps rotated refresh token and rejects missing refresh token", async () => {
    const next = await refreshOAuthToken(
      "youtube",
      {
        clientId: "c",
        fetch: async () =>
          new Response(JSON.stringify({ access_token: "new", expires_in: 10 }), { status: 200 }),
      },
      { accessToken: "old", refreshToken: "keep" },
    );

    assert.equal(next.refreshToken, "keep");
    await assert.rejects(refreshOAuthToken("youtube", { clientId: "c" }, { accessToken: "x" }), {
      code: "reconnect_required",
    });
  });

  it("maps invalid_grant on token exchange and refresh to reconnect_required", async () => {
    const provider = xOAuth({
      clientId: "c",
      clientSecret: "s",
      fetch: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    });

    await assert.rejects(
      provider.complete({ callbackUrl: `${attempt.redirectUri}?code=c&state=state`, attempt }),
      { code: "reconnect_required" },
    );
    await assert.rejects(
      refreshOAuthToken(
        "x",
        {
          clientId: "c",
          clientSecret: "s",
          fetch: async () =>
            new Response("error=invalid_grant", {
              status: 400,
              headers: { "content-type": "application/x-www-form-urlencoded" },
            }),
        },
        { accessToken: "a", refreshToken: "r" },
      ),
      { code: "reconnect_required" },
    );
  });

  it("accepts wrapped Instagram tokens and either /me identity", async () => {
    const provider = instagramOAuth({
      clientId: "client",
      fetch: async (url) => {
        if (String(url).includes("oauth/access_token"))
          return new Response(
            JSON.stringify({ data: [{ access_token: "at", user_id: "user-1" }] }),
            { headers: { "content-type": "application/json" } },
          );

        return new Response(JSON.stringify({ id: "id-1", user_id: "user-1", username: "Ada" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["instagram"] },
    });

    assert.equal(accounts[0]?.ref.accountId, "user-1");
  });

  it("uses the professional Instagram id when the token hint is app-scoped", async () => {
    const provider = instagramOAuth({
      clientId: "client",
      fetch: async (url) =>
        String(url).includes("oauth/access_token")
          ? response({ access_token: "at", user_id: "app-scoped" })
          : response({ id: "app-scoped", user_id: "professional", username: "Ada" }),
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["instagram"] },
    });

    assert.equal(accounts[0]?.ref.accountId, "professional");
  });

  it("uses the versioned LinkedIn organization ACL endpoint and accepts CONTENT_ADMINISTRATOR", async () => {
    const seen: string[] = [];

    const provider = linkedinOAuth({
      clientId: "client",
      linkedinApiVersion: "202609",
      fetch: async (url, init) => {
        seen.push(String(url));

        if (init?.method === "POST")
          return new Response(JSON.stringify({ access_token: "at" }), {
            headers: { "content-type": "application/json" },
          });

        if (String(url).includes("userinfo"))
          return new Response(JSON.stringify({ sub: "member", name: "Member" }), {
            headers: { "content-type": "application/json" },
          });

        return new Response(
          JSON.stringify({
            elements: [
              { organizationTarget: "urn:li:organization:123", role: "CONTENT_ADMINISTRATOR" },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["linkedin"] },
    });

    assert.equal(
      accounts.some((item) => item.ref.accountId === "urn:li:organization:123"),
      true,
    );
    assert.equal(
      seen.some((url) => url.includes("/rest/organizationAcls?q=roleAssignee")),
      true,
    );
  });
});

function response(value: JsonValue, status = 200, contentType = "application/json") {
  return new Response(isString(value) ? value : JSON.stringify(value), {
    status,
    headers: { "content-type": contentType },
  });
}

describe("provider-specific OAuth contracts", () => {
  it("uses comma-delimited TikTok scopes without web PKCE", async () => {
    const provider = tiktokOAuth({
      clientId: "client",
      fetch: async (url) =>
        String(url).includes("open.tiktokapis")
          ? response({ data: { user: { open_id: "open", display_name: "Creator" } } })
          : response({ data: { access_token: "at", open_id: "open", expires_in: 60 } }),
    });

    const started = await provider.start({
      platforms: ["tiktok"],
      capabilities: [],
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      codeChallenge: "challenge",
    });

    const parsed = new URL(started.authorizationUrl);
    assert.match(parsed.searchParams.get("scope") ?? "", /,/);
    assert.equal(parsed.searchParams.has("code_challenge_method"), false);
  });

  it("returns only ACL-authorized LinkedIn URNs and uses configured version", async () => {
    const seen: string[] = [];

    const provider = linkedinOAuth({
      clientId: "client",
      clientSecret: "secret",
      linkedinApiVersion: "202609",
      fetch: async (url, init) => {
        seen.push(`${url} ${new Headers(init?.headers).get("LinkedIn-Version") ?? ""}`);

        if (String(url).includes("userinfo")) return response({ sub: "member", name: "Member" });

        if (String(url).includes("organizationAcls"))
          return response({
            elements: [
              { organizationalTarget: "urn:li:organization:123", role: "ADMINISTRATOR" },
              { organizationalTarget: "urn:li:organization:456", role: "VIEWER" },
            ],
          });

        return response({ access_token: "at" });
      },
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
      attempt: { ...attempt, platforms: ["linkedin"] },
    });

    assert.deepEqual(
      accounts.map((item) => item.ref.accountId),
      ["urn:li:person:member", "urn:li:organization:123"],
    );
    assert.equal(
      seen.some((item) => item.includes("202609")),
      true,
    );
  });

  it("persists only validated accounts selected by the caller", async () => {
    const saved: string[] = [];

    const provider = youtubeOAuth({
      clientId: "client",
      credentialSink: {
        save: async ({ account }) => {
          saved.push(account.ref.accountId);
        },
      },
      selectAccounts: (accounts) => [accounts[1]!.ref.accountId],
      fetch: async (url, _init) =>
        String(url).includes("token")
          ? response({ access_token: "at" })
          : response({
              items: [
                { id: "channel-1", snippet: { title: "One" } },
                { id: "channel-2", snippet: { title: "Two" } },
              ],
            }),
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
      attempt: { ...attempt, platforms: ["youtube"] },
    });

    assert.equal(accounts.length, 2);
    assert.deepEqual(saved, ["channel-2"]);
  });

  it("persists every validated account by default for multi-account discovery", async () => {
    const saved: string[] = [];

    const provider = youtubeOAuth({
      clientId: "client",
      credentialSink: {
        save: async ({ account }) => {
          saved.push(account.ref.accountId);
        },
      },
      fetch: async (url) =>
        String(url).includes("token")
          ? response({ access_token: "at" })
          : response({
              items: [
                { id: "channel-1", snippet: { title: "One" } },
                { id: "channel-2", snippet: { title: "Two" } },
              ],
            }),
    });

    await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
      attempt: { ...attempt, platforms: ["youtube"] },
    });

    assert.deepEqual(saved, ["channel-1", "channel-2"]);
  });

  it("does not follow redirects or accept oversized token responses", async () => {
    const redirect = xOAuth({
      clientId: "client",
      fetch: async () => response({ access_token: "at" }),
    });

    await assert.rejects(
      redirect.complete({ callbackUrl: `${attempt.redirectUri}?code=c`, attempt }),
      { code: "unauthorized" },
    );

    const bounded = youtubeOAuth({
      clientId: "client",
      maxResponseBytes: 8,
      fetch: async () =>
        new Response(`{"access_token":"too-long"}`, {
          headers: { "content-type": "application/json" },
        }),
    });

    await assert.rejects(
      bounded.complete({
        callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
        attempt: { ...attempt, platforms: ["youtube"] },
      }),
      { code: "upstream_failure" },
    );
  });

  it("exchanges long-lived Meta tokens through documented grant types", async () => {
    const calls: string[] = [];

    const token = await exchangeLongLivedOAuthToken(
      "threads",
      {
        clientId: "client",
        clientSecret: "secret",
        fetch: async (url) => {
          calls.push(String(url));

          return response({ access_token: "long", expires_in: 100 });
        },
      },
      { accessToken: "short" },
    );

    assert.equal(token.accessToken, "long");
    assert.match(calls[0] ?? "", /th_exchange_token/);
  });

  it("maps denial to cancellation and rejects identity mismatch", async () => {
    const denied = instagramOAuth({
      clientId: "client",
      fetch: async () => response({ access_token: "at" }),
    });

    await assert.rejects(
      denied.complete({
        callbackUrl: `${attempt.redirectUri}?state=${attempt.state}&error=access_denied`,
        attempt: { ...attempt, platforms: ["instagram"] },
      }),
      { code: "cancelled" },
    );

    const mismatch = xOAuth({
      clientId: "client",
      fetch: async (url, _init) =>
        String(url).includes("users/me")
          ? response({ data: { id: "actual" } })
          : response({ access_token: "at", user_id: "other" }),
    });

    await assert.rejects(
      mismatch.complete({
        callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
        attempt,
      }),
      { code: "unauthorized" },
    );
  });
});

describe("OAuth transport limits", () => {
  it("times out injected fetchers that ignore AbortSignal", async () => {
    const provider = youtubeOAuth({
      clientId: "client",
      timeoutMs: 5,
      fetch: async () => await new Promise<Response>(() => {}),
    });

    await assert.rejects(
      provider.complete({
        callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
        attempt: { ...attempt, platforms: ["youtube"] },
      }),
      { code: "timeout" },
    );
  });
});

describe("Instagram granted permissions", () => {
  for (const permissions of ["instagram_business_basic", ["instagram_business_basic"]]) {
    it(`preserves partial consent through long-lived exchange (${Array.isArray(permissions) ? "array" : "string"})`, async () => {
      const saved: (readonly string[] | undefined)[] = [];

      const provider = instagramOAuth({
        clientId: "client",
        clientSecret: "secret",
        credentialSink: {
          save: async ({ token }) => {
            saved.push(token.scopes);
          },
        },
        fetch: async (url) => {
          if (String(url).includes("oauth/access_token"))
            return response({ access_token: "short", permissions, user_id: "professional" });

          if (String(url).includes("/me?"))
            return response({ id: "app-scoped", user_id: "professional" });

          return response({ access_token: "long", expires_in: 3600 });
        },
      });

      await provider.complete({
        callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
        attempt: { ...attempt, platforms: ["instagram"] },
      });
      assert.deepEqual(saved, [["instagram_business_basic"]]);
    });
  }
});

describe("YouTube discovery pagination", () => {
  it("requests 50 channels per page and discovers later pages", async () => {
    const pages: (string | null)[] = [];

    const provider = youtubeOAuth({
      clientId: "client",
      fetch: async (url) => {
        if (!String(url).includes("/channels?")) return response({ access_token: "at" });
        const query = new URL(String(url)).searchParams;
        assert.equal(query.get("maxResults"), "50");
        pages.push(query.get("pageToken"));

        return query.has("pageToken")
          ? response({ items: [{ id: "later", snippet: { title: "Later" } }] })
          : response({ items: [{ id: "first" }], nextPageToken: "next" });
      },
    });

    const accounts = await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["youtube"] },
    });

    assert.deepEqual(
      accounts.map((item) => item.ref.accountId),
      ["first", "later"],
    );
    assert.deepEqual(pages, [null, "next"]);
  });

  it("rejects repeated continuation tokens rather than looping", async () => {
    let pages = 0;

    const provider = youtubeOAuth({
      clientId: "client",
      fetch: async (url) => {
        if (!String(url).includes("/channels?")) return response({ access_token: "at" });
        pages++;

        return response({ items: [{ id: `channel-${pages}` }], nextPageToken: "repeat" });
      },
    });

    await assert.rejects(
      provider.complete({
        callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
        attempt: { ...attempt, platforms: ["youtube"] },
      }),
      { code: "upstream_failure", operation: "youtube.account" },
    );
    assert.equal(pages, 2);
  });
});

it("bounds YouTube account discovery without returning an incomplete picker", async () => {
  let pages = 0;

  const provider = youtubeOAuth({
    clientId: "client",
    fetch: async (url) => {
      if (!String(url).includes("/channels?")) return response({ access_token: "at" });
      pages++;

      return response({ items: [{ id: `channel-${pages}` }], nextPageToken: `page-${pages}` });
    },
  });

  await assert.rejects(
    provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["youtube"] },
    }),
    { code: "upstream_failure", operation: "youtube.account" },
  );
  assert.equal(pages, 100);
});

it("cancels YouTube continuation even when injected fetch ignores the signal", async () => {
  const controller = new AbortController();
  let pages = 0;

  const provider = youtubeOAuth({
    clientId: "client",
    signal: controller.signal,
    fetch: async (url) => {
      if (!String(url).includes("/channels?")) return response({ access_token: "at" });
      pages++;

      if (pages === 1) return response({ items: [{ id: "first" }], nextPageToken: "next" });
      controller.abort();

      return await new Promise<Response>(() => {});
    },
  });

  await assert.rejects(
    provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["youtube"] },
    }),
    { code: "cancelled", operation: "youtube.account" },
  );
  assert.equal(pages, 2);
});

it("decodes comma-delimited Instagram permissions without adding ungranted scopes", async () => {
  const saved: (readonly string[] | undefined)[] = [];

  const provider = instagramOAuth({
    clientId: "client",
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_content_publish",
    ],
    credentialSink: {
      save: async ({ token }) => {
        saved.push(token.scopes);
      },
    },
    fetch: async (url) =>
      String(url).includes("oauth/access_token")
        ? response({
            access_token: "at",
            permissions: "instagram_business_basic,instagram_business_manage_comments",
          })
        : response({ id: "app-scoped", user_id: "professional" }),
  });

  await provider.complete({
    callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
    attempt: { ...attempt, platforms: ["instagram"] },
  });
  assert.deepEqual(saved, [["instagram_business_basic", "instagram_business_manage_comments"]]);
});

it("rejects an Instagram token hint unrelated to either discovered identity", async () => {
  const provider = instagramOAuth({
    clientId: "client",
    fetch: async (url) =>
      String(url).includes("oauth/access_token")
        ? response({ access_token: "at", user_id: "unrelated" })
        : response({ id: "app-scoped", user_id: "professional" }),
  });

  await assert.rejects(
    provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=c&state=state`,
      attempt: { ...attempt, platforms: ["instagram"] },
    }),
    { code: "unauthorized", operation: "oauth.identity" },
  );
});

describe("OAuth refresh grant retention", () => {
  for (const kind of ["instagram", "threads"] as const) {
    it(`retains ${kind} exchange grants through refresh and honors explicit scopes`, async () => {
      const current = await exchangeLongLivedOAuthToken(
        kind,
        {
          clientId: "client",
          clientSecret: "secret",
          fetch: async () => response({ access_token: "long" }),
        },
        { accessToken: "short", scopes: ["original"], refreshToken: "refresh" },
      );

      for (const scope of [undefined, "replacement", []]) {
        const next = await refreshOAuthToken(
          kind,
          {
            clientId: "client",
            fetch: async () => {
              const data: JsonValue =
                scope === undefined
                  ? { access_token: "refreshed" }
                  : { access_token: "refreshed", scope };

              return response(data);
            },
          },
          current,
        );

        assert.deepEqual(
          next.scopes,
          scope === undefined ? ["original"] : Array.isArray(scope) ? [] : ["replacement"],
        );
      }
    });
  }
});

describe("OAuth response cancellation", () => {
  for (const external of [false, true]) {
    it(`cancels stalled bodies on ${external ? "caller abort" : "timeout"} without awaiting cancellation`, async () => {
      let cancelled = false;
      let stream: ReadableStream<Uint8Array> | undefined;
      const controller = new AbortController();

      const provider = youtubeOAuth({
        clientId: "client",
        timeoutMs: external ? 1000 : 10,
        signal: controller.signal,
        fetch: async () => {
          stream = new ReadableStream<Uint8Array>({
            start() {
              if (external) setTimeout(() => controller.abort(), 1);
            },
            cancel() {
              cancelled = true;

              return new Promise<void>(() => {});
            },
          });

          return new Response(stream);
        },
      });

      await assert.rejects(
        provider.complete({
          callbackUrl: `${attempt.redirectUri}?code=c&state=${attempt.state}`,
          attempt: { ...attempt, platforms: ["youtube"] },
        }),
        { code: external ? "cancelled" : "timeout" },
      );
      assert.equal(cancelled, true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(stream?.locked, false);
    });
  }
});
