import { createExampleHandler, type ExampleHandler } from "../app.js";

const handler = createExampleHandler();

function mounted(request: Request, prefix: string): Request {
  const url = new URL(request.url);

  const suffix =
    url.pathname === prefix
      ? "/"
      : url.pathname.startsWith(`${prefix}/`)
        ? url.pathname.slice(prefix.length)
        : url.pathname;

  url.pathname =
    suffix.startsWith("/api/") || suffix === "/api"
      ? suffix
      : `/api${suffix === "/" ? "" : suffix}`;

  return new Request(url, request);
}

/** Next.js catch-all route exports. Mount at `app/api/social/[...path]/route.ts`. */
export async function GET(request: Request): Promise<Response> {
  return handler.handle(mounted(request, "/api/social"));
}

export async function POST(request: Request): Promise<Response> {
  return handler.handle(mounted(request, "/api/social"));
}

export function createNextRoute(source: ExampleHandler = handler, prefix = "/api/social") {
  return {
    GET: (request: Request) => source.handle(mounted(request, prefix)),
    POST: (request: Request) => source.handle(mounted(request, prefix)),
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
  };
}
