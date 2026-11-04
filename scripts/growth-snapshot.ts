// Daily growth snapshot: npm downloads and GitHub repository numbers, sent to
// the analytics project the docs site uses. `.github/workflows/growth-snapshot.yml`
// runs it once a day. Nothing here ships in the package.
//
//   bun scripts/growth-snapshot.ts             last 30 days of daily numbers
//   bun scripts/growth-snapshot.ts --backfill  full npm and star history
//   bun scripts/growth-snapshot.ts --dry-run   print the events instead of sending
//
// GITHUB_TOKEN raises the GitHub API rate limit. GROWTH_GITHUB_TOKEN, a token
// with read access to repository administration, adds views, clones and
// referrers; GitHub keeps those for 14 days only, so they are skipped without it.
//
// Every event ID is derived from its name and day, so re-sending a day replaces
// the earlier copy instead of counting it twice.

import { createHash } from "node:crypto";
import { analyticsIngestion } from "../apps/docs/analytics.js";
import type { JsonValue } from "../packages/social-sdk/src/transport/json.js";
import { parseJson } from "../packages/social-sdk/src/transport/json.js";
import {
  array,
  isFiniteNumber,
  isJsonObject,
  isString,
  object,
  string,
} from "../packages/social-sdk/src/transport/validation.js";

const PACKAGE = "@opencoredev/social-sdk";

const REPOSITORY = "opencoredev/social-sdk";

const DISTINCT_ID = "social-sdk-growth-snapshot";

const DAILY_WINDOW_DAYS = 30;

// npm serves at most 18 months per range request.
const NPM_BACKFILL_DAYS = 540;

const BATCH_SIZE = 200;

type Day = string & { readonly __brand: "Day" };

interface GrowthEvent {
  readonly event: string;
  /** Distinguishes events of one name on the same day, such as a version or referrer. */
  readonly key: string;
  readonly day: Day;
  readonly properties: Readonly<Record<string, string | number>>;
}

const args = new Set(process.argv.slice(2));

for (const arg of args)
  if (!["--dry-run", "--backfill"].includes(arg)) throw new Error(`Unknown option: ${arg}`);

const dryRun = args.has("--dry-run");

const backfill = args.has("--backfill");

const githubToken = process.env["GITHUB_TOKEN"]?.trim() || undefined;

const trafficToken = process.env["GROWTH_GITHUB_TOKEN"]?.trim() || undefined;

function isDay(value: string): value is Day {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function dayOf(value: string): Day {
  const day = value.slice(0, 10);

  if (!isDay(day)) throw new Error(`Expected an ISO date, got ${JSON.stringify(value)}`);

  return day;
}

function daysBefore(day: Day, count: number): Day {
  return dayOf(new Date(Date.parse(`${day}T00:00:00Z`) - count * 86_400_000).toISOString());
}

function count(value: JsonValue | undefined, label: string): number {
  if (!isFiniteNumber(value) || value < 0 || !Number.isInteger(value))
    throw new Error(`${label} is not a count`);

  return value;
}

/** A stable UUID-shaped ID from the event name, day and key. */
function eventId(event: GrowthEvent): string {
  const hex = createHash("sha256").update(`${event.event}|${event.day}|${event.key}`).digest("hex");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function getJson(url: string, token?: string): Promise<{ body: JsonValue; link: string }> {
  const headers = new Headers({
    accept: url.includes("/stargazers")
      ? "application/vnd.github.star+json"
      : "application/vnd.github+json",
    "user-agent": "social-sdk-growth-snapshot",
  });

  if (token && url.startsWith("https://api.github.com/"))
    headers.set("authorization", `Bearer ${token}`);

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });

  if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`);

  return { body: parseJson(await response.text()), link: response.headers.get("link") ?? "" };
}

async function npmDownloads(today: Day): Promise<GrowthEvent[]> {
  const start = daysBefore(today, backfill ? NPM_BACKFILL_DAYS : DAILY_WINDOW_DAYS);
  const end = daysBefore(today, 1);

  const { body } = await getJson(
    `https://api.npmjs.org/downloads/range/${start}:${end}/${encodeURIComponent(PACKAGE)}`,
  );

  const rows = array(object(body)["downloads"]).map((row) => {
    const fields = object(row);

    return {
      day: dayOf(string(fields["day"])),
      downloads: count(fields["downloads"], "downloads"),
    };
  });
  // Days before the first publish come back as zero; skip them so the chart
  // starts at the release.

  const first = rows.findIndex((row) => row.downloads > 0);

  return (first === -1 ? [] : rows.slice(first)).map((row) => ({
    event: "growth_npm_downloads",
    key: "",
    day: row.day,
    properties: { downloads: row.downloads },
  }));
}

async function npmVersions(today: Day): Promise<GrowthEvent[]> {
  const { body } = await getJson(
    `https://api.npmjs.org/versions/${encodeURIComponent(PACKAGE)}/last-week`,
  );

  const downloads = object(object(body)["downloads"]);

  return Object.entries(downloads).map(([version, value]) => ({
    event: "growth_npm_version_downloads",
    key: version,
    day: today,
    properties: { version, downloads_last_week: count(value, `downloads for ${version}`) },
  }));
}

async function repoTotals(today: Day): Promise<GrowthEvent[]> {
  const repo = object(
    (await getJson(`https://api.github.com/repos/${REPOSITORY}`, githubToken)).body,
  );

  return [
    {
      event: "growth_github_repo",
      key: "",
      day: today,
      properties: {
        stars_total: count(repo["stargazers_count"], "stargazers_count"),
        forks: count(repo["forks_count"], "forks_count"),
        watchers: count(repo["subscribers_count"], "subscribers_count"),
        open_issues: count(repo["open_issues_count"], "open_issues_count"),
      },
    },
  ];
}

