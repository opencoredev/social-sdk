import { it } from "node:test";
import assert from "node:assert/strict";
import { createSocial, connectedAccountRef } from "../src/index.js";
import { linkedin } from "../src/platforms/linkedin.js";
import type { JsonObject, MediaAttachment } from "../src/core/types.js";
import { definedFields } from "../src/core/fields.js";
import { object } from "../src/transport/validation.js";

const nativeContext = {
  backendInstance: "default",
  correlationId: "test",
  retryBudget: { maxAttempts: 1, maxElapsedMs: 5000 },
};

const organizationUrn = "urn:li:organization:2414183";

const account = connectedAccountRef({
  backend: "default",
  platform: "linkedin",
  accountId: organizationUrn,
});

const size = 100_000;

const partUrl = "https://www.linkedin.com/dms-uploads/C5505AQH/uploadedVideo?part=0";

const thumbnailUploadUrl =
  "https://www.linkedin.com/dms-uploads/C5510AQ/ads-video-userUploadedThumbnail/0?sync=0";

const captionsUploadUrl =
  "https://www.linkedin.com/dms-mpf-uploads/C5510AQ/userUploadedCustomCaptions/0?sync=0";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly json?: JsonObject;
  readonly text?: string;
}

function video(extra: Partial<MediaAttachment> = {}): MediaAttachment {
  return {
    kind: "video",
    mimeType: "video/mp4",
    source: { kind: "blob", blob: new Blob([new Uint8Array(size)]), fingerprint: "fixture" },
    byteSize: size,
    ...extra,
  };
}

const thumbnail = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

function fakeLinkedIn(withUrls: { thumbnail: boolean; captions: boolean }) {
  const calls: Call[] = [];

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const api = url.startsWith("https://api.linkedin.com/");
    const text = await new Response(init?.body).text();

    calls.push({
      url,
      method,
      headers,
      ...definedFields({
        json: api && text ? object(JSON.parse(text)) : undefined,
        text: api ? undefined : text,
      }),
    });

    if (url.endsWith("action=initializeUpload"))
      return Response.json({
        value: {
          video: "urn:li:video:C5505AQH",
          uploadInstructions: [{ uploadUrl: partUrl, firstByte: 0, lastByte: size - 1 }],
          uploadToken: "",
          ...definedFields({
            thumbnailUploadUrl: withUrls.thumbnail ? thumbnailUploadUrl : undefined,
            captionsUploadUrl: withUrls.captions ? captionsUploadUrl : undefined,
          }),
        },
      });

    if (url === partUrl) return new Response(null, { status: 200, headers: { etag: '"part-0"' } });

    if (url === thumbnailUploadUrl || url === captionsUploadUrl)
      return new Response(null, { status: 201 });

    return new Response(null, { status: 200 });
  };

  return { calls, fetch };
}

it("uploads a custom thumbnail to thumbnailUploadUrl before finalizing", async () => {
  const { calls, fetch } = fakeLinkedIn({ thumbnail: true, captions: false });

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  const ref = await social.media.upload(
    video({ thumbnail: { kind: "blob", blob: thumbnail, fingerprint: "thumb" } }),
    account,
  );

  assert.equal(ref.mediaId, "urn:li:video:C5505AQH");
  assert.deepEqual(calls[0]?.json, {
    initializeUploadRequest: {
      owner: organizationUrn,
      fileSizeBytes: size,
      uploadCaptions: false,
      uploadThumbnail: true,
    },
  });
  assert.deepEqual(
    calls.map((call) => `${call.method} ${call.url.split("?")[0]}`),
    [
      "POST https://api.linkedin.com/rest/videos",
      "PUT https://www.linkedin.com/dms-uploads/C5505AQH/uploadedVideo",
      "PUT https://www.linkedin.com/dms-uploads/C5510AQ/ads-video-userUploadedThumbnail/0",
      "POST https://api.linkedin.com/rest/videos",
    ],
  );
  assert.equal(calls[2]?.url, thumbnailUploadUrl);
  assert.equal(calls[2]?.headers.get("media-type-family"), "STILLIMAGE");
  assert.equal(calls[2]?.headers.get("content-type"), "application/octet-stream");
  assert.equal(calls[2]?.headers.get("authorization"), null);
  assert.equal(calls[2]?.headers.get("content-length"), "4");
});

