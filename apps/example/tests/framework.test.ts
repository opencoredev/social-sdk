import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createExampleHandler } from "../src/app.js";
import { createHonoFetch } from "../src/frameworks/hono.js";
import { createNextRoute } from "../src/frameworks/next-route.js";
import { openExampleDatabase } from "../src/storage.js";

// Each PGlite open runs the migrations and takes over a second, so every handler shares one.
const database = await openExampleDatabase();

after(() => database.close());

// A key per framework, so the shared database never replays another framework's publish.
const publishBody = (framework: string) =>
  JSON.stringify({
    accountIds: ["mock-account-1"],
    text: "hello",
    idempotencyKey: `framework-test-${framework}`,
  });

const request = (url: string, method = "GET", body?: string) => {
  const headers = new Headers({ host: "localhost:3030" });
  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = body;
  }

  return new Request(`http://localhost:3030${url}`, init);
};

for (const [name, call] of [
  [
    "next catch-all",
    async (path: string, method: string, body?: string) =>
      createNextRoute(createExampleHandler({ database }))[method === "GET" ? "GET" : "POST"](
        request(`/api/social${path}`, method, body),
      ),
  ],
  [
    "hono mounted fetch",
    async (path: string, method: string, body?: string) =>
      createHonoFetch(createExampleHandler({ database }))(request(`/social${path}`, method, body)),
  ],
] as const) {
  describe(name, () => {
    test("maps account listing and publish to the example API", async () => {
      const accounts = await call("/accounts", "GET");
      assert.equal(accounts.status, 200);
      const published = await call("/publish", "POST", publishBody(name));
      assert.equal(published.status, 200);
      assert.equal((await published.json()).result.outcomes[0].state, "published");
    });
    test("preserves tenant denial through the mounted route", async () => {
      const denied =
        name === "next catch-all"
          ? await createNextRoute(
              createExampleHandler({
                database,
                session: { principal: "other", tenantId: "other" },
                membership: () => false,
              }),
            ).POST(request("/api/social/publish", "POST", publishBody(name)))
          : await createHonoFetch(
              createExampleHandler({
                database,
                session: { principal: "other", tenantId: "other" },
                membership: () => false,
              }),
            )(request("/social/publish", "POST", publishBody(name)));

      assert.equal(denied.status, 403);
    });
  });
}