function lastPage(link: string): number {
  const match = /[?&]page=(\d+)>; rel="last"/.exec(link);

  return match ? Number(match[1]) : 1;
}

/** Stars gained per day, from each current stargazer's `starred_at`. */
async function starsGained(today: Day): Promise<GrowthEvent[]> {
  const windowStart = daysBefore(today, DAILY_WINDOW_DAYS);
  const base = `https://api.github.com/repos/${REPOSITORY}/stargazers?per_page=100`;
  const first = await getJson(`${base}&page=1`, githubToken);
  const pages = new Map<number, JsonValue>([[1, first.body]]);
  const perDay = new Map<Day, number>();

  // Stargazers are listed oldest first, so the daily run walks back from the
  // last page until it passes the window.
  for (let page = lastPage(first.link); page >= 1; page--) {
    const body = pages.get(page) ?? (await getJson(`${base}&page=${page}`, githubToken)).body;
    let reachedWindowStart = false;

    for (const entry of array(body)) {
      const day = dayOf(string(object(entry)["starred_at"]));

      if (day >= today) continue;

      if (!backfill && day < windowStart) {
        reachedWindowStart = true;
        continue;
      }

      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }

    if (reachedWindowStart) break;
  }

  // Days without a new star are recorded as zero inside the window.
  if (!backfill)
    for (let offset = DAILY_WINDOW_DAYS; offset >= 1; offset--) {
      const day = daysBefore(today, offset);

      if (!perDay.has(day)) perDay.set(day, 0);
    }

  return [...perDay].map(([day, stars]) => ({
    event: "growth_github_stars",
    key: "",
    day,
    properties: { stars_gained: stars },
  }));
}

async function traffic(today: Day, token: string): Promise<GrowthEvent[]> {
  const [views, clones, referrers] = await Promise.all(
    ["views", "clones", "popular/referrers"].map(
      async (path) =>
        (await getJson(`https://api.github.com/repos/${REPOSITORY}/traffic/${path}`, token)).body,
    ),
  );

  const perDay = new Map<Day, Record<string, number>>();

  for (const [label, body] of [
    ["views", views],
    ["clones", clones],
  ] as const) {
    for (const entry of array(object(body)[label])) {
      const fields = object(entry);
      const day = dayOf(string(fields["timestamp"]));

      // Today's numbers are still growing; the next run records the full day.
      if (day >= today) continue;
      const row = perDay.get(day) ?? {};

      row[label] = count(fields["count"], `${label} count`);
      row[label === "views" ? "unique_visitors" : "unique_cloners"] = count(
        fields["uniques"],
        `${label} uniques`,
      );
      perDay.set(day, row);
    }
  }

  const daily = [...perDay].map(([day, row]) => ({
    event: "growth_github_traffic",
    key: "",
    day,
    properties: { views: 0, unique_visitors: 0, clones: 0, unique_cloners: 0, ...row },
  }));

  const sources = array(referrers).map((entry) => {
    const fields = object(entry);
    const referrer = string(fields["referrer"]);

    return {
      event: "growth_github_referrers",
      key: referrer,
      day: today,
      properties: {
        referrer,
        views_14d: count(fields["count"], "referrer count"),
        unique_visitors_14d: count(fields["uniques"], "referrer uniques"),
      },
    };
  });

  return [...daily, ...sources];
}

function toCapture(event: GrowthEvent) {
  return {
    event: event.event,
    distinct_id: DISTINCT_ID,
    uuid: eventId(event),
    timestamp: `${event.day}T12:00:00Z`,
    properties: {
      day: event.day,
      ...event.properties,
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "social-sdk-growth-snapshot",
    },
  };
}

async function send(events: readonly GrowthEvent[]): Promise<void> {
  for (let index = 0; index < events.length; index += BATCH_SIZE) {
    const response = await fetch(`${analyticsIngestion.host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: analyticsIngestion.key,
        batch: events.slice(index, index + BATCH_SIZE).map(toCapture),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) throw new Error(`Analytics ingestion answered ${response.status}`);
    const body = parseJson(await response.text());

    if (!isJsonObject(body) || !isString(body["status"]) || body["status"].toLowerCase() !== "ok")
      throw new Error("Analytics ingestion did not confirm the batch");
  }
}

const today = dayOf(new Date().toISOString());

const events: GrowthEvent[] = [];

const sections: [string, () => Promise<GrowthEvent[]>][] = [
  ["npm downloads", () => npmDownloads(today)],
  ["npm versions", () => npmVersions(today)],
  ["GitHub repository", () => repoTotals(today)],
  ["GitHub stars", () => starsGained(today)],
];

if (trafficToken) sections.push(["GitHub traffic", () => traffic(today, trafficToken)]);
else console.log("GitHub traffic: skipped, GROWTH_GITHUB_TOKEN is not set.");

let failed = false;

for (const [label, collect] of sections) {
  try {
    const collected = await collect();

    events.push(...collected);
    console.log(`${label}: ${collected.length} events`);
  } catch (error) {
    // Keep the other sources; the job still fails at the end so it gets noticed.
    failed = true;
    console.error(`${label}: failed (${error instanceof Error ? error.message : "unknown error"})`);
  }
}

if (dryRun) for (const event of events) console.log(JSON.stringify(toCapture(event)));
else {
  await send(events);
  console.log(`Sent ${events.length} events.`);
}

if (failed) process.exitCode = 1;
