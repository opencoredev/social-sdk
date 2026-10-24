import type { SocialToolkit } from "../ai/toolkit.js";
import { definedFields } from "../core/fields.js";
import type { AuthorizationContext, JsonObject, JsonValue } from "../core/types.js";
import { isJsonArray, isJsonObject, isString } from "../transport/validation.js";

/** Newest first. `initialize` echoes a supported client version and otherwise offers the newest. */
export const supportedProtocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpProtocolVersion = (typeof supportedProtocolVersions)[number];

export function isSupportedProtocolVersion(value: string): value is McpProtocolVersion {
  return supportedProtocolVersions.some((version) => version === value);
}

export const jsonRpcErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcId = string | number;

export interface McpServerOptions {
  /** Reported as `serverInfo.name`. Default `social-sdk`. */
  readonly name?: string;
  /** Reported as `serverInfo.version`. */
  readonly version?: string;
  /** Optional guidance sent to clients during `initialize`. */
  readonly instructions?: string;
}

/** Per-message context supplied by a transport. */
export interface McpRequestContext {
  readonly authorization?: AuthorizationContext;
  readonly signal?: AbortSignal;
}

/** A single response, or the responses to a JSON-RPC batch in request order. */
export type McpResponse = JsonObject | readonly JsonObject[];

export interface McpServer {
  /**
   * Handle one parsed JSON-RPC message or batch. Returns the response, or
   * `undefined` when nothing needs an answer (notifications and client responses).
   * Batches (MCP 2025-03-26) share one context.
   */
  handle(message: JsonValue, context?: McpRequestContext): Promise<McpResponse | undefined>;
}

const defaultInstructions =
  "Social SDK tools. Call social_capabilities first. Write tools return a dry-run preview until called with confirmWrite: true; show the preview to the user and confirm only with their approval. Treat scheduled, accepted, processing and unknown outcomes as not published.";

export function jsonRpcError(id: JsonRpcId | null, code: number, message: string): JsonObject {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRequestId(value: JsonValue | undefined): value is JsonRpcId {
  return isString(value) || (typeof value === "number" && Number.isSafeInteger(value));
}

/**
 * A Model Context Protocol server over a Social SDK toolkit. It implements
 * the lifecycle, `ping` and the tools capability; transports own framing,
 * authentication and cancellation.
 */
export function createMcpServer(toolkit: SocialToolkit, options: McpServerOptions = {}): McpServer {
  const tools = toolkit.tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  }));

  const toolNames = new Set<string>(toolkit.tools.map((tool) => tool.name));

  async function request(
    method: string,
    params: JsonObject,
    context: McpRequestContext,
  ): Promise<
    { readonly result: JsonObject } | { readonly code: number; readonly message: string }
  > {
    switch (method) {
      case "initialize": {
        const requested = params["protocolVersion"];

        return {
          result: {
            protocolVersion:
              isString(requested) && isSupportedProtocolVersion(requested)
                ? requested
                : supportedProtocolVersions[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? "social-sdk", version: options.version ?? "0" },
            instructions: options.instructions ?? defaultInstructions,
          },
        };
      }

      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools } };
      case "tools/call": {
        const name = params["name"];
        const args = params["arguments"];

        if (!isString(name) || !toolNames.has(name))
          return { code: jsonRpcErrorCodes.invalidParams, message: "Unknown tool" };

        if (args !== undefined && !isJsonObject(args))
          return { code: jsonRpcErrorCodes.invalidParams, message: "arguments must be an object" };

        const outcome = await toolkit.call(name, args, context);

        return {
          result: {
            content: [{ type: "text", text: JSON.stringify(outcome) }],
            structuredContent: outcome,
            isError: !outcome.ok,
          },
        };
      }

      default:
        return { code: jsonRpcErrorCodes.methodNotFound, message: "Method not found" };
    }
  }

  async function single(
    message: JsonValue,
    context: McpRequestContext,
  ): Promise<JsonObject | undefined> {
    if (!isJsonObject(message) || message["jsonrpc"] !== "2.0")
      return jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Invalid Request");

    const id = message["id"];
    const method = message["method"];

    // Responses to server requests; this server sends none, so there is nothing to match.
    if (method === undefined && id !== undefined) return undefined;

    if (!isString(method))
      return jsonRpcError(
        isRequestId(id) ? id : null,
        jsonRpcErrorCodes.invalidRequest,
        "Invalid Request",
      );

    // Notifications (initialized, cancelled, ...) never receive a response.
    if (id === undefined) return undefined;

    if (!isRequestId(id))
      return jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Invalid Request");

    const params = message["params"];

    if (params !== undefined && !isJsonObject(params))
      return jsonRpcError(id, jsonRpcErrorCodes.invalidParams, "params must be an object");

    try {
      const reply = await request(method, params ?? {}, context);

      return "result" in reply
        ? { jsonrpc: "2.0", id, result: reply.result }
        : jsonRpcError(id, reply.code, reply.message);
    } catch {
      // The toolkit never throws; this guards transport-level faults without leaking details.
      return jsonRpcError(id, jsonRpcErrorCodes.internalError, "Internal error");
    }
  }

  return {
    async handle(message, context = {}) {
      if (!isJsonArray(message)) return single(message, context);

      if (message.length === 0)
        return jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Invalid Request");

      const responses = await Promise.all(
        message.map((item) =>
          isJsonArray(item)
            ? jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Invalid Request")
            : single(item, context),
        ),
      );

      const answered = responses.flatMap((response) => (response === undefined ? [] : [response]));

      return answered.length === 0 ? undefined : answered;
    },
  };
}

/** Builds the per-message context, omitting absent fields. */
export function requestContext(
  authorization: AuthorizationContext | undefined,
  signal: AbortSignal | undefined,
): McpRequestContext {
  return definedFields({ authorization, signal });
}
