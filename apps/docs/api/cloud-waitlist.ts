// POST /api/cloud-waitlist: Social SDK Cloud early-access signups. The request
// handling lives in ../cloud-waitlist-server.ts; this file connects it to the
// Neon database (WAITLIST_DATABASE_URL, tables in _cloud-waitlist.sql) and to DNS.
import { createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";

import { neon } from "@neondatabase/serverless";

import type { JsonObject, JsonValue, Signup } from "../cloud-waitlist.js";
import {
  checkMailDomainWith,
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

function isRecord(row: JsonValue): row is JsonObject {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

function isAttemptCount(row: JsonValue): row is JsonObject & { readonly attempts: number } {
  return isRecord(row) && typeof row.attempts === "number";
}

/** Counts one attempt for `bucket` in the current hour and returns the hour's total. */
async function countAttempt(bucket: string): Promise<number> {
  const sql = database();

  // Windows older than a day are dropped in the same round trip.
  const rows: readonly JsonValue[] = await sql`
    with hits as (
      insert into cloud_waitlist_attempts (bucket, window_start)
      values (${bucket}, date_trunc('hour', now()))
      on conflict (bucket, window_start)
        do update set attempts = cloud_waitlist_attempts.attempts + 1
      returning attempts
    ), expired as (
      delete from cloud_waitlist_attempts where window_start < now() - interval '1 day'
    )
    select attempts from hits`;

  const row = rows.find(isAttemptCount);

  if (row === undefined) throw new Error("attempt counter returned no row");

  return row.attempts;
}

// The address's own limit is checked first, and only attempts it admits count
// toward the site-wide limit, so one address can't use up everyone's capacity.
async function admit(client: string): Promise<Admission> {
  const bucket = clientBucket(client);

  if (bucket !== null && (await countAttempt(bucket)) > perClientPerHour) return "limited";

  return (await countAttempt("site")) > sitePerHour ? "limited" : "admitted";
}

const resolver = new Resolver({ timeout: 1500, tries: 1 });

function checkMailDomain(domain: string): Promise<MailDomain> {
  return checkMailDomainWith(resolver, domain);
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