it("rejects a missing thumbnailUploadUrl or a non-image thumbnail before sending video bytes", async () => {
  const { calls, fetch } = fakeLinkedIn({ thumbnail: false, captions: false });

  const social = createSocial({
    backend: linkedin({
      auth: { accessToken: "secret", author: organizationUrn },
      apiVersion: "202610",
      fetch,
    }),
  });

  await assert.rejects(
    social.media.upload(
      video({ thumbnail: { kind: "blob", blob: thumbnail, fingerprint: "thumb" } }),
      account,
    ),
    /malformed video upload response/,
  );
  assert.equal(calls.length, 1);

  await assert.rejects(
    social.media.upload(
      video({
        thumbnail: {
          kind: "blob",
          blob: new Blob(["x"], { type: "text/plain" }),
          fingerprint: "t",
        },
      }),
      account,
    ),
    /JPEG or PNG/,
  );
  assert.equal(calls.length, 1);
});

it("uploads SRT captions as multipart form data to captionsUploadUrl with attribution fields", async () => {
  const { calls, fetch } = fakeLinkedIn({ thumbnail: false, captions: true });

  const native = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch,
  }).native!;

  await native.uploadVideo({
    account,
    media: video(),
    captions: new Blob(["1\n00:00:00,000 --> 00:00:02,000\nHello\n"]),
    templateName: "Sunshine birthday wishes",
    linkbackContext: "https://clipchamp.com/content/cc_ta0a5a7e7-sunshine-birthday/",
    context: nativeContext,
  });

  assert.deepEqual(calls[0]?.json, {
    initializeUploadRequest: {
      owner: organizationUrn,
      fileSizeBytes: size,
      uploadCaptions: true,
      uploadThumbnail: false,
      templateName: "Sunshine birthday wishes",
      linkbackContext: "https://clipchamp.com/content/cc_ta0a5a7e7-sunshine-birthday/",
    },
  });

  const captions = calls[2];

  assert.equal(captions?.url, captionsUploadUrl);
  assert.equal(captions?.method, "POST");
  assert.match(captions?.headers.get("content-type") ?? "", /^multipart\/form-data; ?boundary=/);
  assert.match(captions?.text ?? "", /name="metadata"/);
  assert.match(captions?.text ?? "", /"format":"SRT"/);
  assert.match(captions?.text ?? "", /"transcriptType":"CLOSED_CAPTION"/);
  assert.match(captions?.text ?? "", /name="file"; filename="captions\.srt"/);
  assert.match(captions?.text ?? "", /00:00:00,000 --> 00:00:02,000/);
  assert.ok(calls[3]?.url.endsWith("action=finalizeUpload"));
});

it("rejects templateName before API version 202602", async () => {
  const { calls, fetch } = fakeLinkedIn({ thumbnail: false, captions: false });

  const native = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202601",
    fetch,
  }).native!;

  await assert.rejects(
    native.uploadVideo({
      account,
      media: video(),
      templateName: "Template",
      context: nativeContext,
    }),
    /202602/,
  );
  assert.equal(calls.length, 0);
});

it("uploads a captions file at the 20 MiB cap even though its multipart body is larger", async () => {
  const { calls, fetch } = fakeLinkedIn({ thumbnail: false, captions: true });

  const native = linkedin({
    auth: { accessToken: "secret", author: organizationUrn },
    apiVersion: "202610",
    fetch,
  }).native!;

  await native.uploadVideo({
    account,
    media: video(),
    captions: new Blob([new Uint8Array(20 * 1024 * 1024).fill(0x41)]),
    context: nativeContext,
  });

  assert.equal(calls[2]?.url, captionsUploadUrl);
  assert.ok((calls[2]?.text?.length ?? 0) > 20 * 1024 * 1024);
  assert.ok(calls[3]?.url.endsWith("action=finalizeUpload"));
});
