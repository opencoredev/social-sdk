import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject, PublishRequest } from "../src/core/types.js";
import { object } from "../src/transport/validation.js";
import { definedFields } from "../src/core/fields.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const memberUrn = "urn:li:person:member1";

const organizationUrn = "urn:li:organization:5515715";

const member = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: memberUrn,
});

const organization = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: organizationUrn,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body?: JsonObject;
}

function recorder(respond: (call: Call) => Response = () => created()) {
  const calls: Call[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...definedFields({ body: init?.body ? object(JSON.parse(String(init.body))) : undefined }),
    };

    calls.push(call);

    return respond(call);
  };

  return { calls, fetch };
}

const created = () =>
  new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });

it("sends CONNECTIONS visibility, disabled reshares, mentions and hashtags [feature:linkedin.publish.disable_reshare]", async () => {
  const { calls, fetch } = recorder();

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: memberUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  const text = "Hello Devtestco, read #coding (tips)";

  const result = await social.posts.publish({
    targets: [
      {
        account: member,
        options: {
          visibility: "connections",
          disableReshare: true,
          annotations: [
            { kind: "mention", start: 6, length: 9, urn: "urn:li:organization:2414183" },
            { kind: "hashtag", start: 22, length: 7 },
          ],
        },
      },
    ],
    content: { text },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/posts");
  assert.equal(calls[0]?.body?.["visibility"], "CONNECTIONS");
  assert.equal(calls[0]?.body?.["isReshareDisabledByAuthor"], true);
  assert.equal(
    calls[0]?.body?.["commentary"],
    "Hello @[Devtestco](urn:li:organization:2414183), read {hashtag|\\#|coding} \\(tips\\)",
  );
});

it("rejects malformed annotations, organization CONNECTIONS posts and member targeting before any request", () => {
  const social = createSocial({
    backend: linkedin({ auth: { accessToken: "secret", author: memberUrn }, apiVersion: "202610" }),
  });

  const memberCases: readonly JsonObject[] = [
    { annotations: [{ kind: "hashtag", start: 0, length: 4 }] },
    { annotations: [{ kind: "mention", start: 0, length: 40, urn: memberUrn }] },
    {
      annotations: [
        { kind: "hashtag", start: 6, length: 6 },
        { kind: "hashtag", start: 8, length: 4 },
      ],
    },
    { annotations: [{ kind: "mention", start: 0, length: 5, urn: "urn:li:group:1" }] },
    { targeting: { geoLocations: ["urn:li:geo:103644278"] } },
    { visibility: "private" },
  ];

  for (const options of memberCases) {
    const request: PublishRequest = {
      targets: [{ account: member, options }],
      content: { text: "Hello #tests" },
    };

    assert.equal(social.posts.prepare(request).ok, false);
  }

  const organizationSocial = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
    }),
  });

  const organizationCases: readonly JsonObject[] = [
    { visibility: "connections" },
    { targeting: {} },
    { targeting: { seniorities: ["urn:li:geo:1"] } },
  ];

  for (const options of organizationCases) {
    const request: PublishRequest = {
      targets: [{ account: organization, options }],
      content: { text: "Hello" },
    };

    assert.equal(organizationSocial.posts.prepare(request).ok, false);
  }
});

