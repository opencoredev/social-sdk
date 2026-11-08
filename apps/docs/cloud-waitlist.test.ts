import assert from "node:assert/strict";
import { test } from "node:test";

import { POST } from "./api/cloud-waitlist";
import { formBody, parseSignup, trapField } from "./cloud-waitlist";

test("parses a full signup, normalizing the email and ordering platforms like the form", () => {
  const parsed = parseSignup({
    email: "  Dev@Example.COM ",
    platforms: ["youtube", "x", "x", "other"],
    otherPlatforms: " Mastodon ",
    accounts: "11-50",
    currentTool: "  our own cron job  ",
    cameFrom: "/guides/threads-api",
  });

  assert.deepEqual(parsed, {
    kind: "signup",
    signup: {
      email: "dev@example.com",
      platforms: ["x", "youtube", "other"],
      otherPlatforms: "Mastodon",
      accounts: "11-50",
      currentTool: "our own cron job",
      cameFrom: "/guides/threads-api",
    },
  });
});

test("only the email is required", () => {
  assert.deepEqual(parseSignup({ email: "a@b.co" }), {
    kind: "signup",
    signup: {
      email: "a@b.co",
      platforms: [],
      otherPlatforms: null,
      accounts: null,
      currentTool: null,
      cameFrom: null,
    },
  });
});

test("drops other platforms unless Other is ticked, and drops off-site referrers", () => {
  const parsed = parseSignup({
    email: "a@b.co",
    platforms: ["x"],
    otherPlatforms: "Mastodon",
    cameFrom: "//evil.example/path",
  });

  assert.equal(parsed.kind, "signup");

  if (parsed.kind !== "signup") return;
  assert.equal(parsed.signup.otherPlatforms, null);
  assert.equal(parsed.signup.cameFrom, null);
});

test("names the field a bad submission is about", () => {
  const cases = [
    [{ email: "not-an-email" }, "email"],
    [{ email: "a@b" }, "email"],
    [{ email: `${"a".repeat(250)}@b.co` }, "email"],
    [{ email: "a@b.co", platforms: ["x", "myspace"] }, "platforms"],
    [{ email: "a@b.co", platforms: 3 }, "platforms"],
    [{ email: "a@b.co", platforms: ["other"], otherPlatforms: "x".repeat(201) }, "otherPlatforms"],
    [{ email: "a@b.co", accounts: "a million" }, "accounts"],
    [{ email: "a@b.co", currentTool: "x".repeat(1001) }, "currentTool"],
    [{ email: "a@b.co", currentTool: "nul\u0000byte" }, "currentTool"],
    [["a@b.co"], "email"],
  ] as const;

  for (const [body, field] of cases)
    assert.deepEqual(parseSignup(body), { kind: "invalid", field });
});

test("keeps line breaks in the free-text answer", () => {
  const parsed = parseSignup({ email: "a@b.co", currentTool: "line one\nline two" });

  assert.equal(
    parsed.kind === "signup" ? parsed.signup.currentTool : undefined,
    "line one\nline two",
  );
});

test("treats a filled trap field as a bot", () => {
  assert.deepEqual(parseSignup({ email: "a@b.co", [trapField]: "https://spam.example" }), {
    kind: "trap",
  });
});

test("reads a urlencoded form post like the JSON body", () => {
  const body = formBody(
    new URLSearchParams("email=a%40b.co&platforms=x&platforms=threads&accounts=1&currentTool="),
  );

  assert.deepEqual(body, {
    email: "a@b.co",
    platforms: ["x", "threads"],
    accounts: "1",
    currentTool: "",
  });
  assert.equal(parseSignup(body).kind, "signup");
});

const endpoint = "https://social-sdk.dev/api/cloud-waitlist";

function post(body: string, headers: HeadersInit): Promise<Response> {
  return POST(new Request(endpoint, { method: "POST", body, headers }));
}

test("the endpoint refuses bodies that aren't JSON or a form", async () => {
  const response = await post("email=a@b.co", { "content-type": "text/plain" });

  assert.equal(response.status, 415);
});

test("the endpoint refuses other sites", async () => {
  const response = await post(JSON.stringify({ email: "a@b.co" }), {
    "content-type": "application/json",
    origin: "https://elsewhere.example",
  });

  assert.equal(response.status, 403);
});

test("the endpoint refuses oversized and malformed bodies", async () => {
  const large = await post(JSON.stringify({ email: "a@b.co", currentTool: "x".repeat(9000) }), {
    "content-type": "application/json",
  });

  assert.equal(large.status, 413);

  const malformed = await post("{", { "content-type": "application/json" });

  assert.equal(malformed.status, 400);
});

test("the endpoint answers an invalid field with 422 and the field name", async () => {
  const response = await post(JSON.stringify({ email: "nope" }), {
    "content-type": "application/json",
    origin: "https://social-sdk.dev",
  });

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { ok: false, error: "invalid", field: "email" });
});

test("the endpoint answers a bot like a signup without touching the database", async () => {
  const response = await post(JSON.stringify({ email: "a@b.co", [trapField]: "x" }), {
    "content-type": "application/json",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("a form post without JavaScript is sent back to the page", async () => {
  const response = await post("email=nope", {
    "content-type": "application/x-www-form-urlencoded",
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "https://social-sdk.dev/cloud#join-error");
});
