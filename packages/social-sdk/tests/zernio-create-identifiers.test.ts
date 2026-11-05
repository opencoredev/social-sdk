import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { zernioNative } from "../src/cloud/zernio-native.js";
import { SocialError } from "../src/core/errors.js";
import type { AdapterOperationContext, JsonValue } from "../src/core/types.js";

const context: AdapterOperationContext = {
  backendInstance: "default",
  correlationId: "zernio-create-identifiers",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 30_000 },
};

const account = (platform: string, accountId: string) =>
  connectedAccountRef({ backend: "default", platform, accountId });

/** A Zernio client whose every request gets `answer` with a 2xx status. */
const native = (answer: JsonValue) =>
  zernioNative({
    apiKey: "fixture-key",
    fetch: async () => Response.json(answer, { status: 201 }),
  });

interface CreateCase {
  readonly name: string;
  /** A 2xx body whose created record has every field but its identifier. */
  readonly answer: JsonValue;
  readonly run: (client: ReturnType<typeof zernioNative>) => Promise<object>;
}

const bot = account("discord", "dc1");

const cases: readonly CreateCase[] = [
  {
    name: "createProfile",
    answer: { message: "Created", profile: { name: "Brand" } },
    run: (client) => client.createProfile({ name: "Brand" }, context),
  },
  {
    name: "createWebhook",
    answer: { success: true, webhook: { name: "Prod", events: ["post.published"] } },
    run: (client) =>
      client.createWebhook(
        { name: "Prod", url: "https://app.example.com/hooks", events: ["post.published"] },
        context,
      ),
  },
  {
    name: "createPinterestBoard",
    answer: { board: { name: "New" } },
    run: (client) =>
      client.createPinterestBoard({ account: account("pinterest", "pin1"), name: "New" }, context),
  },
  {
    name: "createYouTubePlaylist",
    answer: { playlist: { title: "Shorts" } },
    run: (client) =>
      client.createYouTubePlaylist(
        { account: account("youtube", "yt1"), title: "Shorts" },
        context,
      ),
  },
  {
    name: "createAccountGroup",
    answer: { group: { name: "Team", accountIds: ["acc1"] } },
    run: (client) =>
      client.createAccountGroup({ name: "Team", accounts: [account("x", "acc1")] }, context),
  },
  {
    name: "createOAuthApp",
    answer: { app: { platform: "linkedin", label: "Our app", status: "ok" } },
    run: (client) =>
      client.createOAuthApp(
        {
          platform: "linkedin",
          label: "Our app",
          clientId: "client",
          clientSecret: "fixture-secret",
        },
        context,
      ),
  },
  {
    name: "createDiscordRole",
    answer: { data: { name: "Mods" } },
    run: (client) =>
      client.createDiscordRole({ account: bot, guildId: "999", name: "Mods" }, context),
  },
  {
    name: "createDiscordThread",
    answer: { data: { name: "Q&A" } },
    run: (client) =>
      client.createDiscordThread({ account: bot, channelId: "111", name: "Q&A" }, context),
  },
  {
    name: "createDiscordEvent",
    answer: { data: { name: "Launch" } },
    run: (client) =>
      client.createDiscordEvent(
        {
          account: bot,
          guildId: "999",
          name: "Launch",
          startsAt: "2026-12-01T18:00:00Z",
          entity: { type: "external", location: "Zoom", endsAt: "2026-12-01T19:00:00Z" },
        },
        context,
      ),
  },
  {
    name: "createInboxLabel",
    answer: { label: { name: "Lead" } },
    run: (client) =>
      client.createInboxLabel({ account: account("facebook", "fb1"), name: "Lead" }, context),
  },
];

/** The created record with an empty or missing identifier field. */
const withoutIdentifier = (answer: JsonValue): readonly JsonValue[] => [answer, {}];

it("Zernio creates without the created record's identifier are unconfirmed, not success", async () => {
  for (const { name, answer, run } of cases)
    for (const body of withoutIdentifier(answer))
      await assert.rejects(
        run(native(body)),
        (error) =>
          error instanceof SocialError &&
          error.code === "ambiguous_outcome" &&
          error.retryDisposition?.kind === "reconcile-first",
        `${name} accepted ${JSON.stringify(body)}`,
      );
});

it("Zernio creates reject an empty created identifier", async () => {
  await assert.rejects(
    native({ profile: { _id: " ", name: "Brand" } }).createProfile({ name: "Brand" }, context),
    { code: "ambiguous_outcome" },
  );
  await assert.rejects(
    native({ data: { id: "", name: "Mods" } }).createDiscordRole(
      { account: bot, guildId: "999", name: "Mods" },
      context,
    ),
    { code: "ambiguous_outcome" },
  );
});
