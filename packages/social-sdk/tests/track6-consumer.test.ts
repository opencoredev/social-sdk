import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import {
  bytes,
  connectedAccountRef,
  createSocial,
  defineAdapter,
  platformPostRef,
  type PublishRequest,
  type StagedMedia,
} from "../src/index.js";
import { instagram } from "../src/platforms/instagram.js";
import { tiktok } from "../src/platforms/tiktok.js";
import { parseJson } from "../src/transport/json.js";
import { array, object } from "../src/transport/validation.js";

function urlAdapter() {
  return defineAdapter({
    id: "fixture",
    capabilities: {
      schemaVersion: 1,
      backend: "fixture",
      apiRevision: "fixture",
      runtime: ["node"],
      capabilities: [
        {
          operation: "posts.publish",
          platform: "instagram",
          availability: "available",
          constraints: { mediaSources: ["https-url"] },
        },
      ],
    },
    posts: {
      prepareTarget: () => [],
      publishTarget: async (target) => ({
        state: "published",
        targetIndex: target.targetIndex,
        account: target.account,
        observedAt: "t",
        post: platformPostRef({ ...target.account, postId: "p1" }),
      }),
    },
  });
}

it("a synchronously throwing storage cleanup cannot replace a published outcome", async () => {
  const social = createSocial({
    backend: urlAdapter(),
    mediaStaging: {
      stageMedia: async () => ({
        url: "https://media.example.test/image.jpg",
        cleanup: () => {
          throw new Error("storage unavailable");
        },
      }),
    },
  });

  const result = await social.posts.publish({
    targets: [
      {
        account: connectedAccountRef({
          backend: "default",
          platform: "instagram",
          accountId: "ig1",
        }),
      },
    ],
    content: { media: [{ kind: "image", source: await bytes(new Uint8Array([1])) }] },
  });

  assert.equal(result.outcomes[0]?.state, "published");
});

it("staging respects the publish budget and cleans a late result without submitting it", async () => {
  let finish: (value: StagedMedia) => void = () => {
    throw new Error("stage did not start");
  };

  let cleaned = 0;

  const pending = new Promise<StagedMedia>((resolve) => {
    finish = resolve;
  });

  const social = createSocial({
    backend: urlAdapter(),
    mediaStaging: { stageMedia: async () => pending },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      social.posts.publish(
        {
          targets: [
            {
              account: connectedAccountRef({
                backend: "default",
                platform: "instagram",
                accountId: "ig1",
              }),
            },
          ],
          content: { media: [{ kind: "image", source: await bytes(new Uint8Array([1])) }] },
        },
        { retryBudget: { maxAttempts: 1, maxElapsedMs: 20 } },
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("staging exceeded budget")), 500);
      }),
    ]);

    assert.equal(result.outcomes[0]?.state, "not-submitted");
  } finally {
    clearTimeout(timer);
    finish({
      url: "https://media.example.test/late.jpg",
      cleanup: async () => {
        cleaned++;
      },
    });
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleaned, 1);
});

it("aggregate inbox pagination retains pages when several sources have long cursors", async () => {
  const upstreamCursor = "%".repeat(3000);

  const adapter = defineAdapter({
    id: "fixture",
    capabilities: {
      schemaVersion: 1,
      backend: "fixture",
      apiRevision: "fixture",
      runtime: ["node"],
      capabilities: [
        { operation: "messages.read", platform: "instagram", availability: "available" },
      ],
    },
    messages: {
      listConversations: async (account, options) =>
        options?.cursor === undefined
          ? { items: [{ id: `${account.accountId}-first` }], nextCursor: upstreamCursor }
          : { items: [{ id: `${account.accountId}-last` }] },
      listMessages: async () => ({ items: [] }),
      send: async () => {
        throw new Error("read only");
      },
    },
  });

  const social = createSocial({ backend: adapter });

  const accounts = ["a", "b", "c"].map((accountId) =>
    connectedAccountRef({ backend: "default", platform: "instagram", accountId }),
  );

  const first = await social.inbox.list({ accounts });
  assert.deepEqual(
    first.entries.map((entry) => entry.record.id),
    ["a-first", "b-first", "c-first"],
  );
  assert.ok(first.nextCursor);
  const last = await social.inbox.list({ accounts, cursor: first.nextCursor });
  assert.deepEqual(
    last.entries.map((entry) => entry.record.id),
    ["a-last", "b-last", "c-last"],
  );
  assert.equal(last.nextCursor, undefined);
});

