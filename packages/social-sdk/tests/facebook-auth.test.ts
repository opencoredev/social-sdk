import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { connectedAccountRef } from "../src/index.js";
import {
  discoverFacebookPages,
  exchangeFacebookCode,
  exchangeFacebookToken,
  facebook,
  facebookAppSecretProof,
  facebookLoginUrl,
  inspectFacebookToken,
  listFacebookPermissions,
  parseFacebookRateLimitUsage,
  type FacebookRateLimitUsage,
} from "../src/platforms/facebook.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

// Offline contract tests for Facebook Login helpers, appsecret_proof, and rate-limit usage
// headers. Every request goes to a fake fetch; nothing reaches Meta. The secrets below are
// placeholders.

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "contract",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30000 },
};

const page = connectedAccountRef({ backend: "default", platform: "facebook", accountId: "123" });

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
}

function fake(responses: readonly JsonValue[], headers: HeadersInit = {}) {
  const calls: Call[] = [];
  let index = 0;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
    });

    const response = responses[index++];

    if (response === undefined) throw new Error("Unexpected request");

    return Response.json(response, { headers });
  };

  return { calls, fetch };
}

const app = { appId: "1000", appSecret: "test-app-secret" };

describe("facebook Login helpers", () => {
  it("builds the dialog/oauth URL and exchanges the code at /oauth/access_token [feature:facebook.auth.oauth_login]", async () => {
    const url = new URL(
      facebookLoginUrl({
        appId: "1000",
        redirectUri: "https://app.example.com/facebook/callback",
        state: "state-0123456789abcdef",
        scopes: ["pages_show_list", "pages_manage_posts"],
        rerequest: true,
      }),
    );

    const { calls, fetch } = fake([
      { access_token: "short-user-token", token_type: "bearer", expires_in: 5400 },
    ]);

    const token = await exchangeFacebookCode({
      ...app,
      code: "code-from-redirect",
      redirectUri: "https://app.example.com/facebook/callback",
      fetch,
    });

    assert.equal(url.origin + url.pathname, "https://www.facebook.com/v27.0/dialog/oauth");
    assert.equal(url.searchParams.get("client_id"), "1000");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/facebook/callback");
    assert.equal(url.searchParams.get("state"), "state-0123456789abcdef");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "pages_show_list,pages_manage_posts");
    assert.equal(url.searchParams.get("auth_type"), "rerequest");
    assert.equal(calls[0]?.url.pathname, "/v27.0/oauth/access_token");
    assert.equal(calls[0]?.url.searchParams.get("code"), "code-from-redirect");
    assert.equal(calls[0]?.url.searchParams.get("client_id"), "1000");
    assert.deepEqual(token, {
      accessToken: "short-user-token",
      tokenType: "bearer",
      expiresIn: 5400,
    });
  });

  it("refuses a short state before building the URL [feature:facebook.auth.oauth_login]", () => {
    assert.throws(
      () =>
        facebookLoginUrl({
          appId: "1000",
          redirectUri: "https://app.example.com/cb",
          state: "short",
          scopes: [],
        }),
      /at least 16/,
    );
  });

  it("exchanges a short-lived token with grant_type=fb_exchange_token [feature:facebook.auth.long_lived]", async () => {
    const { calls, fetch } = fake([
      { access_token: "long-user-token", token_type: "bearer", expires_in: 5183944 },
    ]);

    const token = await exchangeFacebookToken({ ...app, accessToken: "short-user-token", fetch });

    assert.equal(calls[0]?.url.pathname, "/v27.0/oauth/access_token");
    assert.equal(calls[0]?.url.searchParams.get("grant_type"), "fb_exchange_token");
    assert.equal(calls[0]?.url.searchParams.get("fb_exchange_token"), "short-user-token");
    assert.equal(token.accessToken, "long-user-token");
    assert.equal(token.expiresIn, 5183944);
  });

  it("inspects a token with debug_token and reads /me/permissions [feature:facebook.auth.permissions_check]", async () => {
    const { calls, fetch } = fake([
      {
        data: {
          app_id: 1000,
          type: "USER",
          is_valid: true,
          expires_at: 0,
          data_access_expires_at: 1798761600,
          scopes: ["pages_show_list", "pages_manage_posts"],
          granular_scopes: [{ scope: "pages_manage_posts", target_ids: ["123"] }],
          user_id: "42",
        },
      },
      {
        data: [
          { permission: "pages_show_list", status: "granted" },
          { permission: "pages_manage_posts", status: "declined" },
        ],
      },
    ]);

    const info = await inspectFacebookToken({ ...app, inputToken: "user-token", fetch });

    const permissions = await listFacebookPermissions({
      userAccessToken: "user-token",
      fetch,
    });

    assert.equal(calls[0]?.url.pathname, "/v27.0/debug_token");
    assert.equal(calls[0]?.url.searchParams.get("input_token"), "user-token");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer 1000|test-app-secret");
    assert.equal(info.isValid, true);
    assert.equal(info.issuedToThisApp, true);
    assert.equal(info.expiresAt, undefined);
    assert.equal(info.dataAccessExpiresAt, new Date(1798761600 * 1000).toISOString());
    assert.deepEqual(info.granularScopes, [{ scope: "pages_manage_posts", targetIds: ["123"] }]);
    assert.equal(calls[1]?.url.pathname, "/v27.0/me/permissions");
    assert.deepEqual(permissions, {
      granted: ["pages_show_list"],
      declined: ["pages_manage_posts"],
      expired: [],
    });
  });
});

