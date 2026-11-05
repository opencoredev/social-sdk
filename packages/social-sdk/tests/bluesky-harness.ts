import { strict as assert } from "node:assert";
import { bluesky } from "../src/platforms/bluesky.js";
import { connectedAccountRef, type JsonObject, type JsonValue } from "../src/core/index.js";
import { definedFields } from "../src/core/fields.js";
import { isJsonValue } from "../src/transport/json.js";
import { object } from "../src/transport/validation.js";

/** Shared offline fixture for Bluesky contract tests: a recording fake fetch. */
export const did = "did:plc:test";

export const account = connectedAccountRef({
  backend: "default",
  platform: "bluesky",
  accountId: did,
});

export interface Call {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body?: JsonObject;
  readonly raw?: BodyInit;
}

export function json(value: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** HTTP 200 with no body, which XRPC procedures without an output return. */
export function empty(): Response {
  return new Response(null, { status: 200 });
}

function decode(body: BodyInit | null | undefined, headers: Headers): JsonObject | undefined {
  if (body === undefined || body === null || !headers.get("content-type")?.includes("json"))
    return undefined;

  const parsed: unknown = JSON.parse(String(body));
  assert.ok(isJsonValue(parsed));

  return object(parsed);
}

export function recorder(route: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ?? undefined;

    const headers = new Headers(init?.headers);

    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input instanceof Request ? input.url : String(input)),
      headers,
      ...definedFields({ body: decode(body, headers), raw: body }),
    };

    calls.push(call);

    return route(call);
  };

  return { calls, fetch };
}

export function harness(route: (call: Call) => Response | Promise<Response>) {
  const { calls, fetch } = recorder(route);

  const adapter = bluesky({
    auth: { service: "https://pds.example", did, accessJwt: "fixture" },
    fetch,
  });

  assert.ok(adapter.native);

  return { native: adapter.native, calls };
}

export const post = {
  uri: `at://did:plc:author/app.bsky.feed.post/3kpost`,
  cid: "bafyreipostcid",
};

export const repost = {
  uri: `at://did:plc:reposter/app.bsky.feed.repost/3krepost`,
  cid: "bafyreirepostcid",
};

export const starterPack = {
  uri: `at://did:plc:curator/app.bsky.graph.starterpack/3kpack`,
  cid: "bafyreipackcid",
};
