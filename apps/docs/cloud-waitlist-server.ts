// The request handling behind POST /api/cloud-waitlist. api/cloud-waitlist.ts
// wires it to Neon and DNS; the tests wire it to fakes.
//
// The /cloud page's script sends JSON and reads a JSON answer. Without
// JavaScript the browser posts the form itself and is redirected back to
// /cloud with #joined or #join-error, which the page shows.
//
// Spam defenses, cheapest first: same-origin check, an 8 KiB body cap, a hidden
// trap field, a minimum time between page load and submit, a list of throwaway
// inbox domains, a per-client and a site-wide hourly limit, and a check that
// the email's domain can receive mail. The same email updates its row instead
// of adding one, and no answer says whether an address was already listed.
import {
  emailDomain,
  formBody,
  minFillMs,
  parseSignup,
  spamFlags,
  type JsonValue,
  type Signup,
  type SpamFlag,
  type SignupField,
} from "./cloud-waitlist.js";

export const maxBodyBytes = 8 * 1024;

export type Admission = "admitted" | "limited";

export type MailDomain = "receives-mail" | "no-mail";

/** Why an attempt was turned away. Counted per hour; nothing about the visitor is kept. */
export type BlockedReason =
  | "trap"
  | "too-fast"
  | "throwaway"
  | "no-mail"
  | "rate-limited"
  | "other-site"
  | "invalid"
  | "bad-request";

/** A signup ready to store, with the spam flags it arrived with. */
export type StoredSignup = { signup: Signup; flags: readonly SpamFlag[] };

/** What the handler needs from the outside world. */
export type WaitlistServices = {
  /** Counts one blocked attempt. Failures here never change the reply. */
  recordBlocked: (reason: BlockedReason) => Promise<void>;
  /** Counts one signup attempt from `client` (an opaque key) and says whether it's over the limit. */
  admit: (client: string) => Promise<Admission>;
  /** Whether a domain can receive mail. Answers "receives-mail" when it can't tell. */
  checkMailDomain: (domain: string) => Promise<MailDomain>;
  /** Inserts the signup, or updates the row with the same email. */
  store: (entry: StoredSignup) => Promise<void>;
};

/** The DNS lookups the mail-domain check makes; node:dns/promises' Resolver has them. */
export type MailLookups = {
  resolveMx: (domain: string) => Promise<readonly { exchange: string }[]>;
  resolve4: (domain: string) => Promise<readonly string[]>;
  resolve6: (domain: string) => Promise<readonly string[]>;
};

function hasCode(error: Error): error is Error & { code: string } {
  return "code" in error && typeof error.code === "string";
}

function lookupCode(reason: Error): string | null {
  return hasCode(reason) ? reason.code : null;
}

const definitelyAbsent = new Set(["ENODATA", "ENOTFOUND"]);

/** "no-mail" only when both address lookups say there is no address; any other failure is unknown. */
async function implicitMx(lookups: MailLookups, domain: string): Promise<MailDomain> {
  const found = await Promise.allSettled([lookups.resolve4(domain), lookups.resolve6(domain)]);

  const absent = found.every(
    (result) =>
      (result.status === "fulfilled" && result.value.length === 0) ||
      (result.status === "rejected" &&
        result.reason instanceof Error &&
        definitelyAbsent.has(lookupCode(result.reason) ?? "")),
  );

  return absent ? "no-mail" : "receives-mail";
}

/**
 * Whether a domain can receive mail: through its MX records, or through its own
 * address when it has none. "Null MX" (one empty exchange) means it takes no
 * mail. Timeouts and server failures count as receiving mail, so a DNS hiccup
 * never turns a person away.
 */
export async function checkMailDomainWith(
  lookups: MailLookups,
  domain: string,
): Promise<MailDomain> {
  try {
    const records = await lookups.resolveMx(domain);

    return records.some((record) => record.exchange !== "" && record.exchange !== ".")
      ? "receives-mail"
      : "no-mail";
  } catch (error) {
    const code = error instanceof Error ? lookupCode(error) : null;

    if (code === "ENOTFOUND") return "no-mail";

    if (code === "ENODATA") return implicitMx(lookups, domain);

    return "receives-mail";
  }
}

type Reply =
  | { kind: "joined" }
  /** The trap field was filled: answered like a signup, stored nowhere. */
  | { kind: "trapped" }
  | { kind: "invalid"; field: SignupField; reason: "format" | "no-mail" | "throwaway" }
  | { kind: "slow-down"; error: "too-fast" | "rate-limited" }
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

/** The caller's address as Vercel's edge reports it; one bucket for all when it's missing. */
export function clientAddress(request: Request): string {
  const forwarded =
    request.headers.get("x-vercel-forwarded-for") ?? request.headers.get("x-forwarded-for");

  return forwarded?.split(",")[0]?.trim() || "unknown";
}

