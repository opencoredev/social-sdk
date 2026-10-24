import type { AuthorizationContext, JsonObject, JsonValue } from "../core/types.js";
import { isJsonValue } from "../transport/json.js";
import { isFiniteNumber, isJsonArray, isJsonObject, isString } from "../transport/validation.js";
import { jsonRpcError, jsonRpcErrorCodes, requestContext, type McpServer } from "./server.js";

export interface McpStdioOptions {
  /** Message input, such as `process.stdin`. The session ends when it ends. */
  readonly input: AsyncIterable<Uint8Array | string>;
  /** Writes one newline-terminated JSON-RPC message, such as `process.stdout.write`. */
  readonly write: (line: string) => void;
  /** Authorization context for every call in this local session. */
  readonly authorization?: AuthorizationContext;
  /** Largest accepted message. Default 1 MiB. */
  readonly maxMessageBytes?: number;
  /** Requests handled concurrently. Default 16. */
  readonly maxInFlight?: number;
  /** Requests waiting for a slot before new ones get a "Server busy" error. Default 256. */
  readonly maxQueued?: number;
}

/** JSON-RPC implementation-defined server error for a full request queue. */
const serverBusy = -32000;

interface Tracked {
  readonly message: JsonValue;
  readonly controller: AbortController;
  readonly key: string | undefined;
}

type Work =
  | { readonly kind: "single"; readonly item: Tracked }
  | { readonly kind: "batch"; readonly items: readonly Tracked[] };

function isRequestId(value: JsonValue | undefined): value is string | number {
  return isString(value) || (isFiniteNumber(value) && Number.isSafeInteger(value));
}

function isTextChunk(chunk: Uint8Array | string): chunk is string {
  return typeof chunk === "string";
}

function parseLine(line: string): JsonValue | undefined {
  try {
    const parsed: unknown = JSON.parse(line);

    return isJsonValue(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serve MCP over newline-delimited JSON on stdio. Stdout carries protocol
 * messages only. Requests run concurrently up to `maxInFlight`, reading never
 * waits on them, and `notifications/cancelled` aborts the matching request,
 * queued or running, whose response is then dropped.
 */
export async function serveMcpStdio(server: McpServer, options: McpStdioOptions): Promise<void> {
  const maxBytes = options.maxMessageBytes ?? 1024 * 1024;
  const maxInFlight = options.maxInFlight ?? 16;
  const maxQueued = options.maxQueued ?? 256;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const controllers = new Map<string, AbortController>();
  const queue: Work[] = [];
  const pending = new Set<Promise<void>>();
  let buffer = "";
  let discarding = false;

  // UTF-8 needs at least one byte per UTF-16 unit and at most three, so most checks skip encoding.
  const tooLarge = (text: string) =>
    text.length > maxBytes ||
    (text.length * 3 > maxBytes && encoder.encode(text).byteLength > maxBytes);

  const send = (message: JsonValue) => options.write(`${JSON.stringify(message)}\n`);

  function isCancellation(message: JsonValue): boolean {
    return isJsonObject(message) && message["method"] === "notifications/cancelled";
  }

  function cancel(message: JsonValue): void {
    const params = isJsonObject(message) ? message["params"] : undefined;

    if (!isJsonObject(params)) return;
    const requestId = params["requestId"];

    if (isString(requestId) || isFiniteNumber(requestId))
      controllers.get(JSON.stringify(requestId))?.abort();
  }

  /** Registers an abort controller per request ID so cancellation works while queued or running. */
  function track(message: JsonValue): Tracked {
    const id = isJsonObject(message) ? message["id"] : undefined;
    const key = id === undefined ? undefined : JSON.stringify(id);
    const controller = new AbortController();

    if (key !== undefined) controllers.set(key, controller);

    return { message, controller, key };
  }

  async function answer(item: Tracked): Promise<JsonObject | undefined> {
    try {
      if (item.controller.signal.aborted) return undefined;

      const response = await server.handle(
        item.message,
        requestContext(options.authorization, item.controller.signal),
      );

      // Each element is a single message, so the server answers with one object or nothing.
      return item.controller.signal.aborted || !isJsonObject(response) ? undefined : response;
    } finally {
      if (item.key !== undefined && controllers.get(item.key) === item.controller)
        controllers.delete(item.key);
    }
  }

  async function run(work: Work): Promise<void> {
    if (work.kind === "single") {
      const response = await answer(work.item);

      if (response !== undefined) send(response);

      return;
    }

    const responses = await Promise.all(work.items.map(answer));
    const answered = responses.flatMap((response) => (response === undefined ? [] : [response]));

    if (answered.length > 0) send(answered);
  }

  function pump(): void {
    while (pending.size < maxInFlight) {
      const work = queue.shift();

      if (work === undefined) return;

      const task = run(work).finally(() => {
        pending.delete(task);
        pump();
      });

      pending.add(task);
    }
  }

  /** Cancellations act as soon as they are read; requests wait in a bounded FIFO for a slot. */
  function accept(line: string): void {
    if (line.trim() === "") return;

    if (tooLarge(line)) {
      send(jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Message too large"));

      return;
    }

    const message = parseLine(line);

    if (message === undefined) {
      send(jsonRpcError(null, jsonRpcErrorCodes.parseError, "Parse error"));

      return;
    }

    if (isCancellation(message)) {
      cancel(message);

      return;
    }

    if (isJsonArray(message) && message.length > 0) {
      for (const item of message) if (isCancellation(item)) cancel(item);

      const items = message.filter((item) => !isCancellation(item));

      if (items.length === 0) return;

      if (queue.length >= maxQueued) {
        send([jsonRpcError(null, serverBusy, "Server busy")]);

        return;
      }

      queue.push({ kind: "batch", items: items.map(track) });
    } else {
      if (queue.length >= maxQueued) {
        const id = isJsonObject(message) ? message["id"] : undefined;

        if (id !== undefined)
          send(jsonRpcError(isRequestId(id) ? id : null, serverBusy, "Server busy"));

        return;
      }

      queue.push({ kind: "single", item: track(message) });
    }

    pump();
  }

  for await (const chunk of options.input) {
    buffer += isTextChunk(chunk) ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");

    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);

      if (discarding) discarding = false;
      else accept(line);
      newline = buffer.indexOf("\n");
    }

    // An oversized message without a newline is dropped up to its end.
    if (tooLarge(buffer)) {
      if (!discarding)
        send(jsonRpcError(null, jsonRpcErrorCodes.invalidRequest, "Message too large"));
      buffer = "";
      discarding = true;
    }
  }

  buffer += decoder.decode();

  if (!discarding) accept(buffer);

  while (pending.size > 0) await Promise.race(pending);
}
