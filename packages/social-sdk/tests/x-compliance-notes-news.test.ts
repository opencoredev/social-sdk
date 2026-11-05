import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef, type AdapterOperationContext } from "../src/index.js";
import type { JsonValue } from "../src/core/types.js";
import { x } from "../src/platforms/x.js";

const account = connectedAccountRef({ backend: "default", platform: "x", accountId: "11" });

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "x-compliance-notes-news",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 10_000 },
};

interface Seen {
  readonly method: string;
  readonly href: string;
  readonly authorization: string | null;
  readonly body: string | undefined;
}

function fake(
  routes: Readonly<Record<string, JsonValue>>,
  raw: Readonly<Record<string, () => Response>> = {},
) {
  const seen: Seen[] = [];

  const adapter = x({
    auth: { userId: "11", accessToken: "user" },
    appBearerToken: "app",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      seen.push({
        method,
        href: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
        body: init?.body === undefined || init.body === null ? undefined : String(init.body),
      });

      const key = `${method} ${url.host}${url.pathname}`;

      const respond = raw[key];

      if (respond !== undefined) return respond();

      const route = routes[key];

      return route === undefined
        ? Response.json({ title: "Not Found" }, { status: 404 })
        : Response.json(route);
    },
  });

  assert.ok(adapter.native);

  return { native: adapter.native, seen };
}

const job = {
  id: "1423095206576984067",
  type: "tweets",
  status: "created",
  name: "nightly",
  resumable: false,
  created_at: "2026-11-04T10:00:00.000Z",
  upload_url: "https://storage.googleapis.com/upload?signature=abc",
  upload_expires_at: "2026-11-04T10:15:00.000Z",
  download_url: "https://storage.googleapis.com/download?signature=def",
  download_expires_at: "2026-11-11T10:00:00.000Z",
};

it("creates, lists, reads and cancels batch compliance jobs at /2/compliance/jobs", async () => {
  const { native, seen } = fake({
    "POST api.x.com/2/compliance/jobs": { data: job },
    "GET api.x.com/2/compliance/jobs": { data: [job], meta: { result_count: 1 } },
    "GET api.x.com/2/compliance/jobs/1423095206576984067": { data: job },
    "DELETE api.x.com/2/compliance/jobs/1423095206576984067": {
      data: { ...job, status: "failed" },
    },
  });

  const created = await native.createComplianceJob({
    account,
    type: "tweets",
    name: "nightly",
    context,
  });

  assert.deepEqual(created, {
    id: "1423095206576984067",
    type: "tweets",
    status: "created",
    name: "nightly",
    resumable: false,
    createdAt: "2026-11-04T10:00:00.000Z",
    uploadUrl: "https://storage.googleapis.com/upload?signature=abc",
    uploadExpiresAt: "2026-11-04T10:15:00.000Z",
    downloadUrl: "https://storage.googleapis.com/download?signature=def",
    downloadExpiresAt: "2026-11-11T10:00:00.000Z",
  });
  assert.equal(seen[0]?.authorization, "Bearer app");
  assert.deepEqual(JSON.parse(seen[0]?.body ?? "null"), { type: "tweets", name: "nightly" });

  const jobs = await native.complianceJobs({ account, type: "tweets", status: "created", context });

  assert.equal(jobs.length, 1);

  const listUrl = new URL(seen[1]?.href ?? "");

  assert.equal(listUrl.searchParams.get("type"), "tweets");
  assert.equal(listUrl.searchParams.get("status"), "created");

  assert.equal(
    (await native.getComplianceJob({ account, jobId: job.id, context })).status,
    "created",
  );
  assert.equal(
    (await native.cancelComplianceJob({ account, jobId: job.id, context })).status,
    "failed",
  );
  assert.equal(seen[3]?.method, "DELETE");
});

it("uploads IDs to the signed upload_url and parses newline-delimited results", async () => {
  const { native, seen } = fake(
    {},
    {
      "PUT storage.googleapis.com/upload": () => new Response(null, { status: 200 }),
      "GET storage.googleapis.com/download": () =>
        new Response(
          '{"id":"1700000000000000000","action":"delete","reason":"deleted"}\n{"id":"1700000000000000001","action":"delete","reason":"protected"}\n',
        ),
    },
  );

  await native.uploadComplianceIds({
    account,
    job: { uploadUrl: job.upload_url },
    ids: ["1700000000000000000", "1700000000000000001"],
    context,
  });

  assert.deepEqual(seen[0], {
    method: "PUT",
    href: job.upload_url,
    authorization: null,
    body: "1700000000000000000\n1700000000000000001",
  });

  const results = await native.downloadComplianceResults({
    account,
    job: { downloadUrl: job.download_url },
    context,
  });

  assert.deepEqual(results, [
    { id: "1700000000000000000", action: "delete", reason: "deleted" },
    { id: "1700000000000000001", action: "delete", reason: "protected" },
  ]);
  assert.equal(seen[1]?.authorization, null);

  await assert.rejects(
    native.uploadComplianceIds({
      account,
      job: { uploadUrl: "http://example.com/upload" },
      ids: ["1"],
      context,
    }),
    { code: "invalid_input" },
  );
});

