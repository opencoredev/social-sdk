import { SocialError } from "../src/core/errors.js";
import { it } from "node:test";
import assert from "node:assert/strict";
import { connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { object } from "../src/transport/validation.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const memberUrn = "urn:li:person:member1";

const organizationUrn = "urn:li:organization:2414183";

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

function recorder(respond: (call: Call) => Response) {
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

const native = (author: string, respond: (call: Call) => Response) => {
  const { calls, fetch } = recorder(respond);

  const adapter = linkedin({
    auth: {
      accessToken: "secret",
      author: author.startsWith("urn:li:organization:") ? organizationUrn : memberUrn,
    },
    apiVersion: "202610",
    fetch,
  });

  return { calls, native: adapter.native! };
};

const pollPost = {
  id: "urn:li:ugcPost:6924414938606112768",
  author: organizationUrn,
  commentary: "test poll",
  visibility: "PUBLIC",
  lifecycleState: "PUBLISHED",
  createdAt: 1650909170969,
  publishedAt: 1650909170969,
  isReshareDisabledByAuthor: false,
  lifecycleStateInfo: { isEditedByAuthor: false },
  content: {
    poll: {
      question: "What is your favorite color?",
      options: [
        { text: "Red", voteCount: 3, isVotedByViewer: false },
        { text: "Blue", isVotedByViewer: false },
      ],
      settings: { voteSelectionType: "SINGLE_VOTE", duration: "THREE_DAYS" },
      uniqueVotersCount: 3,
    },
  },
};

it("reads a post with viewContext=AUTHOR and decodes poll results", async () => {
  const { calls, native: api } = native(organizationUrn, () => Response.json(pollPost));

  const post = await api.getPost({
    account: organization,
    postId: "urn:li:ugcPost:6924414938606112768",
    viewContext: "AUTHOR",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/posts/urn%3Ali%3AugcPost%3A6924414938606112768?viewContext=AUTHOR",
  );
  assert.equal(post.publishedAt, 1650909170969);
  assert.equal(post.isEditedByAuthor, false);
  assert.deepEqual(post.poll, {
    question: "What is your favorite color?",
    options: [{ text: "Red", voteCount: 3 }, { text: "Blue" }],
    uniqueVotersCount: 3,
    duration: "THREE_DAYS",
    voteSelectionType: "SINGLE_VOTE",
  });

  const foreign = native(organizationUrn, () =>
    Response.json({ ...pollPost, author: "urn:li:organization:999" }),
  );

  await assert.rejects(
    foreign.native.getPost({
      account: organization,
      postId: pollPost.id,
      context: nativeContext,
    }),
    /another author/,
  );
});

it("batch gets posts with ids=List(...) and BATCH_GET, keeping per-post errors", async () => {
  const { calls, native: api } = native(organizationUrn, () =>
    Response.json({
      results: { [pollPost.id]: pollPost },
      statuses: { [pollPost.id]: 200, "urn:li:share:404": 404 },
      errors: { "urn:li:share:404": { status: 404, message: "Not found" } },
    }),
  );

  const batch = await api.getPosts({
    account: organization,
    postIds: [pollPost.id, "urn:li:share:404"],
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/posts?ids=List(urn%3Ali%3AugcPost%3A6924414938606112768,urn%3Ali%3Ashare%3A404)&viewContext=READER",
  );
  assert.equal(calls[0]?.headers.get("X-RestLi-Method"), "BATCH_GET");
  assert.equal(batch.posts[0]?.poll?.uniqueVotersCount, 3);
  assert.deepEqual(batch.errors, [{ postId: "urn:li:share:404", status: 404 }]);
  await assert.rejects(
    api.getPosts({ account: organization, postIds: [], context: nativeContext }),
    /1 to 100/,
  );
});

it("reads socialMetadata reactionSummaries and comment totals", async () => {
  const { calls, native: api } = native(organizationUrn, () =>
    Response.json({
      reactionSummaries: {
        EMPATHY: { reactionType: "EMPATHY", count: 1 },
        LIKE: { reactionType: "LIKE", count: 7 },
      },
      commentsState: "OPEN",
      commentSummary: { count: 4, topLevelCount: 3 },
      entity: "urn:li:activity:6524387688164966400",
    }),
  );

  const metadata = await api.getSocialMetadata({
    account: organization,
    entity: "urn:li:share:6524387688164966400",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialMetadata/urn%3Ali%3Ashare%3A6524387688164966400",
  );
  assert.deepEqual(metadata, {
    reactions: { EMPATHY: 1, LIKE: 7 },
    entity: "urn:li:activity:6524387688164966400",
    commentsState: "OPEN",
    comments: { total: 4, topLevel: 3 },
  });
});

it("closes comments with a commentsState partial update on socialMetadata", async () => {
  const { calls, native: api } = native(organizationUrn, () => new Response(null, { status: 202 }));

  await api.setCommentsState({
    account: organization,
    postId: "urn:li:share:123",
    state: "CLOSED",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialMetadata/urn%3Ali%3Ashare%3A123?actor=urn%3Ali%3Aorganization%3A2414183",
  );
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.headers.get("X-RestLi-Method"), "PARTIAL_UPDATE");
  assert.deepEqual(calls[0]?.body, { patch: { $set: { commentsState: "CLOSED" } } });
});

it("lists reactions with the q=entity finder and deletes a reaction by compound key", async () => {
  const { calls, native: api } = native(memberUrn, (call) =>
    call.method === "DELETE"
      ? new Response(null, { status: 204 })
      : Response.json({
          elements: [
            {
              id: "urn:li:reaction:(urn:li:person:rboDhL7Xsf,urn:li:activity:7067167295080394752)",
              reactionType: "LIKE",
              created: { actor: "urn:li:person:rboDhL7Xsf", time: 1686257332832 },
              root: "urn:li:activity:7067167295080394752",
            },
          ],
          paging: { count: 1, start: 0, total: 2, links: [] },
        }),
  );

  const page = await api.listReactions({
    account: member,
    entity: "urn:li:comment:(urn:li:activity:7019389037459226624,7021942390034694144)",
    limit: 1,
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/reactions/(entity:urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A7019389037459226624%2C7021942390034694144%29)?q=entity&sort=(value:REVERSE_CHRONOLOGICAL)&start=0&count=1",
  );
  assert.deepEqual(page.items, [
    {
      reactionType: "LIKE",
      id: "urn:li:reaction:(urn:li:person:rboDhL7Xsf,urn:li:activity:7067167295080394752)",
      actor: "urn:li:person:rboDhL7Xsf",
      root: "urn:li:activity:7067167295080394752",
      createdAt: 1686257332832,
    },
  ]);
  assert.equal(page.nextCursor, "1");

  await api.deleteReaction({
    account: member,
    entity: "urn:li:share:7021942390034694144",
    context: nativeContext,
  });

  assert.equal(calls[1]?.method, "DELETE");
  assert.equal(
    calls[1]?.url,
    "https://api.linkedin.com/rest/reactions/(actor:urn%3Ali%3Aperson%3Amember1,entity:urn%3Ali%3Ashare%3A7021942390034694144)",
  );
});

const parentComment = "urn:li:comment:(urn:li:activity:6273189577469632512,6275822846992351232)";

it("lists nested replies to a comment after checking its post [feature:linkedin.comments.list.nested]", async () => {
  const { calls, native: api } = native(organizationUrn, (call) =>
    call.url.endsWith("/comments/6275822846992351232")
      ? Response.json({ commentUrn: parentComment, object: "urn:li:activity:6273189577469632512" })
      : Response.json({
          elements: [
            {
              id: "6636062862760562688",
              actor: "urn:li:person:f49f2kf0",
              commentUrn:
                "urn:li:comment:(urn:li:activity:6273189577469632512,6636062862760562688)",
              parentComment,
              message: { text: "Nested reply", attributes: [] },
              object: "urn:li:activity:6273189577469632512",
            },
          ],
          paging: { start: 0, count: 10, links: [] },
        }),
  );

  const page = await api.listCommentReplies({
    account: organization,
    postId: "urn:li:share:6273189577469632512",
    commentId: parentComment,
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A6273189577469632512/comments/6275822846992351232",
  );
  assert.equal(
    calls[1]?.url,
    // Rest.li 2.0 resource keys encode the composite URN parentheses as %28 and %29.
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A6273189577469632512%2C6275822846992351232%29/comments?start=0&count=25",
  );
  assert.equal(page.items[0]?.["text"], "Nested reply");
  assert.equal(page.items[0]?.["parentComment"], parentComment);
  assert.equal(page.nextCursor, undefined);
});

it("creates a top-level comment with mentions and an image [feature:linkedin.comments.create_top_level]", async () => {
  const { calls, native: api } = native(organizationUrn, (call) =>
    call.method === "GET"
      ? Response.json({ id: "urn:li:image:C552", owner: organizationUrn, status: "AVAILABLE" })
      : Response.json(
          {
            commentUrn: "urn:li:comment:(urn:li:activity:6641861161010679808,6643206422739898368)",
            id: "6643206422739898368",
          },
          { status: 201 },
        ),
  );

  const created = await api.createComment({
    account: organization,
    postId: "urn:li:share:6305471423242596352",
    text: "Dunder Mifflin's Dundie Award goes to Dwight Schrute!",
    mentions: [
      { start: 0, length: 14, urn: "urn:li:organization:2414183" },
      { start: 38, length: 14, urn: "urn:li:person:uOeeiwWoxO" },
    ],
    image: {
      kind: "media",
      version: 1,
      backend: "default",
      platform: "linkedin",
      accountId: organizationUrn,
      mediaId: "urn:li:image:C552",
    },
    context: nativeContext,
  });

  assert.equal(calls[0]?.url, "https://api.linkedin.com/rest/images/urn%3Ali%3Aimage%3AC552");
  assert.equal(
    calls[1]?.url,
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Ashare%3A6305471423242596352/comments",
  );
  assert.deepEqual(calls[1]?.body, {
    actor: organizationUrn,
    object: "urn:li:share:6305471423242596352",
    message: {
      text: "Dunder Mifflin's Dundie Award goes to Dwight Schrute!",
      attributes: [
        { start: 0, length: 14, value: { organization: { organization: organizationUrn } } },
        { start: 38, length: 14, value: { person: { person: "urn:li:person:uOeeiwWoxO" } } },
      ],
    },
    content: [{ entity: { image: "urn:li:image:C552" } }],
  });
  assert.deepEqual(created, {
    commentUrn: "urn:li:comment:(urn:li:activity:6641861161010679808,6643206422739898368)",
    id: "6643206422739898368",
  });
});

it("creates nested replies, rejects bad mentions locally, and reports a missing comment URN as ambiguous", async () => {
  const { calls, native: api } = native(memberUrn, () => Response.json({}, { status: 201 }));

  await assert.rejects(
    api.createComment({
      account: member,
      postId: "urn:li:share:1",
      text: "Thanks Jane",
      parentCommentId: parentComment,
      context: nativeContext,
    }),
    /Reconcile before retrying/,
  );
  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3Acomment%3A%28urn%3Ali%3Aactivity%3A6273189577469632512%2C6275822846992351232%29/comments",
  );
  assert.deepEqual(calls[0]?.body, {
    actor: memberUrn,
    object: "urn:li:share:1",
    message: { text: "Thanks Jane" },
    parentComment,
  });

  await assert.rejects(
    api.createComment({
      account: member,
      postId: "urn:li:share:1",
      text: "Thanks Jane",
      mentions: [{ start: 7, length: 10, urn: "urn:li:person:jane" }],
      context: nativeContext,
    }),
    /non-overlapping/,
  );
  assert.equal(calls.length, 1);
});

it("edits a comment with message.$set and the organization actor", async () => {
  const { calls, native: api } = native(organizationUrn, () => Response.json({}));

  await api.editComment({
    account: organization,
    postId: "urn:li:ugcPost:701614862413057",
    commentId: "urn:li:comment:(urn:li:activity:6912417282191147008,70172482676457473)",
    text: "Updated comment message",
    context: nativeContext,
  });

  assert.equal(
    calls[0]?.url,
    "https://api.linkedin.com/rest/socialActions/urn%3Ali%3AugcPost%3A701614862413057/comments/70172482676457473?actor=urn%3Ali%3Aorganization%3A2414183",
  );
  assert.equal(calls[0]?.headers.get("X-RestLi-Method"), "PARTIAL_UPDATE");
  assert.deepEqual(calls[0]?.body, {
    patch: { message: { $set: { text: "Updated comment message", attributes: [] } } },
  });
});

it("a comment create answered with a non-object body is an uncertain outcome", async () => {
  for (const answer of ["null", "[]"]) {
    const { calls, native: api } = native(
      memberUrn,
      () => new Response(answer, { status: 201, headers: { "content-type": "application/json" } }),
    );

    await assert.rejects(
      api.createComment({
        account: member,
        postId: "urn:li:share:1",
        text: "Thanks",
        context: nativeContext,
      }),
      (error: SocialError) =>
        error.code === "ambiguous_outcome" && error.retryDisposition?.kind === "reconcile-first",
    );
    assert.equal(calls.length, 1);
  }
});
