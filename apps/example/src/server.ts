import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createExampleHandler } from "./app.js";
import { exampleBackendConfig } from "./config.js";
import { openDatabaseFromEnv } from "./storage.js";

// Applies pending migrations before the server accepts requests.
const database = await openDatabaseFromEnv(process.env);

const handler = createExampleHandler({
  ...exampleBackendConfig(process.env),
  allowedHosts: [
    `localhost:${process.env["PORT"] ?? "3030"}`,
    `127.0.0.1:${process.env["PORT"] ?? "3030"}`,
    `[::1]:${process.env["PORT"] ?? "3030"}`,
    ...(process.env["EXAMPLE_ALLOWED_HOSTS"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []),
  ],
  allowedOrigins: [
    `http://localhost:${process.env["PORT"] ?? "3030"}`,
    `http://127.0.0.1:${process.env["PORT"] ?? "3030"}`,
    `http://[::1]:${process.env["PORT"] ?? "3030"}`,
    ...(process.env["EXAMPLE_PUBLIC_ORIGIN"] ? [process.env["EXAMPLE_PUBLIC_ORIGIN"]] : []),
  ],
  database,
});

const allowedHosts = new Set([
  `localhost:${process.env["PORT"] ?? "3030"}`,
  `127.0.0.1:${process.env["PORT"] ?? "3030"}`,
  `[::1]:${process.env["PORT"] ?? "3030"}`,
  ...(process.env["EXAMPLE_ALLOWED_HOSTS"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? []),
]);

const server = createServer(async (request, response) => {
  if (!request.headers.host || !allowedHosts.has(request.headers.host)) {
    response.writeHead(421);
    response.end("Misdirected request");

    return;
  }

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
    `Example listening on port ${process.env["PORT"] ?? 3030}; backend ${process.env["EXAMPLE_BACKEND"] ?? "mock"}; database ${database.driver}`,
  ),
);

// Let active requests finish, then close the database so a local PGlite
// directory is left consistent. Force the exit if draining stalls.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => void database.close().finally(() => process.exit(0)));
    server.closeIdleConnections();
  });
