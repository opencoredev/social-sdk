// POST /api/cloud-waitlist: stores a Social SDK Cloud early-access signup in the
// Neon database connected to this Vercel project (WAITLIST_DATABASE_URL). The
// table is defined in _cloud-waitlist.sql.
//
// The /cloud page's script sends JSON and reads a JSON answer. Without
// JavaScript the browser posts the form itself, and gets redirected back to
// /cloud with #joined or #join-error, which the page shows.
//
// The same email updates its row instead of adding one, and the answer never
// says whether an address was already on the list.
import { neon } from "@neondatabase/serverless";

import { formBody, parseSignup, type JsonValue, type Signup } from "../cloud-waitlist.js";

const maxBodyBytes = 8 * 1024;

type Reply =
  | { kind: "joined" }
  | { kind: "invalid"; field: string }
  | { kind: "rejected"; status: 403 | 413 | 415 | 400; error: string }
  | { kind: "unavailable" };

type BodyFormat = "json" | "form";

function bodyFormat(request: Request): BodyFormat | null {
  const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();

  if (type === "application/json") return "json";

  if (type === "application/x-www-form-urlencoded") return "form";

  return null;
}

// A browser always sends Origin on a cross-site POST. Refusing other origins
// keeps other sites from signing their visitors up; tools like curl send none.
function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");

  return origin === null || origin === new URL(request.url).origin;
}

function decode(text: string, format: BodyFormat): JsonValue | undefined {
  if (format === "form") return formBody(new URLSearchParams(text));

  try {
    // JSON.parse only ever produces JSON values.
    const parsed: JsonValue = JSON.parse(text);

    return parsed;
  } catch {
    return undefined;
  }
}

function environment(): string {
  const name = process.env.VERCEL_ENV;

  return name === "production" || name === "preview" ? name : "development";
}

async function store(signup: Signup, databaseUrl: string): Promise<void> {
  const sql = neon(databaseUrl);

  await sql`
    insert into cloud_waitlist
      (email, platforms, other_platforms, accounts, current_tool, came_from, environment)
    values (
      ${signup.email}, ${[...signup.platforms]}, ${signup.otherPlatforms}, ${signup.accounts},
      ${signup.currentTool}, ${signup.cameFrom}, ${environment()}
    )
    on conflict (email) do update set
      platforms = excluded.platforms,
      other_platforms = excluded.other_platforms,
      accounts = excluded.accounts,
      current_tool = excluded.current_tool,
      came_from = coalesce(cloud_waitlist.came_from, excluded.came_from),
      environment = case
        when excluded.environment = 'production' then 'production'
        else cloud_waitlist.environment
      end,
      submissions = cloud_waitlist.submissions + 1,
      updated_at = now()`;
}

async function handle(request: Request, format: BodyFormat): Promise<Reply> {
  if (!isSameOrigin(request)) return { kind: "rejected", status: 403, error: "origin" };

  const declared = Number(request.headers.get("content-length") ?? "0");

  if (declared > maxBodyBytes) return { kind: "rejected", status: 413, error: "too-large" };

  const text = await request.text();

  if (new TextEncoder().encode(text).length > maxBodyBytes)
    return { kind: "rejected", status: 413, error: "too-large" };

  const body = decode(text, format);

  if (body === undefined) return { kind: "rejected", status: 400, error: "body" };

  const parsed = parseSignup(body);

  switch (parsed.kind) {
    case "trap":
      return { kind: "joined" };
    case "invalid":
      return { kind: "invalid", field: parsed.field };
    case "signup": {
      const databaseUrl = process.env.WAITLIST_DATABASE_URL;

      if (!databaseUrl) {
        console.error("cloud-waitlist: WAITLIST_DATABASE_URL is not set");

        return { kind: "unavailable" };
      }

      try {
        await store(parsed.signup, databaseUrl);
      } catch (error) {
        // Log the error's name only: a database message can quote submitted values.
        console.error("cloud-waitlist: insert failed", {
          name: error instanceof Error ? error.name : "unknown",
        });

        return { kind: "unavailable" };
      }

      return { kind: "joined" };
    }

    default: {
      const exhaustive: never = parsed;

      return exhaustive;
    }
  }
}

const noStore = { "cache-control": "no-store" };

function jsonReply(reply: Reply): Response {
  switch (reply.kind) {
    case "joined":
      return Response.json({ ok: true }, { headers: noStore });
    case "invalid":
      return Response.json(
        { ok: false, error: "invalid", field: reply.field },
        { status: 422, headers: noStore },
      );
    case "rejected":
      return Response.json(
        { ok: false, error: reply.error },
        { status: reply.status, headers: noStore },
      );
    case "unavailable":
      return Response.json({ ok: false, error: "unavailable" }, { status: 503, headers: noStore });
    default: {
      const exhaustive: never = reply;

      return exhaustive;
    }
  }
}

function redirectReply(reply: Reply, request: Request): Response {
  const target = new URL(
    reply.kind === "joined" ? "/cloud#joined" : "/cloud#join-error",
    request.url,
  );

  return new Response(null, { status: 303, headers: { ...noStore, location: target.href } });
}

export async function POST(request: Request): Promise<Response> {
  const format = bodyFormat(request);

  if (format === null) return jsonReply({ kind: "rejected", status: 415, error: "content-type" });

  const reply = await handle(request, format);

  return format === "json" ? jsonReply(reply) : redirectReply(reply, request);
}