it("cross-posts one local image through staging to Instagram and TikTok photo publishing", async () => {
  const staged: string[] = [];
  const cleaned: string[] = [];
  const submitted: string[] = [];
  const ig = connectedAccountRef({ backend: "ig", platform: "instagram", accountId: "ig1" });
  const tt = connectedAccountRef({ backend: "tt", platform: "tiktok", accountId: "creator1" });

  const social = createSocial({
    backends: {
      ig: instagram({
        auth: { accountId: "ig1", accessToken: "fixture" },
        fetch: async (input, init) => {
          const url = new URL(String(input));

          if (url.pathname.endsWith("/media")) {
            const body = object(parseJson(String(init?.body)));
            submitted.push(String(body["image_url"]));

            return Response.json({ id: "container" });
          }

          if (url.searchParams.has("fields")) return Response.json({ status_code: "FINISHED" });
          assert.ok(url.pathname.endsWith("/media_publish"));

          return Response.json({ id: "post1" });
        },
      }),
      tt: tiktok({
        auth: { openId: "creator1", accessToken: "fixture" },
        verifiedMediaOrigins: ["https://media.example.test"],
        fetch: async (input, init) => {
          const url = new URL(String(input));

          if (url.pathname.includes("creator_info"))
            return Response.json({
              data: {
                creator_username: "demo",
                creator_nickname: "Demo",
                privacy_level_options: ["SELF_ONLY"],
                max_video_post_duration_sec: 60,
              },
              error: { code: "ok" },
            });
          const body = object(parseJson(String(init?.body)));
          const source = object(body["source_info"]);
          assert.equal(source["source"], "PULL_FROM_URL");
          submitted.push(...array(source["photo_images"]).map(String));

          return Response.json({ data: { publish_id: "publish1" }, error: { code: "ok" } });
        },
      }),
    },
    mediaStaging: {
      origin: "https://media.example.test",
      async stageMedia(source, { account }) {
        assert.equal(source.kind, "blob");
        staged.push(account.backend);

        return {
          url: `https://media.example.test/${account.backend}.jpg`,
          cleanup: async () => {
            cleaned.push(account.backend);
          },
        };
      },
    },
  });

  const request = {
    targets: [
      { account: ig },
      {
        account: tt,
        options: {
          privacy: "SELF_ONLY",
          consentGiven: true,
          disableComments: true,
          disableDuet: true,
          disableStitch: true,
          brandedContent: false,
          ownBrand: false,
          aiGenerated: false,
          draft: false,
          photoCoverIndex: 0,
          creatorInfo: {
            accountId: "creator1",
            backend: "tt",
            username: "demo",
            nickname: "Demo",
            fetchedAt: "2026-10-24T00:00:00Z",
            privacyLevels: ["SELF_ONLY"],
            commentDisabled: false,
            duetDisabled: false,
            stitchDisabled: false,
            maxVideoDurationSeconds: 60,
          },
        },
      },
    ],
    content: {
      text: "fixture caption",
      media: [
        {
          kind: "image" as const,
          source: await bytes(new Uint8Array([1, 2, 3]), { mimeType: "image/jpeg" }),
          mimeType: "image/jpeg",
          width: 1080,
          height: 1080,
        },
      ],
    },
  } satisfies PublishRequest;

  assert.equal(social.posts.prepare(request).ok, true);
  assert.deepEqual(staged, []);
  const result = await social.posts.publish(request);
  assert.deepEqual(
    result.outcomes.map((outcome) => outcome.state),
    ["published", "accepted"],
  );
  assert.deepEqual([...staged].sort(), ["ig", "tt"]);
  assert.deepEqual([...submitted].sort(), [
    "https://media.example.test/ig.jpg",
    "https://media.example.test/tt.jpg",
  ]);
  assert.deepEqual(cleaned, ["ig"]);
});

it("the real CLI validate command reports machine-readable media limits offline", async () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const directory = await mkdtemp(`${root}tmp-track6-cli-`);

  try {
    const file = `${directory}/request.json`;

    const request = (count: number) => ({
      targets: [
        {
          account: connectedAccountRef({
            backend: "default",
            platform: "instagram",
            accountId: "ig1",
          }),
        },
      ],
      content: {
        media: Array.from({ length: count }, () => ({
          kind: "image",
          mimeType: "image/jpeg",
          width: 1080,
          height: 1080,
          source: { kind: "https-url", url: "https://media.example.test/private.jpg" },
        })),
      },
    });

    for (const [count, status] of [
      [1, 0],
      [11, 1],
    ] as const) {
      await writeFile(file, JSON.stringify(request(count)));

      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/social-sdk/src/cli.ts",
          "validate",
          "--adapter",
          "instagram",
          "--file",
          file,
          "--json",
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 15_000,
        },
      );

      assert.equal(result.status, status, result.stderr || result.stdout);
      const output = object(parseJson(result.stdout));
      const data = object(output["data"]);
      assert.equal(data["localOnly"], true);

      if (count > 10)
        assert.ok(
          array(data["issues"]).some((issue) => object(issue)["code"] === "media.too_many"),
        );
      assert.doesNotMatch(result.stdout, /private\.jpg|ig1/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