it("sends the app bearer to X-hosted compliance upload and download routes", async () => {
  const { native, seen } = fake(
    { "PUT api.x.com/2/compliance/jobs/1423095206576984067/upload": { data: job } },
    { "GET api.x.com/2/compliance/jobs/1423095206576984067/download": () => new Response("") },
  );

  await native.uploadComplianceIds({
    account,
    job: { uploadUrl: "https://api.x.com/2/compliance/jobs/1423095206576984067/upload?token=t" },
    ids: ["12"],
    context,
  });
  await native.downloadComplianceResults({
    account,
    job: {
      downloadUrl: "https://api.x.com/2/compliance/jobs/1423095206576984067/download?token=t",
    },
    context,
  });

  assert.deepEqual(
    seen.map((request) => request.authorization),
    ["Bearer app", "Bearer app"],
  );
});

it("creates, evaluates, lists and deletes Community Notes through /2/notes", async () => {
  const { native, seen } = fake({
    "POST api.x.com/2/notes": { data: { id: "1500000000000000000" } },
    "POST api.x.com/2/notes/evaluate": { data: { claim_opinion_score: 0.82 } },
    "DELETE api.x.com/2/notes/1500000000000000000": { data: { deleted: true } },
    "GET api.x.com/2/notes/search/notes_written": {
      data: [{ id: "1500000000000000000", status: "needs_more_ratings" }],
      meta: { next_token: "n1" },
    },
    "GET api.x.com/2/notes/search/posts_eligible_for_notes": {
      data: [{ id: "1700000000000000000", text: "claim" }],
    },
  });

  const created = await native.createCommunityNote({
    account,
    note: {
      postId: "1700000000000000000",
      text: "The figure is from 2019, not 2026. https://example.com/report",
      classification: "misinformed_or_potentially_misleading",
      misleadingTags: ["outdated_information"],
      trustworthySources: true,
      testMode: true,
    },
    context,
  });

  assert.deepEqual(created, { noteId: "1500000000000000000" });
  assert.equal(seen[0]?.authorization, "Bearer user");
  assert.deepEqual(JSON.parse(seen[0]?.body ?? "null"), {
    post_id: "1700000000000000000",
    test_mode: true,
    info: {
      text: "The figure is from 2019, not 2026. https://example.com/report",
      classification: "misinformed_or_potentially_misleading",
      misleading_tags: ["outdated_information"],
      trustworthy_sources: true,
    },
  });

  assert.deepEqual(
    await native.evaluateCommunityNote({
      account,
      postId: "1700000000000000000",
      text: "Draft",
      context,
    }),
    { claimOpinionScore: 0.82 },
  );
  assert.deepEqual(JSON.parse(seen[1]?.body ?? "null"), {
    post_id: "1700000000000000000",
    note_text: "Draft",
  });

  const written = await native.communityNotesWritten({
    account,
    testMode: true,
    limit: 5,
    context,
  });

  assert.equal(written.nextCursor, "n1");
  assert.equal(new URL(seen[2]?.href ?? "").searchParams.get("test_mode"), "true");

  const eligible = await native.postsEligibleForNotes({ account, testMode: false, context });

  assert.equal(eligible.items.length, 1);
  assert.equal(new URL(seen[3]?.href ?? "").searchParams.get("test_mode"), "false");

  await native.deleteCommunityNote({ account, noteId: "1500000000000000000", context });

  await assert.rejects(
    native.createCommunityNote({
      account,
      note: {
        postId: "1700000000000000000",
        text: "No link here",
        classification: "not_misleading",
        misleadingTags: [],
        trustworthySources: false,
        testMode: true,
      },
      context,
    }),
    { code: "invalid_input" },
  );
  assert.equal(seen.length, 5);
});

it("searches and reads X News stories at /2/news/", async () => {
  const { native, seen } = fake({
    "GET api.x.com/2/news/search": {
      data: [{ id: "1800000000000000000", name: "Launch day" }],
      meta: { result_count: 1 },
    },
    "GET api.x.com/2/news/1800000000000000000": {
      data: { id: "1800000000000000000", name: "Launch day", summary: "Summary" },
    },
  });

  const page = await native.searchNews({
    account,
    query: "rocket launch",
    maxAgeHours: 24,
    limit: 10,
    newsFields: ["id", "name"],
    context,
  });

  assert.deepEqual(page.items, [{ id: "1800000000000000000", name: "Launch day" }]);

  const searchUrl = new URL(seen[0]?.href ?? "");

  assert.equal(searchUrl.searchParams.get("query"), "rocket launch");
  assert.equal(searchUrl.searchParams.get("max_age_hours"), "24");
  assert.equal(searchUrl.searchParams.get("max_results"), "10");
  assert.equal(searchUrl.searchParams.get("news.fields"), "id,name");

  const story = await native.getNews({ account, newsId: "1800000000000000000", context });

  assert.equal(story["summary"], "Summary");

  await assert.rejects(native.searchNews({ account, query: "x", maxAgeHours: 721, context }), {
    code: "invalid_input",
  });
});
