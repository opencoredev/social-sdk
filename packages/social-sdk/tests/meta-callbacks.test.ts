import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { SocialError } from "../src/core/errors.js";
import {
  createMetaDataDeletionHandler,
  createMetaDeauthorizeHandler,
  verifyMetaSignedRequest,
  type MetaSignedRequest,
} from "../src/server/webhooks.js";

const appSecret = "meta-app-secret";

const issuedAt = Date.parse("2026-10-24T12:00:00.000Z") / 1000;

const now = () => new Date("2026-10-24T12:05:00.000Z");

function encode(text: string): string {
  return Buffer.from(text).toString("base64url");
}

function sign(payload: string, secret = appSecret): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signedRequest(
  fields: Readonly<Record<string, string | number>> = {},
  secret = appSecret,
): string {
  const payload = encode(
    JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: issuedAt, user_id: "218471", ...fields }),
  );

  return `${sign(payload, secret)}.${payload}`;
}

function post(body: string, contentType = "application/x-www-form-urlencoded"): Request {
  return new Request("https://app.test/meta/deletion", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
}

function form(value: string): string {
  return new URLSearchParams({ signed_request: value }).toString();
}

it("verifies a signed request and derives a stable request ID", async () => {
  const value = signedRequest();
  const verified = await verifyMetaSignedRequest({ appSecret, signedRequest: value, now });
  const again = await verifyMetaSignedRequest({ appSecret, signedRequest: value, now });

  assert.equal(verified.userId, "218471");
  assert.equal(verified.algorithm, "HMAC-SHA256");
  assert.equal(verified.issuedAt, "2026-10-24T12:00:00.000Z");
  assert.match(verified.requestId, /^[0-9a-f]{64}$/);
  assert.equal(again.requestId, verified.requestId);
});

it("rejects tampered payloads, wrong secrets, and other algorithms", async () => {
  const original = signedRequest();
  const [signature] = original.split(".");
  const tampered = `${signature}.${encode(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: issuedAt, user_id: "999" }))}`;

  for (const value of [
    tampered,
    signedRequest({}, "other-secret"),
    signedRequest({ algorithm: "HMAC-SHA1" }),
    signedRequest({ algorithm: "hmac-sha256" }),
  ])
    await assert.rejects(
      verifyMetaSignedRequest({ appSecret, signedRequest: value, now }),
      (error) => error instanceof SocialError && error.code === "unauthorized",
    );
});

it("rejects non-canonical encodings and malformed payloads", async () => {
  const valid = signedRequest();
  const [signature = "", payload = ""] = valid.split(".");
  const padded = `${signature}=.${payload}`;
  const standard = `+${signature.slice(1)}.${payload}`;
  // Flip the unused low bits of the last character: same bytes, non-canonical text.
  const last = signature.at(-1) ?? "A";
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const loose = `${signature.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}.${payload}`;
  const notJson = encode("not json");

  for (const value of [
    padded,
    standard,
    loose,
    `${signature}`,
    `${signature}.${payload}.extra`,
    `${sign(notJson)}.${notJson}`,
    signedRequest({ user_id: "not-a-number" }),
    signedRequest({ issued_at: "soon" }),
  ])
    await assert.rejects(
      verifyMetaSignedRequest({ appSecret, signedRequest: value, now }),
      (error) =>
        error instanceof SocialError &&
        (error.code === "invalid_input" || error.code === "unauthorized") &&
        !error.message.includes(payload),
    );

  const missingUser = encode(JSON.stringify({ algorithm: "HMAC-SHA256", issued_at: issuedAt }));

  await assert.rejects(
    verifyMetaSignedRequest({
      appSecret,
      signedRequest: `${sign(missingUser)}.${missingUser}`,
      now,
    }),
    (error) => error instanceof SocialError && error.code === "invalid_input",
  );
});

it("rejects stale and future timestamps", async () => {
  for (const issued of [issuedAt - 2 * 60 * 60, issuedAt + 60 * 60])
    await assert.rejects(
      verifyMetaSignedRequest({
        appSecret,
        signedRequest: signedRequest({ issued_at: issued }),
        now,
      }),
      (error) => error instanceof SocialError && error.code === "unauthorized",
    );
});

it("deauthorize handler records the request and answers 200", async () => {
  const seen: MetaSignedRequest[] = [];

  const handler = createMetaDeauthorizeHandler({
    appSecret,
    now,
    onDeauthorize: async (request) => {
      seen.push(request);
    },
  });

  const response = await handler(post(form(signedRequest())));

  assert.equal(response.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.userId, "218471");
});

it("data deletion handler returns the receipt only after the callback accepts", async () => {
  const handler = createMetaDataDeletionHandler({
    appSecret,
    now,
    onDataDeletion: async (request) => ({
      statusUrl: `https://app.test/deletion/${request.requestId.slice(0, 12)}`,
      confirmationCode: "DEL-123",
    }),
  });

  const value = signedRequest();
  const response = await handler(post(form(value)));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body: unknown = JSON.parse(await response.text());
  const { requestId } = await verifyMetaSignedRequest({ appSecret, signedRequest: value, now });

  assert.deepEqual(body, {
    url: `https://app.test/deletion/${requestId.slice(0, 12)}`,
    confirmation_code: "DEL-123",
  });
});

it("data deletion handler refuses unsafe receipts and callback failures without leaking", async () => {
  const value = signedRequest();

  for (const onDataDeletion of [
    async () => ({ statusUrl: "http://app.test/status", confirmationCode: "ok" }),
    async () => ({ statusUrl: "https://user:pw@app.test/status", confirmationCode: "ok" }),
    async () => ({ statusUrl: "https://app.test/status", confirmationCode: "bad code!" }),
    async () => {
      throw new Error(`database said ${value}`);
    },
  ]) {
    const response = await createMetaDataDeletionHandler({ appSecret, now, onDataDeletion })(
      post(form(value)),
    );

    assert.equal(response.status, 500);
    const text = await response.text();
    assert.ok(!text.includes(value));
    assert.ok(!text.includes("confirmation_code"));
  }
});

it("handlers refuse wrong methods, media types, oversize bodies, and extra fields", async () => {
  let calls = 0;

  const handler = createMetaDeauthorizeHandler({
    appSecret,
    now,
    onDeauthorize: async () => {
      calls++;
    },
  });

  const value = signedRequest();

  const get = await handler(new Request("https://app.test/meta/deauthorize"));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST");
  assert.equal((await handler(post(form(value), "application/json"))).status, 415);
  assert.equal((await handler(post(form(value) + "&x=" + "a".repeat(20_000)))).status, 413);
  assert.equal((await handler(post(`${form(value)}&${form(value)}`))).status, 400);
  assert.equal((await handler(post(`${form(value)}&extra=1`))).status, 400);
  assert.equal((await handler(post(""))).status, 400);

  const forged = await handler(post(form(signedRequest({}, "wrong"))));
  assert.equal(forged.status, 401);
  assert.ok(!(await forged.text()).includes(value.split(".")[1] ?? "-"));
  assert.equal(calls, 0);
});

it("refuses an empty app secret at construction", () => {
  assert.throws(() =>
    createMetaDeauthorizeHandler({ appSecret: "", onDeauthorize: async () => {} }),
  );
  assert.throws(() =>
    createMetaDataDeletionHandler({
      appSecret: "",
      onDataDeletion: async () => ({ statusUrl: "https://app.test/s", confirmationCode: "c" }),
    }),
  );
});