describe("facebook appsecret_proof", () => {
  it("adds the HMAC-SHA256 appsecret_proof to every Graph call [feature:facebook.auth.appsecret_proof]", async () => {
    const expected = createHmac("sha256", "test-app-secret").update("page-token").digest("hex");
    const { calls, fetch } = fake([{ success: true }, { data: [] }]);

    const adapter = facebook({
      auth: { pageId: "123", accessToken: "page-token" },
      appSecret: "test-app-secret",
      fetch,
    });

    await adapter.native?.setLike({ account: page, objectId: "123_1", liked: true, context });

    await discoverFacebookPages({
      userAccessToken: "user-token",
      appSecret: "test-app-secret",
      fetch,
    });

    assert.equal(await facebookAppSecretProof("page-token", "test-app-secret"), expected);
    assert.equal(calls[0]?.url.searchParams.get("appsecret_proof"), expected);
    assert.equal(
      calls[1]?.url.searchParams.get("appsecret_proof"),
      createHmac("sha256", "test-app-secret").update("user-token").digest("hex"),
    );
  });

  it("sends no appsecret_proof without an app secret [feature:facebook.auth.appsecret_proof]", async () => {
    const { calls, fetch } = fake([{ success: true }]);
    const adapter = facebook({ auth: { pageId: "123", accessToken: "page-token" }, fetch });

    await adapter.native?.setLike({ account: page, objectId: "123_1", liked: true, context });

    assert.equal(calls[0]?.url.searchParams.has("appsecret_proof"), false);
  });
});

describe("facebook rate-limit usage headers", () => {
  it("reports X-App-Usage, X-Page-Usage, and X-Business-Use-Case-Usage [feature:facebook.other.rate_limit_headers]", async () => {
    const usage: FacebookRateLimitUsage[] = [];

    const { fetch } = fake([{ success: true }], {
      "X-App-Usage": JSON.stringify({ call_count: 28, total_time: 25, total_cputime: 25 }),
      "X-Page-Usage": JSON.stringify({ call_count: 91, total_time: 10, total_cputime: 12 }),
      "X-Business-Use-Case-Usage": JSON.stringify({
        "123": [
          {
            type: "pages",
            call_count: 100,
            total_cputime: 25,
            total_time: 25,
            estimated_time_to_regain_access: 19,
          },
        ],
      }),
    });

    const adapter = facebook({
      auth: { pageId: "123", accessToken: "page-token" },
      fetch,
      onRateLimitUsage: (reading) => {
        usage.push(reading);
      },
    });

    await adapter.native?.setLike({ account: page, objectId: "123_1", liked: true, context });

    assert.deepEqual(usage, [
      {
        app: { callCount: 28, totalCputime: 25, totalTime: 25 },
        page: { callCount: 91, totalCputime: 12, totalTime: 10 },
        businessUseCase: [
          {
            businessId: "123",
            type: "pages",
            callCount: 100,
            totalCputime: 25,
            totalTime: 25,
            estimatedTimeToRegainAccess: 19,
          },
        ],
      },
    ]);
  });

  it("ignores missing or malformed usage headers and callback errors [feature:facebook.other.rate_limit_headers]", async () => {
    const { calls, fetch } = fake([{ success: true }], {
      "X-App-Usage": JSON.stringify({ call_count: 99 }),
    });

    let observed = 0;

    const adapter = facebook({
      auth: { pageId: "123", accessToken: "page-token" },
      fetch,
      onRateLimitUsage: () => {
        observed += 1;

        throw new Error("observer failed");
      },
    });

    await adapter.native?.setLike({ account: page, objectId: "123_1", liked: true, context });

    assert.equal(observed, 1);
    assert.equal(calls.length, 1);

    assert.equal(parseFacebookRateLimitUsage(new Headers()), undefined);
    assert.equal(parseFacebookRateLimitUsage(new Headers({ "X-App-Usage": "{" })), undefined);
  });
  it("contains a rejected async usage callback without delaying or failing the write", async () => {
    const { calls, fetch } = fake([{ success: true }], {
      "X-App-Usage": JSON.stringify({ call_count: 99 }),
    });

    let rejections = 0;

    const onRejection = () => {
      rejections += 1;
    };

    process.on("unhandledRejection", onRejection);

    try {
      const adapter = facebook({
        auth: { pageId: "123", accessToken: "page-token" },
        fetch,
        onRateLimitUsage: async () => {
          throw new Error("async observer failed");
        },
      });

      await adapter.native?.setLike({ account: page, objectId: "123_1", liked: true, context });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(calls.length, 1);
      assert.equal(rejections, 0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
