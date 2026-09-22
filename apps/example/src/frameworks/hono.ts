import type { ExampleHandler } from "../app.js";

/** Hono's app.fetch-compatible adapter; pass it to a Hono route or export it directly. */
export function createHonoFetch(handler: ExampleHandler): (request: Request) => Promise<Response> {
  return (request) => {
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
    const url = new URL(request.url);

    const suffix =
      url.pathname === "/social"
        ? "/"
        : url.pathname.startsWith("/social/")
          ? url.pathname.slice("/social".length)
          : url.pathname;

    url.pathname =
      suffix.startsWith("/api/") || suffix === "/api"
        ? suffix
        : `/api${suffix === "/" ? "" : suffix}`;

    return handler.handle(new Request(url, request));
  };
}
