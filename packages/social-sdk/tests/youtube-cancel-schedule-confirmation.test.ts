import assert from "node:assert/strict";
import { it } from "node:test";
import { SocialError } from "../src/core/errors.js";
import type { JsonValue } from "../src/core/types.js";
import { youtube } from "../src/platforms/youtube.js";

const statuses: readonly [string, JsonValue][] = [
  ["null", null],
  ["array", []],
  ["string", "private"],
  ["empty object", {}],
];

for (const [label, status] of statuses)
  it(`schedule cancellation answered with a ${label} status stays uncertain`, async () => {
    const methods: string[] = [];

    const adapter = youtube({
      auth: { accessToken: "fixture-only", channelId: "channel1" },
      clock: () => new Date("2026-11-05T00:00:00Z"),
      fetch: async (_input, init) => {
        methods.push(init?.method ?? "GET");

        return Response.json(
          init?.method === "PUT"
            ? { id: "video1", status }
            : {
                items: [
                  {
                    id: "video1",
                    snippet: { channelId: "channel1" },
                    status: {
                      privacyStatus: "private",
                      publishAt: "2030-01-01T00:00:00Z",
                      selfDeclaredMadeForKids: false,
                    },
                  },
                ],
              },
        );
      },
    });

    const cancelScheduled = adapter.posts?.cancelScheduled;

    assert.ok(cancelScheduled);

    await assert.rejects(
      cancelScheduled(
        {
          kind: "scheduled-job",
          version: 1,
          backend: "default",
          platform: "youtube",
          accountId: "channel1",
          jobId: "video1",
        },
        {
          backendInstance: "default",
          correlationId: "cancel-confirmation",
          retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
        },
      ),
      (error: SocialError) =>
        error instanceof SocialError &&
        error.code === "ambiguous_outcome" &&
        error.retryDisposition?.kind === "reconcile-first",
    );
    assert.deepEqual(methods, ["GET", "PUT"]);
  });
