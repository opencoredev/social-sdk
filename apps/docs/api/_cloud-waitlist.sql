-- Social SDK Cloud early-access signups, written by api/cloud-waitlist.ts.
-- Applied once to the Neon database connected to the Vercel project as
-- WAITLIST_DATABASE_URL. Rerunning it is safe. The leading underscore keeps
-- Vercel from treating this file as a function.

create table if not exists cloud_waitlist (
  id bigint generated always as identity primary key,
  -- Trimmed and lowercased before insert, so one person is one row.
  email text not null unique check (char_length(email) <= 254),
  platforms text[] not null default '{}',
  other_platforms text check (char_length(other_platforms) <= 200),
  accounts text,
  current_tool text check (char_length(current_tool) <= 1000),
  -- The same-site page the visitor came from, without its query string.
  came_from text check (char_length(came_from) <= 200),
  -- production or preview, so test signups from preview deployments can be told apart.
  environment text not null,
  submissions integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hourly signup-attempt counters for the rate limit. `bucket` is "site" or
-- "client:" plus a keyed hash of the caller's address (never the address).
-- The API function deletes windows older than a day.
create table if not exists cloud_waitlist_attempts (
  bucket text not null,
  window_start timestamptz not null,
  attempts integer not null default 1,
  primary key (bucket, window_start)
);
