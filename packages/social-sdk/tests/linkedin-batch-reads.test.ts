import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject, MediaRef } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { object } from "../src/transport/validation.js";
import { SocialError } from "../src/core/errors.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const organizationUrn = "urn:li:organization:2414183";

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

const native = (respond: (call: Call) => Response) => {
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

  const adapter = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch,
  });

  return { calls, native: adapter.native! };
};

const mediaRef = (mediaId: string): MediaRef => ({
  kind: "media",
  version: 1,
  backend: "default",
  platform: "linkedin",
  accountId: organizationUrn,
  mediaId,
});

it("batch reads social metadata with socialMetadata?ids=List(...)", async () => {
  const comment = "urn:li:comment:(urn:li:activity:6524387688164966400,6636062862760562688)";

  const { calls, native: api } = native(() =>
    Response.json({
      results: {
        "urn:li:share:111": {
          commentsState: "OPEN",
          entity: "urn:li:share:111",
          reactionSummaries: { PRAISE: { reactionType: "PRAISE", count: 1 } },
          commentSummary: { count: 4, topLevelCount: 3 },
        },
      },
      statuses: { [comment]: 404 },
      errors: {},
    }),
  );

  const batch = await api.getSocialMetadataBatch({
    account: organization,
    entities: ["urn:li:share:111", comment, "urn:li:share:111"],
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialMetadata?ids=List(urn%3Ali%3Ashare%3A111,urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A6524387688164966400%2C6636062862760562688%29)",
  );
  assert.equal(calls[0]?.method, "GET");
  assert.equal(calls[0]?.headers.get("X-Restli-Protocol-Version"), "2.0.0");
  assert.deepEqual(batch.results["urn:li:share:111"], {
    reactions: { PRAISE: 1 },
    entity: "urn:li:share:111",
    commentsState: "OPEN",
    comments: { total: 4, topLevel: 3 },
  });
  assert.deepEqual(batch.errors, [{ id: comment, status: 404 }]);

  await assert.rejects(
    api.getSocialMetadataBatch({
      account: organization,
      entities: ["urn:li:person:abc"],
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(calls.length, 1);
});

it("batch reads social action summaries with socialActions?ids=List(...)", async () => {
  const { calls, native: api } = native(() =>
    Response.json({
      results: {
        "urn:li:ugcPost:7096754084929548288": {
          likesSummary: {
            selectedLikes: [],
            aggregatedTotalLikes: 2,
            likedByCurrentUser: true,
            totalLikes: 1,
          },
          commentsSummary: {
            selectedComments: [],
            totalFirstLevelComments: 3,
            commentsState: "OPEN",
            aggregatedTotalComments: 5,
          },
          target: "urn:li:ugcPost:7096754084929548288",
        },
        "urn:li:ugcPost:7096760097833439232": {},
      },
      statuses: {},
      errors: {},
    }),
  );

  const batch = await api.getSocialActionsBatch({
    account: organization,
    entities: ["urn:li:ugcPost:7096760097833439232", "urn:li:ugcPost:7096754084929548288"],
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialActions?ids=List(urn%3Ali%3AugcPost%3A7096760097833439232,urn%3Ali%3AugcPost%3A7096754084929548288)",
  );
  assert.deepEqual(batch.results["urn:li:ugcPost:7096754084929548288"], {
    target: "urn:li:ugcPost:7096754084929548288",
    likes: { total: 1, aggregatedTotal: 2, likedByCurrentUser: true },
    comments: { firstLevel: 3, aggregatedTotal: 5, state: "OPEN" },
  });
  assert.deepEqual(batch.results["urn:li:ugcPost:7096760097833439232"], {});
  assert.deepEqual(batch.errors, []);
});

it("batch reads comments with /comments?ids=List(...) and checks returned commentUrns", async () => {
  const first = "urn:li:comment:(urn:li:activity:7061794973381181553,7061795051579785216)";
  const second = "urn:li:comment:(urn:li:activity:7061794973381181553,7061795094571401216)";

  const { calls, native: api } = native(() =>
    Response.json({
      results: {
        "7061795051579785216": {
          actor: "urn:li:person:A8xe03Qt10",
          commentUrn: first,
          created: { actor: "urn:li:person:A8xe03Qt10", time: 1683663142106 },
          id: "7061795051579785216",
          message: { attributes: [], text: "Comment 2" },
          object: "urn:li:activity:7061794973381181553",
        },
      },
      statuses: { "7061795094571401216": 404 },
      errors: {},
    }),
  );

  const batch = await api.getComments({
    account: organization,
    target: "urn:li:share:7061794973381181553",
    commentIds: [first, second],
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A7061794973381181553/comments?ids=List(7061795051579785216,7061795094571401216)",
  );
  assert.equal(batch.comments.length, 1);
  assert.equal(batch.comments[0]?.["text"], "Comment 2");
  assert.equal(batch.comments[0]?.["commentUrn"], first);
  assert.deepEqual(batch.errors, [{ id: second, status: 404 }]);

  const wrong = native(() =>
    Response.json({
      results: { "7061795051579785216": { commentUrn: second, message: { text: "x" } } },
    }),
  );

  await assert.rejects(
    wrong.native.getComments({
      account: organization,
      target: "urn:li:share:7061794973381181553",
      commentIds: [first],
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "upstream_failure",
  );
});

it("gets one reaction by actor and entity [feature:linkedin.engagement.reactions.get]", async () => {
  const reaction = {
    id: "urn:li:reaction:(urn:li:organization:2414183,urn:li:activity:7067167295080394752)",
    reactionType: "LIKE",
    created: { actor: organizationUrn, time: 1686183251857 },
    root: "urn:li:activity:7067167295080394752",
  };

  const { calls, native: api } = native((call) =>
    call.url.includes("share%3A404")
      ? Response.json({ status: 404 }, { status: 404 })
      : Response.json(reaction),
  );

  const found = await api.getReaction({
    account: organization,
    entity: "urn:li:share:7019389037023006721",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aorganization%3A2414183,entity:urn%3Ali%3Ashare%3A7019389037023006721)",
  );
  assert.deepEqual(found, {
    reactionType: "LIKE",
    id: reaction.id,
    actor: organizationUrn,
    root: "urn:li:activity:7067167295080394752",
    createdAt: 1686183251857,
  });

  const missing = await api.getReaction({
    account: organization,
    entity: "urn:li:share:404",
    actor: "urn:li:person:aVesTeT",
    context: nativeContext,
  });

  assert.equal(
    calls[1]?.url,
    "https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aperson%3AaVesTeT,entity:urn%3Ali%3Ashare%3A404)",
  );
  assert.equal(missing, undefined);
});

it("batch gets reactions with reactions?ids=List(...) [feature:linkedin.engagement.reactions.get]", async () => {
  const comment = "urn:li:comment:(urn:li:activity:7017259249298792448,7017259297759780864)";

  const { calls, native: api } = native(() =>
    Response.json({
      statuses: {
        "(actor:urn%3Ali%3Aperson%3AaVesTeT,entity:urn%3Ali%3Ashare%3A7019389037023006721)": 200,
        "(actor:urn%3Ali%3Aorganization%3A2414183,entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7017259249298792448%2C7017259297759780864%29)": 404,
      },
      results: {
        "(actor:urn%3Ali%3Aperson%3AaVesTeT,entity:urn%3Ali%3Ashare%3A7019389037023006721)": {
          id: "urn:li:reaction:(urn:li:person:aVesTeT,urn:li:activity:7019389037023006721)",
          reactionType: "EMPATHY",
          created: { actor: "urn:li:person:aVesTeT", time: 1686183251857 },
          root: "urn:li:activity:7019389037023006721",
        },
      },
      errors: {},
    }),
  );

  const batch = await api.getReactions({
    account: organization,
    keys: [
      { actor: organizationUrn, entity: comment },
      { actor: "urn:li:person:aVesTeT", entity: "urn:li:share:7019389037023006721" },
    ],
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/reactions?ids=List((actor:urn%3Ali%3Aorganization%3A2414183,entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7017259249298792448%2C7017259297759780864%29),(actor:urn%3Ali%3Aperson%3AaVesTeT,entity:urn%3Ali%3Ashare%3A7019389037023006721))",
  );
  assert.equal(batch.reactions.length, 1);
  assert.equal(batch.reactions[0]?.actor, "urn:li:person:aVesTeT");
  assert.equal(batch.reactions[0]?.reaction.reactionType, "EMPATHY");
  assert.deepEqual(batch.errors, [{ actor: organizationUrn, entity: comment, status: 404 }]);

  await assert.rejects(
    api.getReactions({
      account: organization,
      keys: [{ actor: organizationUrn, entity: "urn:li:image:abc" }],
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(calls.length, 1);
});

it("batch reads media status with images, videos and documents ?ids=List(...)", async () => {
  const { calls, native: api } = native((call) => {
    if (call.url.includes("/rest/images?"))
      return Response.json({
        results: {
          "urn:li:image:C4E10AQFn10iWtKexVA": {
            owner: organizationUrn,
            downloadUrl: "https://media.licdn.example/signed",
            id: "urn:li:image:C4E10AQFn10iWtKexVA",
            status: "AVAILABLE",
          },
          "urn:li:image:C4E10AQFgOYeVoHFeBw": {
            owner: organizationUrn,
            id: "urn:li:image:C4E10AQFgOYeVoHFeBw",
            status: "WAITING_UPLOAD",
          },
        },
        statuses: {},
        errors: {},
      });

    if (call.url.includes("/rest/videos?"))
      return Response.json({
        results: {
          "urn:li:video:C4D10AQE9WE5n4uJKUg": {
            owner: organizationUrn,
            status: "AVAILABLE",
            id: "urn:li:video:C4D10AQE9WE5n4uJKUg",
            duration: 12000,
          },
        },
        statuses: { "urn:li:video:C5F10AQElP1fVH1Ke6g": 404 },
        errors: {
          "urn:li:video:C5F10AQElP1fVH1Ke6g": { message: "Could not find entity", status: 404 },
        },
      });

    return Response.json({
      results: {
        "urn:li:document:D5510AQFx87994pYx0Q": {
          owner: organizationUrn,
          id: "urn:li:document:D5510AQFx87994pYx0Q",
          status: "PROCESSING",
        },
      },
    });
  });

  const batch = await api.mediaStatuses({
    account: organization,
    media: [
      mediaRef("urn:li:image:C4E10AQFn10iWtKexVA"),
      mediaRef("urn:li:video:C4D10AQE9WE5n4uJKUg"),
      mediaRef("urn:li:image:C4E10AQFgOYeVoHFeBw"),
      mediaRef("urn:li:video:C5F10AQElP1fVH1Ke6g"),
      mediaRef("urn:li:document:D5510AQFx87994pYx0Q"),
    ],
    context: nativeContext,
  });

  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "https://api.linkedin.com/rest/images?ids=List(urn%3Ali%3Aimage%3AC4E10AQFn10iWtKexVA,urn%3Ali%3Aimage%3AC4E10AQFgOYeVoHFeBw)",
      "https://api.linkedin.com/rest/videos?ids=List(urn%3Ali%3Avideo%3AC4D10AQE9WE5n4uJKUg,urn%3Ali%3Avideo%3AC5F10AQElP1fVH1Ke6g)",
      "https://api.linkedin.com/rest/documents?ids=List(urn%3Ali%3Adocument%3AD5510AQFx87994pYx0Q)",
    ],
  );
  assert.deepEqual(batch.media, [
    { mediaId: "urn:li:image:C4E10AQFn10iWtKexVA", owner: organizationUrn, status: "AVAILABLE" },
    {
      mediaId: "urn:li:image:C4E10AQFgOYeVoHFeBw",
      owner: organizationUrn,
      status: "WAITING_UPLOAD",
    },
    {
      mediaId: "urn:li:video:C4D10AQE9WE5n4uJKUg",
      owner: organizationUrn,
      status: "AVAILABLE",
      duration: 12000,
    },
    {
      mediaId: "urn:li:document:D5510AQFx87994pYx0Q",
      owner: organizationUrn,
      status: "PROCESSING",
    },
  ]);
  assert.deepEqual(batch.errors, [{ id: "urn:li:video:C5F10AQElP1fVH1Ke6g", status: 404 }]);

  const foreign = native(() =>
    Response.json({
      results: {
        "urn:li:image:C4E10AQFn10iWtKexVA": {
          owner: "urn:li:organization:999",
          id: "urn:li:image:C4E10AQFn10iWtKexVA",
          status: "AVAILABLE",
        },
      },
    }),
  );

  await assert.rejects(
    foreign.native.mediaStatuses({
      account: organization,
      media: [mediaRef("urn:li:image:C4E10AQFn10iWtKexVA")],
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "unauthorized",
  );
});

it("resolves a member profile URL with vanityUrl q=vanityUrlAsOrganization", async () => {
  const { calls, native: api } = native((call) =>
    Response.json({
      paging: { start: 0, count: 10, links: [], total: 1 },
      elements: call.url.includes("nobody") ? [] : [{ member: "urn:li:person:abcdefg1h" }],
    }),
  );

  const member = await api.resolveMemberVanityUrl({
    account: organization,
    vanityUrl: "https://www.linkedin.com/in/jane-doe",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/vanityUrl?q=vanityUrlAsOrganization&vanityUrl=https%3A%2F%2Fwww.linkedin.com%2Fin%2Fjane-doe&organization=urn%3Ali%3Aorganization%3A2414183",
  );
  assert.equal(member, "urn:li:person:abcdefg1h");

  assert.equal(
    await api.resolveMemberVanityUrl({
      account: organization,
      vanityUrl: "https://www.linkedin.com/in/nobody/",
      context: nativeContext,
    }),
    undefined,
  );

  await assert.rejects(
    api.resolveMemberVanityUrl({
      account: organization,
      vanityUrl: "https://example.com/in/jane-doe",
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(calls.length, 2);

  const memberAdapter = linkedin({
    auth: { accessToken: "secret", author: "urn:li:person:member1" },
    apiVersion: "202610",
    fetch: async () => Response.json({}),
  });

  await assert.rejects(
    memberAdapter.native!.resolveMemberVanityUrl({
      account: connectedAccountRef({
        backend: "default",
        platform: "linkedin",
        accountId: "urn:li:person:member1",
      }),
      vanityUrl: "https://www.linkedin.com/in/jane-doe",
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "unsupported_capability",
  );
});