type BodyRead = { kind: "text"; text: string } | { kind: "too-large" } | { kind: "unreadable" };

/** Reads the body, stopping as soon as it passes the limit instead of buffering all of it. */
async function readBody(request: Request): Promise<BodyRead> {
  if (request.body === null) return { kind: "text", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;
      size += value.byteLength;

      if (size > maxBodyBytes) {
        await reader.cancel().catch(() => undefined);

        return { kind: "too-large" };
      }

      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { kind: "unreadable" };
  }
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

/**
 * The page's script always reports how long the visitor had the page open. A
 * JSON post without it didn't come from the page, and one under the minimum
 * came from something faster than a person.
 */
function isTooFast(signup: Signup, format: BodyFormat): boolean {
  if (signup.elapsedMs === null) return format === "json";

  return signup.elapsedMs < minFillMs;
}

async function accept(signup: Signup, client: string, services: WaitlistServices): Promise<Reply> {
  if ((await services.admit(client)) === "limited")
    return { kind: "slow-down", error: "rate-limited" };

  if ((await services.checkMailDomain(emailDomain(signup.email))) === "no-mail")
    return { kind: "invalid", field: "email", reason: "no-mail" };

  await services.store({ signup, flags: spamFlags(signup) });

  return { kind: "joined" };
}

async function handle(
  request: Request,
  format: BodyFormat,
  services: WaitlistServices,
): Promise<Reply> {
  if (!isSameOrigin(request)) return { kind: "rejected", status: 403, error: "origin" };

  const declared = Number(request.headers.get("content-length") ?? "0");

  if (declared > maxBodyBytes) return { kind: "rejected", status: 413, error: "too-large" };

  const read = await readBody(request);

  if (read.kind === "too-large") return { kind: "rejected", status: 413, error: "too-large" };

  if (read.kind === "unreadable") return { kind: "rejected", status: 400, error: "body" };

  const body = decode(read.text, format);

  if (body === undefined) return { kind: "rejected", status: 400, error: "body" };

  const parsed = parseSignup(body);

  switch (parsed.kind) {
    case "trap":
      return { kind: "trapped" };
    case "invalid":
      return { kind: "invalid", field: parsed.field, reason: "format" };
    case "throwaway-email":
      return { kind: "invalid", field: "email", reason: "throwaway" };
    case "signup": {
      if (isTooFast(parsed.signup, format)) return { kind: "slow-down", error: "too-fast" };

      try {
        return await accept(parsed.signup, clientAddress(request), services);
      } catch (error) {
        // Log the error's name only: a database message can quote submitted values.
        console.error("cloud-waitlist: signup failed", {
          name: error instanceof Error ? error.name : "unknown",
        });

        return { kind: "unavailable" };
      }
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
    case "trapped":
      return Response.json({ ok: true }, { headers: noStore });
    case "invalid":
      return Response.json(
        { ok: false, error: "invalid", field: reply.field, reason: reply.reason },
        { status: 422, headers: noStore },
      );
    case "slow-down":
      return Response.json({ ok: false, error: reply.error }, { status: 429, headers: noStore });
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
    reply.kind === "joined" || reply.kind === "trapped" ? "/cloud#joined" : "/cloud#join-error",
    request.url,
  );

  return new Response(null, { status: 303, headers: { ...noStore, location: target.href } });
}

function blockedReason(reply: Reply): BlockedReason | null {
  switch (reply.kind) {
    case "joined":
    case "unavailable":
      return null;
    case "trapped":
      return "trap";
    case "invalid":
      return reply.reason === "format" ? "invalid" : reply.reason;
    case "slow-down":
      return reply.error;
    case "rejected":
      return reply.status === 403 ? "other-site" : "bad-request";
    default: {
      const exhaustive: never = reply;

      return exhaustive;
    }
  }
}

async function record(reply: Reply, services: WaitlistServices): Promise<void> {
  const reason = blockedReason(reply);

  if (reason === null) return;

  try {
    await services.recordBlocked(reason);
  } catch (error) {
    console.error("cloud-waitlist: could not count a blocked attempt", {
      name: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Answers one POST to the waitlist endpoint. */
export async function handleWaitlistPost(
  request: Request,
  services: WaitlistServices,
): Promise<Response> {
  const format = bodyFormat(request);

  if (format === null) {
    const reply: Reply = { kind: "rejected", status: 415, error: "content-type" };

    await record(reply, services);

    return jsonReply(reply);
  }

  const reply = await handle(request, format, services);

  await record(reply, services);

  return format === "json" ? jsonReply(reply) : redirectReply(reply, request);
}
