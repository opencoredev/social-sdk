import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import { instagram } from "../src/platforms/instagram.js";
import { threads } from "../src/platforms/threads.js";
import type { MediaAttachment, MediaRef } from "../src/core/types.js";

/* oxlint-disable anti-slop/require-readable-spacing -- Keep fixture branches compact. */

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 1000 },
};

const account = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: "urn:li:person:member1",
});

const auth = { accessToken: "secret", author: "urn:li:person:member1" as const };
const documentUrn = "urn:li:document:D5510AQH";
const uploadUrl = "https://www.linkedin.com/dms-uploads/sp/v2/D5510AQH/uploaded-document/0";

const documentRef = (overrides: Partial<MediaRef> = {}): MediaRef => ({
  kind: "media",
  version: 1,
  backend: "default",
  platform: "linkedin",
  accountId: auth.author,
  mediaId: documentUrn,
  ...overrides,
});

const documentMedia = (overrides: Partial<MediaAttachment> = {}): MediaAttachment => ({
  kind: "document",
  source: { kind: "media-ref", ref: documentRef() },
  caption: "Quarterly report.pdf",
  ...overrides,
});

const pdf = (bytes = 12) => new Blob([new Uint8Array(bytes)], { type: "application/pdf" });

it("LinkedIn document upload initializes with the author and PUTs the bytes without the API token", async () => {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          headers,
          body: init?.body instanceof ReadableStream ? "<stream>" : String(init?.body),
        });

        if (url === "https://api.linkedin.com/rest/documents?action=initializeUpload")
          return Response.json({
            value: { uploadUrlExpiresAt: 1_790_000_000_000, uploadUrl, document: documentUrn },
          });

        if (url === uploadUrl) {
          if (init?.body instanceof ReadableStream) await new Response(init.body).arrayBuffer();

          return new Response(null, { status: 201 });
        }

        throw new Error(`unexpected ${url}`);
      },
    }),
  });

  const ref = await social.media.upload(
    {
      kind: "document",
      mimeType: "application/pdf",
      filename: "report.pdf",
      source: { kind: "blob", blob: pdf() },
    },
    account,
  );

  assert.equal(ref.mediaId, documentUrn);
  assert.equal(ref.accountId, auth.author);
  assert.equal(calls.length, 2);
  const [initialize, put] = calls;
  assert.equal(initialize?.method, "POST");
  assert.equal(initialize?.headers.get("Linkedin-Version"), "202609");
  assert.deepEqual(JSON.parse(initialize?.body ?? "{}"), {
    initializeUploadRequest: { owner: auth.author },
  });
  assert.equal(put?.method, "PUT");
  assert.equal(put?.headers.get("Authorization"), null);
  assert.equal(put?.headers.get("Content-Type"), "application/pdf");
});

it("LinkedIn document upload rejects unsupported types, empty files and oversize files before any request", async () => {
  let calls = 0;

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async () => {
        calls++;

        return new Response(null, { status: 500 });
      },
    }),
  });

  const attempts: MediaAttachment[] = [
    {
      kind: "document",
      mimeType: "text/plain",
      source: { kind: "blob", blob: new Blob(["x"], { type: "text/plain" }) },
    },
    { kind: "document", mimeType: "application/pdf", source: { kind: "blob", blob: pdf(0) } },
    {
      kind: "document",
      mimeType: "application/pdf",
      byteSize: 100_000_001,
      source: { kind: "stream", open: () => new Blob([]).stream() },
    },
    {
      kind: "document",
      mimeType: "application/pdf",
      source: { kind: "https-url", url: "https://example.com/report.pdf" },
    },
  ];

  for (const attachment of attempts)
    await assert.rejects(social.media.upload(attachment, account), {
      name: "SocialError",
      code: "invalid_input",
    });

  assert.equal(calls, 0);
});

it("LinkedIn document upload rejects an invalid URN and maps storage failures without leaking the upload URL", async () => {
  for (const scenario of ["bad-urn", "storage-500"] as const) {
    const urls: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (input) => {
          const url = String(input);
          urls.push(url);

          if (url.includes("initializeUpload"))
            return Response.json({
              value: {
                uploadUrl,
                document: scenario === "bad-urn" ? "urn:li:image:nope" : documentUrn,
              },
            });

          return new Response(null, { status: 500 });
        },
      }),
    });

    const base = {
      name: "SocialError",
      code: "media_error",
      message: /^(?![\s\S]*(dms-uploads|secret))/,
    };

    const expected = scenario === "storage-500" ? { ...base, upstreamStatus: 500 } : base;

    await assert.rejects(
      social.media.upload(
        { kind: "document", mimeType: "application/pdf", source: { kind: "blob", blob: pdf() } },
        account,
      ),
      expected,
    );

    assert.equal(urls.length, scenario === "bad-urn" ? 1 : 2);
  }
});

it("LinkedIn publishes an AVAILABLE document with the documented media id and title", async () => {
  const requests: { url: string; method: string; body: string }[] = [];

  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body instanceof ReadableStream ? "<stream>" : String(init?.body),
        });

        if (url === `https://api.linkedin.com/rest/documents/${encodeURIComponent(documentUrn)}`)
          return Response.json({
            id: documentUrn,
            owner: auth.author,
            status: "AVAILABLE",
            downloadUrl: "https://media.licdn.com/signed",
          });

        if (url === "https://api.linkedin.com/rest/posts")
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:7000000000000000001" },
          });

        throw new Error(`unexpected ${url}`);
      },
    }),
  });

  const request = {
    targets: [{ account }],
    content: { text: "Our report", media: [documentMedia()] },
  };

  assert.equal(social.posts.prepare(request).ok, true);
  const result = await social.posts.publish(request);
  assert.equal(result.outcomes[0]?.state, "published");
  assert.deepEqual(
    requests.map((entry) => entry.method),
    ["GET", "POST"],
  );
  const body = JSON.parse(requests[1]?.body ?? "{}");
  assert.deepEqual(body.content, {
    media: { id: documentUrn, title: "Quarterly report.pdf" },
  });
  assert.equal(body.author, auth.author);
  assert.equal(JSON.stringify(result).includes("signed"), false);
});

