import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { connectedAccountRef, SocialError } from "../src/index.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";
import {
  parseTikTokPlayerEvent,
  tiktok,
  tiktokEmbedPlayerUrl,
  tiktokPlayerMessage,
} from "../src/platforms/tiktok.js";
import { parseStoredCredential } from "../src/server/credentials.js";
import {
  checkTikTokQrCode,
  createTikTokQrCode,
  exchangeTikTokQrCode,
  refreshOAuthToken,
  tiktokOAuth,
} from "../src/server/oauth.js";
import type { ConnectionAttempt } from "../src/server/connections.js";

interface Call {
  readonly url: string;
  readonly method: string | undefined;
  readonly contentType: string | null;
  readonly form: Record<string, string>;
}

const json = (body: JsonValue, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function recorder(respond: (url: string) => Response) {
  const calls: Call[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    calls.push({
      url,
      method: init?.method,
      contentType: new Headers(init?.headers).get("content-type"),
      form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
    });

    return respond(url);
  };

  return { calls, fetch };
}

const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-abcdefghijklmnopqrs";

const attempt: ConnectionAttempt = {
  id: "a",
  backend: "direct",
  tenantId: "t",
  principalId: "p",
  platforms: ["tiktok"],
  capabilities: [],
  redirectUri: "http://127.0.0.1:3455/callback/",
  state: "state",
  codeVerifier: verifier,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

describe("TikTok Login Kit for Desktop", () => {
  it("sends a hex SHA-256 code_challenge and code_verifier [feature:tiktok.auth.login_kit_desktop]", async () => {
    const { calls, fetch } = recorder((url) =>
      url.includes("/v2/oauth/token/")
        ? json({ access_token: "act.a", open_id: "creator", expires_in: 7200 })
        : json({ data: { user: { open_id: "creator", display_name: "Ada" } } }),
    );

    const provider = tiktokOAuth({ clientId: "client", tiktokLoginKit: "desktop", fetch });
    const digest = createHash("sha256").update(verifier).digest();

    const started = await provider.start({
      platforms: ["tiktok"],
      capabilities: [],
      redirectUri: attempt.redirectUri,
      state: attempt.state,
      codeChallenge: digest.toString("base64url"),
    });

    const url = new URL(started.authorizationUrl);

    assert.equal(url.searchParams.get("code_challenge"), digest.toString("hex"));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:3455/callback/");

    await provider.complete({
      callbackUrl: `${attempt.redirectUri}?code=auth-code&state=state`,
      attempt,
    });

    assert.equal(calls[0]?.url, "https://open.tiktokapis.com/v2/oauth/token/");
    assert.equal(calls[0]?.form["code_verifier"], verifier);
    assert.equal(calls[0]?.form["client_key"], "client");
  });

  it("refuses non-loopback redirects and the option on other providers [feature:tiktok.auth.login_kit_desktop]", async () => {
    const provider = tiktokOAuth({ clientId: "client", tiktokLoginKit: "desktop" });

    for (const redirectUri of [
      "https://app.test/callback/",
      "http://localhost/callback/",
      "http://127.0.0.1:3455/callback/?next=1",
    ])
      await assert.rejects(
        provider.start({
          platforms: ["tiktok"],
          capabilities: [],
          redirectUri,
          state: "s",
          codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
        }),
        (error: Error) => error instanceof SocialError && error.code === "invalid_input",
      );

    const web = await tiktokOAuth({ clientId: "client" }).start({
      platforms: ["tiktok"],
      capabilities: [],
      redirectUri: "https://app.test/callback/",
      state: "s",
      codeChallenge: "challenge",
    });

    assert.equal(new URL(web.authorizationUrl).searchParams.has("code_challenge"), false);
  });
});

describe("TikTok refresh-token expiry", () => {
  it("maps refresh_expires_in to refreshExpiresAt on both grants", async () => {
    const before = Date.now();

    const { fetch } = recorder((url) =>
      url.includes("/v2/oauth/token/")
        ? json({
            access_token: "act.b",
            refresh_token: "rft.b",
            expires_in: 7200,
            refresh_expires_in: 15_552_000,
            open_id: "creator",
            scope: "user.info.basic,video.publish",
            token_type: "Bearer",
          })
        : json({ data: { user: { open_id: "creator", display_name: "Ada" } } }),
    );

    const refreshed = await refreshOAuthToken(
      "tiktok",
      { clientId: "client", clientSecret: "secret", fetch },
      { accessToken: "act.a", refreshToken: "rft.a" },
    );

    const refreshExpiry = Date.parse(refreshed.refreshExpiresAt ?? "");

    assert.equal(refreshed.refreshToken, "rft.b");
    assert.ok(
      refreshExpiry >= before + 15_552_000_000 && refreshExpiry <= Date.now() + 15_552_000_000,
    );

    // The stored-credential decoder keeps the expiry so credential stores can persist it.
    assert.equal(
      parseStoredCredential({ ...refreshed }).refreshExpiresAt,
      refreshed.refreshExpiresAt,
    );

    const saved: (string | undefined)[] = [];

    const provider = tiktokOAuth({
      clientId: "client",
      clientSecret: "secret",
      fetch,
      credentialSink: {
        async save({ token }) {
          saved.push(token.refreshExpiresAt);
        },
      },
    });

    await provider.complete({
      callbackUrl: "https://app.test/cb?code=c&state=state",
      attempt: { ...attempt, redirectUri: "https://app.test/cb" },
    });

    assert.equal(saved.length, 1);
    assert.ok(Date.parse(saved[0] ?? "") >= before + 15_552_000_000);
  });

  it("keeps the old refresh_expires_in expiry only when the refresh token is kept", async () => {
    const { fetch } = recorder(() =>
      json({ access_token: "act.c", expires_in: 7200, refresh_expires_in: 100 }),
    );

    const current = {
      accessToken: "act.a",
      refreshToken: "rft.a",
      refreshExpiresAt: "2027-01-01T00:00:00.000Z",
    };

    const next = await refreshOAuthToken(
      "tiktok",
      { clientId: "client", clientSecret: "secret", fetch },
      current,
    );

    assert.equal(next.refreshToken, "rft.a");
    assert.equal(next.refreshExpiresAt, "2027-01-01T00:00:00.000Z");

    await assert.rejects(
      refreshOAuthToken(
        "tiktok",
        {
          clientId: "client",
          clientSecret: "secret",
          fetch: async () =>
            json({ access_token: "act.d", refresh_token: "rft.d", refresh_expires_in: -1 }),
        },
        current,
      ),
    );
  });
});

describe("TikTok Login Kit QR code authorization", () => {
  it("creates a QR code via /v2/oauth/get_qrcode/ and sets client_ticket", async () => {
    const { calls, fetch } = recorder(() =>
      json({
        scan_qrcode_url: "https://www.tiktok.com/t/qr?client_ticket=placeholder&next=1",
        token: "qr-token",
      }),
    );

    const qr = await createTikTokQrCode(
      { clientId: "client", fetch },
      { scopes: ["user.info.basic", "video.list"], state: "csrf", clientTicket: "ticket-1" },
    );

    assert.deepEqual(qr, {
      token: "qr-token",
      scanQrCodeUrl: "https://www.tiktok.com/t/qr?client_ticket=ticket-1&next=1",
      clientTicket: "ticket-1",
      state: "csrf",
    });
    assert.equal(calls[0]?.url, "https://open.tiktokapis.com/v2/oauth/get_qrcode/");
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.contentType, "application/x-www-form-urlencoded");
    assert.deepEqual(calls[0]?.form, {
      client_key: "client",
      scope: "user.info.basic,video.list",
      state: "csrf",
    });

    const generated = await createTikTokQrCode({ clientId: "client", fetch });

    assert.match(generated.clientTicket, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      new URL(generated.scanQrCodeUrl).searchParams.get("client_ticket"),
      generated.clientTicket,
    );

    await assert.rejects(
      createTikTokQrCode({ clientId: "client", fetch }, { clientTicket: "has space" }),
      (error: Error) => error instanceof SocialError && error.code === "invalid_input",
    );
  });

  it("polls /v2/oauth/check_qrcode/, verifies client_ticket and exchanges the code", async () => {
    const replies: JsonValue[] = [
      { status: "new", client_ticket: "", scope: "", log_id: "1" },
      { status: "scanned", client_ticket: "ticket-1", log_id: "2" },
      {
        status: "confirmed",
        client_ticket: "ticket-1",
        redirect_uri: "https://app.test/qr-done/?code=auth-code&state=csrf&scopes=user.info.basic",
        log_id: "3",
      },
    ];

    const { calls, fetch } = recorder((url) => {
      if (url.endsWith("/v2/oauth/token/"))
        return json({
          access_token: "act.q",
          refresh_token: "rft.q",
          expires_in: 7200,
          refresh_expires_in: 15_552_000,
          open_id: "creator",
          scope: "user.info.basic",
          token_type: "Bearer",
        });

      return json(replies.shift() ?? {});
    });

    const options = { clientId: "client", clientSecret: "secret", fetch };
    const qr = { token: "qr-token", clientTicket: "ticket-1", state: "csrf" };

    assert.deepEqual(await checkTikTokQrCode(options, qr), { status: "new" });
    assert.deepEqual(await checkTikTokQrCode(options, qr), { status: "scanned" });

    const confirmed = await checkTikTokQrCode(options, qr);

    assert.deepEqual(confirmed, {
      status: "confirmed",
      code: "auth-code",
      redirectUri: "https://app.test/qr-done/",
    });
    assert.equal(calls[0]?.url, "https://open.tiktokapis.com/v2/oauth/check_qrcode/");
    assert.deepEqual(calls[0]?.form, {
      client_key: "client",
      client_secret: "secret",
      token: "qr-token",
    });

    if (confirmed.status !== "confirmed") assert.fail("expected a confirmed QR code");

    const exchanged = await exchangeTikTokQrCode(options, confirmed);

    assert.equal(exchanged.openId, "creator");
    assert.equal(exchanged.token.accessToken, "act.q");
    assert.equal(exchanged.token.refreshToken, "rft.q");
    assert.ok(exchanged.token.refreshExpiresAt !== undefined);
    assert.deepEqual(calls[3]?.form, {
      client_key: "client",
      client_secret: "secret",
      code: "auth-code",
      grant_type: "authorization_code",
      redirect_uri: "https://app.test/qr-done/",
    });
  });

  it("discards check_qrcode responses with a foreign client_ticket or state", async () => {
    const check = (body: JsonValue) =>
      checkTikTokQrCode(
        { clientId: "client", clientSecret: "secret", fetch: async () => json(body) },
        { token: "qr-token", clientTicket: "ticket-1", state: "csrf" },
      );

    const unauthorized = (error: Error) =>
      error instanceof SocialError && error.code === "unauthorized";

    await assert.rejects(check({ status: "scanned", client_ticket: "other" }), unauthorized);
    await assert.rejects(check({ status: "confirmed", code: "c", state: "csrf" }), unauthorized);
    await assert.rejects(
      check({ status: "confirmed", client_ticket: "ticket-1", code: "c", state: "other" }),
      unauthorized,
    );
    assert.deepEqual(
      await check({ status: "confirmed", client_ticket: "ticket-1", code: "c", state: "csrf" }),
      { status: "confirmed", code: "c" },
    );
    assert.deepEqual(await check({ status: "expired", client_ticket: "" }), { status: "expired" });
    await assert.rejects(
      check({ error: "invalid_request", error_description: "bad token", log_id: "l" }),
      (error: Error) => error instanceof SocialError && error.upstreamCode === "invalid_request",
    );
    await assert.rejects(
      checkTikTokQrCode({ clientId: "client" }, { token: "qr-token", clientTicket: "ticket-1" }),
      (error: Error) => error instanceof SocialError && error.code === "invalid_input",
    );
  });
});

describe("TikTok publish cancellation", () => {
  const account = connectedAccountRef({
    backend: "default",
    platform: "tiktok",
    accountId: "creator",
  });

  const context: AdapterOperationContext = {
    backendInstance: "default",
    correlationId: "cancel",
    retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
  };

  it("posts publish_id to /v2/post/publish/cancel/ and maps rejections", async () => {
    const calls: { url: string; method: string | undefined; body: string }[] = [];
    let reply: Response = json({ error: { code: "ok", message: "", log_id: "l" } });

    const adapter = tiktok({
      auth: { accessToken: "fixture", openId: "creator" },
      verifiedMediaOrigins: [],
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: String(init?.body) });

        return reply;
      },
    });

    assert.ok(adapter.native);

    await adapter.native.cancelPublish({ account, publishId: "v_pub_url~v2.123", context });

    assert.equal(calls[0]?.url, "https://open.tiktokapis.com/v2/post/publish/cancel/");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]?.body ?? ""), { publish_id: "v_pub_url~v2.123" });

    reply = json(
      { error: { code: "publish_not_cancellable", message: "final", log_id: "l" } },
      400,
    );

    await assert.rejects(
      adapter.native.cancelPublish({ account, publishId: "v_pub_url~v2.123", context }),
      (error: Error) =>
        error instanceof SocialError && error.upstreamCode === "publish_not_cancellable",
    );

    reply = json({ error: { code: "scope_not_authorized", message: "", log_id: "l" } }, 401);

    await assert.rejects(
      adapter.native.cancelPublish({ account, publishId: "v_pub_url~v2.123", context }),
      (error: Error) => error instanceof SocialError && error.code === "missing_permission",
    );

    await assert.rejects(
      adapter.native.cancelPublish({ account, publishId: " ", context }),
      (error: Error) => error instanceof SocialError && error.code === "invalid_input",
    );
    assert.equal(calls.length, 3);
  });
});

