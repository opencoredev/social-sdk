// POST /api/cloud-waitlist: Social SDK Cloud early-access signups. The request
// handling lives in ../cloud-waitlist-server.ts; this file connects it to the
// Neon database (WAITLIST_DATABASE_URL, tables in _cloud-waitlist.sql) and to DNS.
import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";

import { neon } from "@neondatabase/serverless";

import type { JsonObject, JsonValue, Signup } from "../cloud-waitlist.js";
import {
  handleWaitlistPost,
  type Admission,
  type MailDomain,
  type WaitlistServices,
} from "../cloud-waitlist-server.js";

/** Signup attempts one address may make in an hour. Mobile carriers put many people behind one address, so this stays well above one person. */
const perClientPerHour = 20;

/** Signup attempts the whole site accepts in an hour, so a botnet can't flood the list. */
const sitePerHour = 1000;

function environment(): string {
  const name = process.env.VERCEL_ENV;

  return name === "production" || name === "preview" ? name : "development";
}

function database() {
  const url = process.env.WAITLIST_DATABASE_URL;

  if (!url) throw new Error("WAITLIST_DATABASE_URL is not set");

  return neon(url);
}

// The address is keyed with a secret before it's stored, so the table never
// holds an IP address. Without the secret only the site-wide limit applies.
function clientBucket(client: string): string | null {
  const secret = process.env.WAITLIST_IP_SECRET;

  if (!secret) return null;

  return `client:${createHmac("sha256", secret).update(client).digest("base64url").slice(0, 22)}`;
}

type AttemptRow = { readonly bucket: string; readonly attempts: number };

function isRecord(row: JsonValue): row is JsonObject {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

function isAttemptRow(row: JsonValue): row is AttemptRow {
  return isRecord(row) && typeof row.bucket === "string" && typeof row.attempts === "number";
}

function isOverLimit(row: AttemptRow): boolean {
  return row.attempts > (row.bucket === "site" ? sitePerHour : perClientPerHour);
}

async function admit(client: string): Promise<Admission> {
  const sql = database();
  const bucket = clientBucket(client);
  const buckets = bucket === null ? ["site"] : ["site", bucket];

  // Counts this attempt in the current hour for each bucket, and drops windows
  // older than a day in the same round trip.
  const rows: readonly JsonValue[] = await sql`
    with hits as (
      insert into cloud_waitlist_attempts (bucket, window_start)
      select unnest(${buckets}::text[]), date_trunc('hour', now())
      on conflict (bucket, window_start)
        do update set attempts = cloud_waitlist_attempts.attempts + 1
      returning bucket, attempts
    ), expired as (
      delete from cloud_waitlist_attempts where window_start < now() - interval '1 day'
    )
    select bucket, attempts from hits`;

  return rows.filter(isAttemptRow).some(isOverLimit) ? "limited" : "admitted";
}

const resolver = new Resolver({ timeout: 1500, tries: 1 });

function hasCode(error: Error): error is Error & { code: string } {
  return "code" in error && typeof error.code === "string";
}

async function hasAddress(domain: string): Promise<boolean> {
  const found = await Promise.allSettled([resolver.resolve4(domain), resolver.resolve6(domain)]);

  return found.some((result) => result.status === "fulfilled" && result.value.length > 0);
}

// A domain receives mail through its MX records, or through its own address
// when it has none. "Null MX" (a single empty exchange) means it takes no mail.
// Timeouts and server failures count as receiving mail, so a DNS hiccup never
// turns a person away.
async function checkMailDomain(domain: string): Promise<MailDomain> {
  try {
    const records = await resolver.resolveMx(domain);

    return records.some((record) => record.exchange !== "" && record.exchange !== ".")
      ? "receives-mail"
      : "no-mail";
  } catch (error) {
    const code = error instanceof Error && hasCode(error) ? error.code : null;

    if (code === "ENOTFOUND") return "no-mail";

    if (code === "ENODATA") return (await hasAddress(domain)) ? "receives-mail" : "no-mail";

    return "receives-mail";
  }
}

async function store(signup: Signup): Promise<void> {
  const sql = database();

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

const services: WaitlistServices = { admit, checkMailDomain, store };

export function POST(request: Request): Promise<Response> {
  return handleWaitlistPost(request, services);
}