it("LinkedIn does not create a post for a document that is still processing or owned elsewhere", async () => {
  for (const document of [
    { id: documentUrn, owner: auth.author, status: "PROCESSING" },
    { id: documentUrn, owner: auth.author, status: "PROCESSING_FAILED" },
    { id: documentUrn, owner: "urn:li:person:other", status: "AVAILABLE" },
    { id: "urn:li:document:other", owner: auth.author, status: "AVAILABLE" },
  ]) {
    const methods: string[] = [];

    const social = createSocial({
      backend: linkedin({
        auth,
        apiVersion: "202609",
        fetch: async (_input, init) => {
          methods.push(init?.method ?? "GET");

          return Response.json(document);
        },
      }),
    });

    const result = await social.posts.publish({
      targets: [{ account }],
      content: { media: [documentMedia()] },
    });

    assert.equal(result.outcomes[0]?.state, "failed");
    assert.deepEqual(methods, ["GET"]);
  }
});

it("LinkedIn prepare rejects document posts without a title, with extra media, foreign refs or alt text", () => {
  const social = createSocial({
    backend: linkedin({
      auth,
      apiVersion: "202609",
      fetch: async () => new Response(null, { status: 500 }),
    }),
  });

  const image: MediaAttachment = {
    kind: "image",
    source: {
      kind: "media-ref",
      ref: documentRef({ mediaId: "urn:li:image:img1" }),
    },
  };

  const cases: [MediaAttachment[], string][] = [
    [[documentMedia({ caption: "  " })], "linkedin.document_title"],
    [[documentMedia(), image], "linkedin.document_count"],
    [[documentMedia(), documentMedia()], "linkedin.document_count"],
    [
      [documentMedia({ source: { kind: "media-ref", ref: documentRef({ backend: "other" }) } })],
      "linkedin.media_owner",
    ],
    [
      [
        documentMedia({
          source: { kind: "media-ref", ref: documentRef({ mediaId: "urn:li:image:img1" }) },
        }),
      ],
      "linkedin.media_owner",
    ],
    [[documentMedia({ altText: "Report" })], "linkedin.document_alt_text"],
    [
      [
        documentMedia({
          mimeType: "application/pdf",
          source: { kind: "blob", blob: pdf() },
        }),
      ],
      "linkedin.document",
    ],
  ];

  for (const [media, code] of cases) {
    const preparation = social.posts.prepare({ targets: [{ account }], content: { media } });
    assert.equal(preparation.ok, false);
    assert.ok(
      preparation.issues.some((issue) => issue.code === code),
      `expected ${code}`,
    );
  }

  const fromFilename = social.posts.prepare({
    targets: [{ account }],
    content: { media: [documentMedia({ caption: undefined, filename: "deck.pptx" })] },
  });
  assert.equal(fromFilename.ok, true);
});

it("LinkedIn native documentStatus returns id, owner and status without the signed download URL", async () => {
  const adapter = linkedin({
    auth,
    apiVersion: "202609",
    fetch: async () =>
      Response.json({
        id: documentUrn,
        owner: auth.author,
        status: "PROCESSING",
        downloadUrl: "https://media.licdn.com/signed",
        downloadUrlExpiresAt: 1_790_000_000_000,
      }),
  });

  const status = await adapter.native!.documentStatus(documentRef(), nativeContext);
  assert.deepEqual(status, { id: documentUrn, owner: auth.author, status: "PROCESSING" });

  await assert.rejects(
    adapter.native!.documentStatus(documentRef({ mediaId: "urn:li:image:img1" }), nativeContext),
    { name: "SocialError", code: "invalid_input" },
  );
});

it("LinkedIn advertises document posts and document uploads", () => {
  const adapter = linkedin({
    auth,
    apiVersion: "202609",
    fetch: async () => new Response(null, { status: 500 }),
  });

  const declaration = (operation: string) =>
    adapter.capabilities.capabilities.find((entry) => entry.operation === operation);

  assert.equal(declaration("posts.document")?.availability, "available");
  assert.deepEqual(declaration("posts.document")?.formats, ["document"]);
  assert.deepEqual(declaration("posts.document")?.requiredScopes, ["w_member_social"]);
  assert.ok(declaration("media.upload")?.formats?.includes("document"));
});

it("Instagram and Threads reject document attachments during preparation", () => {
  const attachment: MediaAttachment = {
    kind: "document",
    mimeType: "application/pdf",
    source: { kind: "https-url", url: "https://example.com/report.pdf" },
  };

  const social = createSocial({
    backends: {
      ig: instagram({
        auth: { accountId: "17841400000000000", accessToken: "secret" },
        fetch: async () => new Response(null, { status: 500 }),
      }),
      th: threads({
        auth: { userId: "1234567890", accessToken: "secret" },
        fetch: async () => new Response(null, { status: 500 }),
      }),
    },
  });

  for (const [backend, platform, accountId] of [
    ["ig", "instagram", "17841400000000000"],
    ["th", "threads", "1234567890"],
  ] as const) {
    const preparation = social.posts.prepare({
      targets: [{ account: connectedAccountRef({ backend, platform, accountId }) }],
      content: { media: [attachment] },
    });
    assert.equal(preparation.ok, false);
  }
});