it("sends organization targetEntities facets for targeted organic posts", async () => {
  const { calls, fetch } = recorder();

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  const result = await social.posts.publish({
    targets: [
      {
        account: organization,
        options: {
          targeting: {
            geoLocations: ["urn:li:geo:103644278"],
            seniorities: ["urn:li:seniority:3"],
            industries: ["urn:li:industry:4"],
            jobFunctions: ["urn:li:function:8"],
            staffCountRanges: ["SIZE_51_TO_200"],
          },
        },
      },
    ],
    content: { text: "Targeted update" },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(calls[0]?.body?.["distribution"], {
    feedDistribution: "MAIN_FEED",
    targetEntities: [
      {
        geoLocations: ["urn:li:geo:103644278"],
        seniorities: ["urn:li:seniority:3"],
        industries: ["urn:li:industry:4"],
        jobFunctions: ["urn:li:function:8"],
        staffCountRanges: ["SIZE_51_TO_200"],
      },
    ],
    thirdPartyDistributionChannels: [],
  });
  assert.equal(calls[0]?.body?.["visibility"], "PUBLIC");
  assert.equal(calls[0]?.body?.["isReshareDisabledByAuthor"], false);
});

it("sends interfaceLocales targeting as Locale records and rejects malformed locales", async () => {
  const { calls, fetch } = recorder();

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  const result = await social.posts.publish({
    targets: [
      {
        account: organization,
        options: {
          targeting: {
            interfaceLocales: [{ language: "en", country: "US" }, { language: "de" }],
            geoLocations: ["urn:li:geo:103644278"],
          },
        },
      },
    ],
    content: { text: "Localized update" },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(object(calls[0]?.body?.["distribution"])["targetEntities"], [
    {
      interfaceLocales: [{ country: "US", language: "en" }, { language: "de" }],
      geoLocations: ["urn:li:geo:103644278"],
    },
  ]);

  const invalid: readonly JsonObject[] = [
    { targeting: { interfaceLocales: [] } },
    { targeting: { interfaceLocales: ["en_US"] } },
    { targeting: { interfaceLocales: [{ language: "EN" }] } },
    { targeting: { interfaceLocales: [{ language: "en", country: "us" }] } },
    { targeting: { interfaceLocales: [{ language: "en", variant: "WIN" }] } },
  ];

  for (const options of invalid)
    assert.equal(
      social.posts.prepare({
        targets: [{ account: organization, options }],
        content: { text: "Hello" },
      }).ok,
      false,
    );
  assert.equal(calls.length, 1);
});

it("checks an uploaded article thumbnail and sends it as content.article.thumbnail", async () => {
  const { calls, fetch } = recorder((call) =>
    call.method === "GET"
      ? Response.json({ id: "urn:li:image:thumb1", owner: organizationUrn, status: "AVAILABLE" })
      : created(),
  );

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  const result = await social.posts.publish({
    targets: [
      {
        account: organization,
        options: {
          articleThumbnail: {
            kind: "media",
            version: 1,
            backend: "default",
            platform: "linkedin",
            accountId: organizationUrn,
            mediaId: "urn:li:image:thumb1",
          },
        },
      },
    ],
    content: {
      text: "New article",
      link: { url: "https://example.com/post", title: "Title", description: "Summary" },
    },
  });

  assert.equal(result.outcomes[0]?.state, "published");
  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3Athumb1");
  assert.deepEqual(calls[1]?.body?.["content"], {
    article: {
      source: "https://example.com/post",
      thumbnail: "urn:li:image:thumb1",
      title: "Title",
      description: "Summary",
    },
  });

  const prepared = social.posts.prepare({
    targets: [
      {
        account: organization,
        options: {
          articleThumbnail: {
            kind: "media",
            version: 1,
            backend: "default",
            platform: "linkedin",
            accountId: "urn:li:organization:other",
            mediaId: "urn:li:image:thumb1",
          },
        },
      },
    ],
    content: { text: "No link" },
  });

  assert.equal(prepared.ok, false);
});

it("creates polls with a separate question and enforces the 140, 2 to 4 and 30 character limits", async () => {
  const { calls, fetch } = recorder();

  const adapter = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch,
  });

  const native = adapter.native!;

  await native.createPoll({
    account: organization,
    text: "Tell us #why",
    question: "What is your favorite color?",
    options: ["Red", "Blue", "Yellow", "Green"],
    duration: "SEVEN_DAYS",
    context: nativeContext,
  });

  assert.equal(calls[0]?.body?.["commentary"], "Tell us \\#why");
  assert.deepEqual(calls[0]?.body?.["content"], {
    poll: {
      question: "What is your favorite color?",
      options: [{ text: "Red" }, { text: "Blue" }, { text: "Yellow" }, { text: "Green" }],
      settings: { duration: "SEVEN_DAYS" },
    },
  });

  for (const input of [
    { question: "q".repeat(141), options: ["A", "B"] },
    { question: "Q", options: ["A"] },
    { question: "Q", options: ["A", "B", "C", "D", "E"] },
    { question: "Q", options: ["A", "o".repeat(31)] },
  ])
    await assert.rejects(
      native.createPoll({ account: organization, text: "Poll", ...input, context: nativeContext }),
      /140 characters/,
    );

  assert.equal(calls.length, 1);
});

it("reshares with quote commentary through reshareContext.parent [feature:linkedin.publish.reshare]", async () => {
  const { calls, fetch } = recorder();

  const native = linkedin({
    auth: { accessToken: "secret", author: memberUrn },
    apiVersion: "202610",
    fetch,
  }).native!;

  const reshared = await native.reshare({
    account: member,
    postId: "urn:li:share:6957408550713184256",
    text: "Worth reading (again)",
    context: nativeContext,
  });

  assert.equal(reshared["id"], "urn:li:share:99");
  assert.equal(calls[0]?.body?.["commentary"], "Worth reading \\(again\\)");
  assert.deepEqual(calls[0]?.body?.["reshareContext"], {
    parent: "urn:li:share:6957408550713184256",
  });
  await assert.rejects(
    native.reshare({ account: member, postId: "123", context: nativeContext }),
    /urn:li:share/,
  );
});

it("sends typed post edits as escaped commentary in patch.$set", async () => {
  const { calls, fetch } = recorder(() => new Response(null, { status: 204 }));

  const native = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch,
  }).native!;

  await native.updatePost({
    account: organization,
    postId: "urn:li:share:123",
    changes: {
      text: "Updated #launch notes",
      annotations: [{ kind: "hashtag", start: 8, length: 7 }],
      contentCallToActionLabel: "LEARN_MORE",
      contentLandingPage: "https://example.com/launch",
    },
    context: nativeContext,
  });

  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A123");
  assert.equal(calls[0]?.headers.get("X-RestLi-Method"), "PARTIAL_UPDATE");
  assert.deepEqual(calls[0]?.body, {
    patch: {
      $set: {
        commentary: "Updated {hashtag|\\#|launch} notes",
        contentCallToActionLabel: "LEARN_MORE",
        contentLandingPage: "https://example.com/launch",
      },
    },
  });

  await assert.rejects(
    native.updatePost({
      account: organization,
      postId: "urn:li:share:123",
      changes: { contentLandingPage: "http://example.com" },
      context: nativeContext,
    }),
    /HTTPS landing page/,
  );
  assert.equal(calls.length, 1);
});

it("sends documented reaction types including ENTERTAINMENT", async () => {
  // Reactions API create answers 201 Created with the reaction.
  const { calls, fetch } = recorder(() =>
    Response.json(
      {
        id: "urn:li:reaction:(urn:li:person:member1,urn:li:activity:1)",
        reactionType: "ENTERTAINMENT",
        root: "urn:li:activity:1",
      },
      { status: 201 },
    ),
  );

  const native = linkedin({
    auth: { accessToken: "secret", author: memberUrn },
    apiVersion: "202610",
    fetch,
  }).native!;

  await native.react({
    account: member,
    postId: "urn:li:share:1",
    reaction: "ENTERTAINMENT",
    context: nativeContext,
  });

  assert.deepEqual(calls[0]?.body, { root: "urn:li:share:1", reactionType: "ENTERTAINMENT" });
});
