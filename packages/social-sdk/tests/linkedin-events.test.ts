import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { object } from "../src/transport/validation.js";
import { SocialError } from "../src/core/errors.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const organizationUrn = "urn:li:organization:7185861";

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
  readonly rawBody?: BodyInit;
}

const native = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const isJson =
      init?.body !== undefined && String(input).startsWith("https://api.linkedin.com/rest/");

    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      ...definedFields({
        body: isJson ? object(JSON.parse(String(init?.body))) : undefined,
        rawBody: isJson ? undefined : (init?.body ?? undefined),
      }),
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

const json = (text: string, status = 200) =>
  new Response(text, { status, headers: { "content-type": "application/json" } });

it("creates an in-person event with POST /rest/events, keeping the 19-digit ID and endsAt", async () => {
  const { calls, native: api } = native(() =>
    json(
      `{"vanityName":"launch7249812613549670400","discoveryMode":"LISTED","id":7249812613549670400,"organizer":"urn:li:organization:7185861","name":{"localized":{"en_US":"Launch"}},"startsAt":9091536064111,"type":{"inPerson":{"address":{},"endsAt":9091536065000,"url":"https://example.com/launch"}},"backgroundImage":"urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q"}`,
      201,
    ),
  );

  const event = await api.createEvent({
    account: organization,
    name: "Launch",
    description: "Product launch",
    type: {
      kind: "inPerson",
      endsAt: 9091536065000,
      url: "https://example.com/launch",
      address: { city: "San Francisco", country: "US" },
    },
    startsAt: 9091536064111,
    backgroundImage: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
    discoveryMode: "LISTED",
    leadGenForm: { privacyPolicyUrl: "https://example.com/privacy" },
    context: nativeContext,
  });

  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/events");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.get("X-RestLi-Method"), "CREATE");
  assert.deepEqual(calls[0]?.body, {
    name: { localized: { en_US: "Launch" } },
    type: {
      inPerson: {
        endsAt: 9091536065000,
        url: "https://example.com/launch",
        address: { city: "San Francisco", country: "US" },
      },
    },
    organizer: organizationUrn,
    startsAt: 9091536064111,
    description: { localized: { en_US: { rawText: "Product launch" } } },
    backgroundImage: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
    discoveryMode: "LISTED",
    leadGenFormSpec: { privacyPolicyUrl: "https://example.com/privacy" },
  });
  assert.equal(event.eventUrn, "urn:li:event:7249812613549670400");
  assert.equal(event.postReference, "urn:li:event:7249812613549670400");
  assert.equal(event.kind, "inPerson");
  assert.equal(event.endsAt, 9091536065000);
  assert.equal(event.backgroundImage, "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q");

  await assert.rejects(
    api.createEvent({
      account: organization,
      name: "Backwards",
      type: { kind: "external", endsAt: 100, url: "https://example.com" },
      startsAt: 200,
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(calls.length, 1);
});

it("creates a live video event and posts it with content.reference urn:li:liveVideo", async () => {
  const { calls, native: api } = native((call) =>
    call.url.endsWith("/rest/posts")
      ? new Response(null, {
          status: 201,
          headers: { "x-restli-id": "urn:li:ugcPost:7249811999999999999" },
        })
      : json(
          `{"id":7249811611689828352,"organizer":"urn:li:organization:7185861","startsAt":9091536064111,"type":{"online":{"format":{"liveVideo":{"endsAt":9091536065000,"liveVideo":"urn:li:liveVideo:7249811612692275200","testEvent":true}}}}}`,
          201,
        ),
  );

  const event = await api.createEvent({
    account: organization,
    name: "Live Q&A",
    type: { kind: "liveVideo", endsAt: 9091536065000, testEvent: true },
    startsAt: 9091536064111,
    context: nativeContext,
  });

  assert.deepEqual(calls[0]?.body?.["type"], {
    online: { format: { liveVideo: { endsAt: 9091536065000, testEvent: true } } },
  });
  assert.equal(event.liveVideo, "urn:li:liveVideo:7249811612692275200");
  assert.equal(event.postReference, "urn:li:liveVideo:7249811612692275200");

  const posted = await api.createEventPost({
    account: organization,
    reference: event.postReference ?? "",
    text: "Join us",
    context: nativeContext,
  });

  assert.equal(calls[1]?.url, "https://api.linkedin.com/rest/posts");
  assert.deepEqual(calls[1]?.body, {
    author: organizationUrn,
    commentary: "Join us",
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: { reference: { id: "urn:li:liveVideo:7249811612692275200" } },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  });
  assert.deepEqual(posted, { postId: "urn:li:ugcPost:7249811999999999999" });
});

it("posts an external event with content.reference urn:li:event:{id}", async () => {
  const { calls, native: api } = native(
    () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:ugcPost:1" } }),
  );

  await api.createEventPost({
    account: organization,
    reference: "urn:li:event:7249812147952566272",
    context: nativeContext,
  });

  assert.deepEqual(object(calls[0]?.body?.["content"])["reference"], {
    id: "urn:li:event:7249812147952566272",
  });

  await assert.rejects(
    api.createEventPost({
      account: organization,
      reference: "urn:li:share:1",
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(calls.length, 1);
});

it("gets, updates and lists events with GET /rest/events and the eventsByOrganizer finder", async () => {
  const eventJson = `{"vanityName":"kneel","discoveryMode":"URL_ONLY","ugcPost":"urn:li:ugcPost:7246780305028571136","organizer":"urn:li:organization:7185861","name":{"localized":{"en_US":"test online event"}},"startsAt":9091536064111,"id":7246559654799892480,"type":{"online":{"format":{"external":{"endsAt":9091536065000,"url":"https://example.com"}}}}}`;

  const { calls, native: api } = native((call) => {
    if (call.method === "POST") return new Response(null, { status: 200 });

    if (call.url.includes("q=eventsByOrganizer"))
      return json(
        `{"elements":[${eventJson}],"paging":{"count":1,"start":0,"links":[{"rel":"next","href":"/events?start=1"}]}}`,
      );

    return json(eventJson);
  });

  const event = await api.getEvent({
    account: organization,
    event: "urn:li:event:7246559654799892480",
    context: nativeContext,
  });

  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/events/7246559654799892480");
  assert.equal(event.ugcPost, "urn:li:ugcPost:7246780305028571136");
  assert.equal(event.name, "test online event");
  assert.equal(event.kind, "external");

  await api.updateEvent({
    account: organization,
    event: "urn:li:event:7246559654799892480",
    changes: {
      name: "Updated",
      startsAt: 1773568800000,
      discoveryMode: "LISTED",
      backgroundImage: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
      type: { kind: "external", endsAt: 1773576000000, url: "https://example.com/new" },
    },
    context: nativeContext,
  });

  assert.equal(calls[1]?.url, "https://api.linkedin.com/rest/events/7246559654799892480");
  assert.equal(calls[1]?.method, "POST");
  assert.equal(calls[1]?.headers.get("X-RestLi-Method"), "PARTIAL_UPDATE");
  assert.deepEqual(calls[1]?.body, {
    patch: {
      $set: {
        name: { localized: { en_US: "Updated" } },
        startsAt: 1773568800000,
        backgroundImage: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
        discoveryMode: "LISTED",
      },
      // Rest.li `$set` replaces a whole record, so type sub-fields go in a nested patch.
      type: {
        online: {
          format: {
            external: { $set: { endsAt: 1773576000000, url: "https://example.com/new" } },
          },
        },
      },
    },
  });

  const page = await api.listEvents({
    account: organization,
    excludeCancelled: true,
    timeBasedFilter: { lifeCycleState: "PAST" },
    entryCriteria: "PUBLIC",
    sortOrder: "END_TIME_DESC",
    limit: 1,
    context: nativeContext,
  });

  assert.equal(
    calls[2]?.url,
    "https://api.linkedin.com/rest/events?q=eventsByOrganizer&organizer=urn%3Ali%3Aorganization%3A7185861&start=0&count=1&excludeCancelled=true&timeBasedFilter=(lifeCycleState:PAST)&entryCriteria=PUBLIC&sortOrder=END_TIME_DESC",
  );
  assert.equal(page.items[0]?.eventUrn, "urn:li:event:7246559654799892480");
  assert.equal(page.nextCursor, "1");

  await api.listEvents({
    account: organization,
    timeBasedFilter: { startTimeRange: { start: 1741600500, end: 1771062900 } },
    context: nativeContext,
  });

  assert.equal(
    calls[3]?.url,
    "https://api.linkedin.com/rest/events?q=eventsByOrganizer&organizer=urn%3Ali%3Aorganization%3A7185861&start=0&count=25&timeBasedFilter=(startTimeRange:(start:1741600500,end:1771062900))",
  );

  await assert.rejects(
    api.updateEvent({
      account: organization,
      event: "urn:li:event:7246559654799892480",
      changes: {},
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );

  const foreign = native(() =>
    json(eventJson.replace("urn:li:organization:7185861", "urn:li:organization:999")),
  );

  await assert.rejects(
    foreign.native.getEvent({
      account: organization,
      event: "urn:li:event:7246559654799892480",
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "unauthorized",
  );
});

it("uploads an event backgroundImage with assets?action=registerUpload then the upload URL", async () => {
  const uploadUrl =
    "https://api.linkedin.com/mediaUpload/sp/sync/D5522AQEFM6ArFzip2Q/uploaded-image/0?sync=1";

  const { calls, native: api } = native((call) =>
    call.url.includes("registerUpload")
      ? Response.json({
          value: {
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                uploadUrl,
                headers: { "media-type-family": "STILLIMAGE" },
              },
            },
            asset: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
          },
        })
      : new Response(null, { status: 201 }),
  );

  const image = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

  const asset = await api.uploadEventBackgroundImage({
    account: organization,
    image,
    mimeType: "image/jpeg",
    context: nativeContext,
  });

  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/assets?action=registerUpload");
  assert.deepEqual(calls[0]?.body, {
    registerUploadRequest: {
      owner: organizationUrn,
      recipes: ["urn:li:digitalmediaRecipe:event-background-image"],
      serviceRelationships: [
        { identifier: "urn:li:userGeneratedContent", relationshipType: "OWNER" },
      ],
      supportedUploadMechanism: ["SYNCHRONOUS_UPLOAD"],
    },
  });
  assert.equal(calls[1]?.url, uploadUrl);
  assert.equal(calls[1]?.method, "POST");
  assert.equal(calls[1]?.headers.get("content-type"), "image/jpeg");
  assert.equal(calls[1]?.headers.get("authorization"), "Bearer secret");
  assert.equal(asset, "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q");

  const offHost = native((call) =>
    call.url.includes("registerUpload")
      ? Response.json({
          value: {
            uploadMechanism: {
              "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                uploadUrl: "https://uploads.example.com/upload",
              },
            },
            asset: "urn:li:digitalmediaAsset:D5522AQEFM6ArFzip2Q",
          },
        })
      : new Response(null, { status: 201 }),
  );

  await assert.rejects(
    offHost.native.uploadEventBackgroundImage({
      account: organization,
      image,
      mimeType: "image/jpeg",
      context: nativeContext,
    }),
    (error: SocialError) => error.code === "invalid_input",
  );
  assert.equal(offHost.calls.length, 1);
});

it("updates only the supplied event type sub-fields with a nested Rest.li patch", async () => {
  const { calls, native: api } = native(() => new Response(null, { status: 200 }));

  const update = (type: NonNullable<Parameters<typeof api.updateEvent>[0]["changes"]["type"]>) =>
    api.updateEvent({
      account: organization,
      event: "urn:li:event:7246559654799892480",
      changes: { type },
      context: nativeContext,
    });

  await update({ kind: "external", endsAt: 1773576000000 });
  await update({ kind: "inPerson", venueDetails: "Room 101" });
  await update({ kind: "liveVideo", endsAt: 1773576000000 });

  // A `$set.type` record here would drop the existing url, endsAt or address.
  assert.deepEqual(
    calls.map((call) => call.body),
    [
      {
        patch: { type: { online: { format: { external: { $set: { endsAt: 1773576000000 } } } } } },
      },
      {
        patch: {
          type: {
            inPerson: { $set: { venueDetails: { localized: { en_US: { rawText: "Room 101" } } } } },
          },
        },
      },
      {
        patch: { type: { online: { format: { liveVideo: { $set: { endsAt: 1773576000000 } } } } } },
      },
    ],
  );

  await assert.rejects(update({ kind: "external" }), (error: SocialError) => {
    return error.code === "invalid_input";
  });
  assert.equal(calls.length, 3);
});
