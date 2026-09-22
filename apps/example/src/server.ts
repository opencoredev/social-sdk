import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createExampleHandler } from "./app.js";
import { exampleBackendConfig } from "./config.js";
import { openExampleDatabase } from "./storage.js";

const handler = createExampleHandler({
  ...exampleBackendConfig(process.env),
  database: openExampleDatabase(process.env["EXAMPLE_DB"] ?? "./social-example.sqlite"),
});

const server = createServer(async (request, response) => {
  const origin = `http://${request.headers.host ?? "localhost"}`;

  const headers = new Headers();

  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) headers.set(name, value);
  }

  const init: RequestInit & { duplex?: "half" } = { method: request.method ?? "GET", headers };

  if (request.method !== "GET" && request.method !== "HEAD") {
    // SAFETY: IncomingMessage yields Buffer chunks; Buffer extends Uint8Array.
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }

  const webRequest = new Request(`${origin}${request.url ?? "/"}`, init);

  const webResponse = await handler.handle(webRequest);
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
});

server.listen(Number(process.env["PORT"] ?? 3030), process.env["EXAMPLE_BIND"] ?? "127.0.0.1", () =>
  console.log(
    `Example listening on port ${process.env["PORT"] ?? 3030}; backend ${process.env["EXAMPLE_BACKEND"] ?? "mock"}`,
  ),
);
