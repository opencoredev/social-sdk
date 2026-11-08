import assert from "node:assert/strict";
import { test } from "node:test";

import { POST } from "./api/cloud-waitlist";
import { formBody, parseSignup, trapField, type Signup } from "./cloud-waitlist";
import {
  handleWaitlistPost,
  type Admission,
  type MailDomain,
  type WaitlistServices,
} from "./cloud-waitlist-server";

test("parses a full signup, normalizing the email and ordering platforms like the form", () => {
  const parsed = parseSignup({
    email: "  Dev@Example.COM ",
    platforms: ["youtube", "x", "x", "other"],
    otherPlatforms: " Mastodon ",
    accounts: "11-50",
    currentTool: "  our own cron job  ",
    cameFrom: "/guides/threads-api",
    elapsedMs: 8123.4,
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
      elapsedMs: 8123,
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
      elapsedMs: null,
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
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "invalid",
    field: "email",
    reason: "format",
  });
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

test("the endpoint stops reading a streamed body once it passes the limit", async () => {
  let pulled = 0;
  const chunk = new TextEncoder().encode("x".repeat(4096));

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1;

      if (pulled > 50) controller.close();
      else controller.enqueue(chunk);
    },
  });

  const response = await POST(
    new Request(endpoint, {
      method: "POST",
      body: stream,
      headers: { "content-type": "application/json" },
    }),
  );

  assert.equal(response.status, 413);
  assert.ok(pulled < 10, `read ${pulled} chunks`);
});

test("rejects well-known throwaway inboxes", () => {
  assert.deepEqual(parseSignup({ email: "x@Mailinator.com" }), { kind: "throwaway-email" });
});

type FakeWorld = {
  services: WaitlistServices;
  stored: Signup[];
  admitted: string[];
  checkedDomains: string[];
};

function fakeWorld(answers: { admission?: Admission; mailDomain?: MailDomain } = {}): FakeWorld {
  const world: FakeWorld = {
    stored: [],
    admitted: [],
    checkedDomains: [],
    services: {
      admit: async (client) => {
        world.admitted.push(client);

        return answers.admission ?? "admitted";
      },
      checkMailDomain: async (domain) => {
        world.checkedDomains.push(domain);

        return answers.mailDomain ?? "receives-mail";
      },
      store: async (signup) => {
        world.stored.push(signup);
      },
    },
  };

  return world;
}

function signupRequest(body: string, contentType = "application/json"): Request {
  return new Request(endpoint, {
    method: "POST",
    body,
    headers: { "content-type": contentType, "x-vercel-forwarded-for": "203.0.113.7, 10.0.0.1" },
  });
}

const person = { email: "dev@company.dev", platforms: ["x"], elapsedMs: 9000 };

test("a person's signup is rate-checked by address, domain-checked, and stored", async () => {
  const world = fakeWorld();
  const response = await handleWaitlistPost(signupRequest(JSON.stringify(person)), world.services);

  assert.equal(response.status, 200);
  assert.deepEqual(world.admitted, ["203.0.113.7"]);
  assert.deepEqual(world.checkedDomains, ["company.dev"]);
  assert.equal(world.stored.length, 1);
  assert.equal(world.stored[0]?.email, "dev@company.dev");
});

test("a submit faster than a person, or a JSON post without timing, stores nothing", async () => {
  for (const body of [{ ...person, elapsedMs: 300 }, { email: "dev@company.dev" }]) {
    const world = fakeWorld();
    const response = await handleWaitlistPost(signupRequest(JSON.stringify(body)), world.services);

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { ok: false, error: "too-fast" });
    assert.equal(world.stored.length, 0);
    assert.equal(world.admitted.length, 0);
  }
});

test("a form post without JavaScript has no timing and still goes through", async () => {
  const world = fakeWorld();

  const response = await handleWaitlistPost(
    signupRequest("email=dev%40company.dev", "application/x-www-form-urlencoded"),
    world.services,
  );

  assert.equal(response.headers.get("location"), "https://social-sdk.dev/cloud#joined");
  assert.equal(world.stored.length, 1);
});

test("over the hourly limit, nothing is stored and the domain isn't looked up", async () => {
  const world = fakeWorld({ admission: "limited" });
  const response = await handleWaitlistPost(signupRequest(JSON.stringify(person)), world.services);

  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { ok: false, error: "rate-limited" });
  assert.equal(world.checkedDomains.length, 0);
  assert.equal(world.stored.length, 0);
});

test("an email domain that can't receive mail is refused", async () => {
  const world = fakeWorld({ mailDomain: "no-mail" });
  const response = await handleWaitlistPost(signupRequest(JSON.stringify(person)), world.services);

  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "invalid",
    field: "email",
    reason: "no-mail",
  });
  assert.equal(world.stored.length, 0);
});

test("a throwaway inbox is refused before any lookup", async () => {
  const world = fakeWorld();

  const response = await handleWaitlistPost(
    signupRequest(JSON.stringify({ ...person, email: "x@yopmail.com" })),
    world.services,
  );

  assert.equal(response.status, 422);
  assert.equal((await response.json()).reason, "throwaway");
  assert.equal(world.admitted.length, 0);
});

test("a database failure answers 503 without echoing the signup", async () => {
  const world = fakeWorld();

  world.services.store = async () => {
    throw new Error("duplicate key value (email)=(dev@company.dev)");
  };

  const response = await handleWaitlistPost(signupRequest(JSON.stringify(person)), world.services);
  const text = await response.text();

  assert.equal(response.status, 503);
  assert.ok(!text.includes("company.dev"));
});
