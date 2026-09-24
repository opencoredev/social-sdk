import { it } from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticAdapter, type AdapterName } from "../src/cli.js";
import type { JsonObject, JsonValue } from "../src/core/types.js";
import { youtube } from "../src/platforms/youtube.js";
import { parseJson } from "../src/transport/json.js";

interface Call {
  readonly method: string;
  readonly url: URL;
  readonly body: JsonValue | undefined;
}

const context = {
  backendInstance: "default",
  correlationId: "profile-update",
  retryBudget: { maxAttempts: 3, maxElapsedMs: 1000 },
};

/** Simulates a JavaScript caller whose JSON-decoded input bypasses the static types. */
function untypedJson<Declared>(json: string): Declared {
  return JSON.parse(json);
}

function channelAdapter(channel: JsonObject | undefined, putStatus = 200) {
  const calls: Call[] = [];

  const adapter = youtube({
    auth: { accessToken: "test", channelId: "channel1" },
    fetch: async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: new URL(String(input)),
        body: init?.body === undefined ? undefined : parseJson(String(init.body)),
      });

      if (method === "GET") return Response.json({ items: channel ? [channel] : [] });

      if (putStatus !== 200) return new Response("unavailable", { status: putStatus });

      return Response.json({ id: "channel1", kind: "youtube#channel" });
    },
  });

  return { adapter, calls };
}

it("YouTube profile.update merges brandingSettings.channel before channels.update", async () => {
  const { adapter, calls } = channelAdapter({
    id: "channel1",
    brandingSettings: {
      channel: { title: "Channel", description: "Old", keywords: "a b", country: "US" },
      image: {
        bannerExternalUrl: "https://example.test/banner",
        bannerImageUrl: "https://example.test/deprecated",
      },
      watch: { featuredPlaylistId: "PL1" },
      hints: [{ property: "p", value: "v" }],
    },
  });

  const result = await adapter.native!.updateProfile({
    part: "brandingSettings",
    value: { channel: { description: "New", country: null } },
    context,
  });

  assert.equal(result["id"], "channel1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.method, "GET");
  assert.equal(calls[0]!.url.pathname, "/youtube/v3/channels");
  assert.equal(calls[0]!.url.searchParams.get("id"), "channel1");
  assert.equal(calls[0]!.url.searchParams.get("part"), "brandingSettings");
  assert.equal(calls[1]!.method, "PUT");
  assert.equal(calls[1]!.url.pathname, "/youtube/v3/channels");
  assert.equal(calls[1]!.url.searchParams.get("part"), "brandingSettings");
  assert.deepEqual(calls[1]!.body, {
    id: "channel1",
    brandingSettings: {
      channel: { title: "Channel", description: "New", keywords: "a b" },
      image: { bannerExternalUrl: "https://example.test/banner" },
    },
  });
});

it("YouTube profile.update omits image when the channel has no banner", async () => {
  const { adapter, calls } = channelAdapter({
    id: "channel1",
    brandingSettings: { channel: { title: "Channel" }, image: {} },
  });

  await adapter.native!.updateProfile({
    part: "brandingSettings",
    value: { channel: { description: "New" } },
    context,
  });
  assert.deepEqual(calls[1]!.body, {
    id: "channel1",
    brandingSettings: { channel: { title: "Channel", description: "New" } },
  });
});

it("YouTube profile.update merges localizations and removes null entries", async () => {
  const { adapter, calls } = channelAdapter({
    id: "channel1",
    localizations: {
      de: { title: "Kanal", description: "Alt" },
      fr: { title: "Chaîne", description: "Ancien" },
    },
  });

  await adapter.native!.updateProfile({
    part: "localizations",
    value: { de: { title: "Kanal", description: "Neu" }, fr: null, es: { title: "Canal" } },
    context,
  });

  assert.equal(calls[1]!.url.searchParams.get("part"), "localizations");
  assert.deepEqual(calls[1]!.body, {
    id: "channel1",
    localizations: {
      de: { title: "Kanal", description: "Neu" },
      es: { title: "Canal" },
    },
  });
});

it("YouTube profile.update rejects invalid input before any request", async () => {
  const { adapter, calls } = channelAdapter({ id: "channel1" });

  const invalid = [
    { part: "invideoPromotion", value: { items: [] } },
    { part: "brandingSettings", value: {} },
    { part: "brandingSettings", value: { image: {} } },
    { part: "brandingSettings", value: { channel: "text" } },
    { part: "localizations", value: { de: "Kanal" } },
  ] as const;

  for (const input of invalid)
    await assert.rejects(
      adapter.native!.updateProfile({ ...untypedJson(JSON.stringify(input)), context }),
      { name: "SocialError", code: "invalid_input" },
    );
  assert.equal(calls.length, 0);
});

it("YouTube profile.update refuses a channel the authorization cannot read", async () => {
  const missing = channelAdapter(undefined);
  await assert.rejects(
    missing.adapter.native!.updateProfile({
      part: "brandingSettings",
      value: { channel: { description: "New" } },
      context,
    }),
    { name: "SocialError", code: "unauthorized" },
  );
  assert.deepEqual(
    missing.calls.map((call) => call.method),
    ["GET"],
  );
});

it("YouTube profile.update reports a dispatched server failure as ambiguous without replay", async () => {
  const { adapter, calls } = channelAdapter(
    { id: "channel1", brandingSettings: { channel: { title: "Channel" } } },
    503,
  );

  await assert.rejects(
    adapter.native!.updateProfile({
      part: "brandingSettings",
      value: { channel: { description: "New" } },
      context,
    }),
    { name: "SocialError", code: "ambiguous_outcome" },
  );
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "PUT"],
  );
});

it("Adapters declare profile.update according to each platform's documented API", () => {
  const expected: readonly (readonly [AdapterName, string])[] = [
    ["bluesky", "available"],
    ["youtube", "available"],
    ["x", "unsupported-by-platform"],
    ["threads", "unsupported-by-platform"],
    ["instagram", "unsupported-by-platform"],
    ["tiktok", "unsupported-by-platform"],
    ["linkedin", "approval-dependent"],
  ];

  for (const [name, availability] of expected) {
    const declaration = createDiagnosticAdapter(name).capabilities.capabilities.find(
      (entry) => entry.operation === "profile.update",
    );

    assert.equal(declaration?.availability, availability, name);

    if (availability !== "available") assert.ok(declaration?.notes, `${name} documents why`);
  }
});