describe("TikTok Embed Player", () => {
  it("builds player/v1 URLs with music_info, native_context_menu and the other options", () => {
    assert.equal(
      tiktokEmbedPlayerUrl("6718335390845095173"),
      "https://www.tiktok.com/player/v1/6718335390845095173",
    );

    const url = new URL(
      tiktokEmbedPlayerUrl("6718335390845095173", {
        controls: false,
        progressBar: false,
        playButton: true,
        volumeControl: false,
        fullscreenButton: false,
        timestamp: false,
        loop: true,
        autoplay: true,
        musicInfo: true,
        description: true,
        rel: false,
        nativeContextMenu: false,
        closedCaption: false,
        forceMuted: true,
      }),
    );

    assert.equal(url.origin + url.pathname, "https://www.tiktok.com/player/v1/6718335390845095173");
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      controls: "0",
      progress_bar: "0",
      play_button: "1",
      volume_control: "0",
      fullscreen_button: "0",
      timestamp: "0",
      loop: "1",
      autoplay: "1",
      music_info: "1",
      description: "1",
      rel: "0",
      native_context_menu: "0",
      closed_caption: "0",
      force_muted: "1",
    });
    assert.throws(() => tiktokEmbedPlayerUrl("../x"), SocialError);
  });

  it("builds player commands and decodes player events", () => {
    assert.deepEqual(tiktokPlayerMessage({ type: "seekTo", value: 12 }), {
      type: "seekTo",
      value: 12,
      "x-tiktok-player": true,
    });
    assert.deepEqual(tiktokPlayerMessage({ type: "mute" }), {
      type: "mute",
      "x-tiktok-player": true,
    });
    assert.throws(() => tiktokPlayerMessage({ type: "navigateTo", value: 1.5 }), SocialError);

    assert.deepEqual(
      parseTikTokPlayerEvent({
        type: "onCurrentTime",
        value: { currentTime: 3, duration: 15 },
        "x-tiktok-player": true,
      }),
      { type: "onCurrentTime", currentTime: 3, duration: 15 },
    );
    assert.deepEqual(
      parseTikTokPlayerEvent({ type: "onStateChange", value: 1, "x-tiktok-player": true }),
      { type: "onStateChange", value: 1 },
    );
    assert.deepEqual(
      parseTikTokPlayerEvent({
        type: "onPlayerError",
        value: { errorCode: 1001, errorType: "INVALID_VIDEO" },
        "x-tiktok-player": true,
      }),
      { type: "onPlayerError", errorCode: 1001, errorType: "INVALID_VIDEO" },
    );
    assert.equal(parseTikTokPlayerEvent({ type: "onStateChange", value: 1 }), undefined);
    assert.equal(parseTikTokPlayerEvent("ready"), undefined);
  });
});
