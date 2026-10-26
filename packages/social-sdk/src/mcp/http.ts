import type { AuthorizationContext, JsonObject, JsonValue } from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { isJsonObject } from "../transport/validation.js";
import {
  integerOption,
  isSupportedProtocolVersion,
  jsonRpcError,
  jsonRpcErrorCodes,
  requestContext,
  type McpResponse,
  type McpServer,
} from "./server.js";

export interface McpHttpOptions {
  /**
   * Authenticate the HTTP caller and return the tenant context for every tool
   * call in the request. Return `null` to answer 401. This runs before the
   * body is read.
   */
  readonly authorize: (request: Request) => Promise<AuthorizationContext | null>;
  /**
   * Browser origins allowed to call the endpoint. Requests that carry any
   * other `Origin` header are rejected to block DNS rebinding. Default none.
   */
  readonly allowedOrigins?: readonly string[];
  /** Largest accepted request body. Default 1 MiB. */
  readonly maxBodyBytes?: number;
}

function json(status: number, body: McpResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function sse(body: McpResponse): Response {
  const messages: readonly JsonObject[] = isJsonObject(body) ? [body] : body;

  const events = messages
    .map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`)
    .join("");

  return new Response(events, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** Reads at most `maxBytes`; returns `undefined` when the body is larger. */
async function boundedText(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);

  if (Number.isFinite(declared) && declared > maxBytes) return undefined;

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let length = 0;
  let text = "";

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;
      length += chunk.value.byteLength;

      if (length > maxBytes) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  return text + decoder.decode();
}

function parseBody(text: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A stateless MCP Streamable HTTP endpoint as a Web `Request` handler, for
 * Bun, Deno, Workers, Next.js route handlers, Hono and other fetch servers.
 * Each POST carries one JSON-RPC message or batch. Responses are JSON unless the client
 * accepts only `text/event-stream`. There is no server-initiated stream, so GET
 * and DELETE answer 405.
 */
export function createMcpHttpHandler(
  server: McpServer,
  options: McpHttpOptions,
): (request: Request) => Promise<Response> {
  // NaN would disable the body bound, and zero would refuse every request.
  const maxBodyBytes = integerOption({
    value: options.maxBodyBytes,
    fallback: 1024 * 1024,
    min: 1,
    name: "maxBodyBytes",
    operation: "mcp.http",
  });

  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  return async (request) => {
    const origin = request.headers.get("origin");

    if (origin !== null && !allowedOrigins.has(origin))
      return json(403, jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Origin not allowed"));

    if (request.method !== "POST") {
      const response = json(
        405,
        jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Method not allowed"),
      );

      response.headers.set("allow", "POST");

      return response;
    }

    const authorization = await options.authorize(request);

    if (authorization === null)
      return json(401, jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Unauthorized"));

    const version = request.headers.get("mcp-protocol-version");

    if (version !== null && !isSupportedProtocolVersion(version))
      return json(
        400,
        jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Unsupported MCP protocol version"),
      );

    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json"))
      return json(
        415,
        jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Content-Type must be JSON"),
      );

    const text = await boundedText(request, maxBodyBytes);

    if (text === undefined)
      return json(413, jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Body too large"));
    const message = parseBody(text);

    if (message === undefined)
      return json(400, jsonRpcError(null, jsonRpcErrorCodes.parseError, "Parse error"));

    const response = await server.handle(message, requestContext(authorization, request.signal));

    if (response === undefined) return new Response(null, { status: 202 });

    const accept = (request.headers.get("accept") ?? "").toLowerCase();

    return accept.includes("text/event-stream") && !accept.includes("application/json")
      ? sse(response)
      : json(200, response);
  };
}
