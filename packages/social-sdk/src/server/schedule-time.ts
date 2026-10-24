import { SocialError } from "../core/errors.js";

/** 0 is Sunday, matching `Date.prototype.getUTCDay`. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface QueueSlot {
  /** Local wall-clock time, `HH:MM` on a 24-hour clock. */
  readonly time: string;
  /** Days this slot applies to. Omit for every day. */
  readonly weekdays?: readonly Weekday[];
}

/**
 * When a scheduled job runs. Every variant resolves to one UTC instant when the job is
 * stored; the stored instant does not move if time-zone rules change later.
 */
export type ScheduleTime =
  /** An ISO 8601 timestamp with `Z` or an explicit UTC offset. */
  | { readonly kind: "instant"; readonly at: string }
  /**
   * A local wall time in an IANA time zone. A time skipped by a daylight-saving jump is
   * rejected. A time that occurs twice is rejected unless `ambiguous` picks one.
   */
  | {
      readonly kind: "local";
      readonly date: string;
      readonly time: string;
      readonly timeZone: string;
      readonly ambiguous?: "earlier" | "later" | "reject";
    }
  /**
   * The first free slot after `notBefore` (or now) in a named queue. Skipped wall times
   * are passed over, and a repeated wall time yields only its earlier instant, so one
   * slot never produces two jobs.
   */
  | {
      readonly kind: "queue";
      readonly queueId: string;
      readonly timeZone: string;
      readonly slots: readonly QueueSlot[];
      readonly notBefore?: string;
    };

export type LocalTimeResolution =
  | { readonly kind: "exact"; readonly at: string }
  | { readonly kind: "ambiguous"; readonly earlier: string; readonly later: string }
  | { readonly kind: "nonexistent" };

const formatters = new Map<string, Intl.DateTimeFormat>();

function invalid(message: string): SocialError {
  return new SocialError({ code: "invalid_input", operation: "schedule.time", message });
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);

  if (cached !== undefined) return cached;

  let created: Intl.DateTimeFormat;

  try {
    created = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw invalid(`Unknown IANA time zone: ${timeZone}`);
  }

  formatters.set(timeZone, created);

  return created;
}

export function assertTimeZone(timeZone: string): void {
  if (timeZone.trim() === "") throw invalid("timeZone must be a nonempty IANA time zone");
  formatter(timeZone);
}

/** The wall-clock reading in `timeZone` at `epochMs`, expressed as if it were UTC. */
function wallClockMs(epochMs: number, timeZone: string): number {
  const values = new Map<string, number>();

  for (const part of formatter(timeZone).formatToParts(new Date(epochMs)))
    if (part.type !== "literal") values.set(part.type, Number(part.value));

  const field = (name: string): number => values.get(name) ?? 0;

  return Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function parseDate(date: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const check = new Date(Date.UTC(year, month - 1, day));

  if (
    match === null ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    throw invalid("date must be a real calendar date in YYYY-MM-DD form");

  return { year, month, day };
}

function parseClock(time: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);

  if (match === null) throw invalid("time must be HH:MM on a 24-hour clock");

  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function resolveWall(wall: number, timeZone: string): number[] {
  const instants = new Set<number>();
  const day = 86_400_000;

  // A zone's offset on either side of a transition is its offset a day earlier or later.
  for (const probe of [wall - day, wall, wall + day]) {
    const candidate = wall - (wallClockMs(probe, timeZone) - probe);

    if (wallClockMs(candidate, timeZone) === wall) instants.add(candidate);
  }

  return [...instants].sort((left, right) => left - right);
}

/** Converts a local wall time to UTC, reporting skipped and repeated wall times. */
export function resolveLocalTime(input: {
  readonly date: string;
  readonly time: string;
  readonly timeZone: string;
}): LocalTimeResolution {
  assertTimeZone(input.timeZone);
  const date = parseDate(input.date);
  const clock = parseClock(input.time);
  const wall = Date.UTC(date.year, date.month - 1, date.day, clock.hour, clock.minute);
  const instants = resolveWall(wall, input.timeZone);
  const [first, second] = instants;

  if (first === undefined) return { kind: "nonexistent" };

  if (second === undefined) return { kind: "exact", at: new Date(first).toISOString() };

  return {
    kind: "ambiguous",
    earlier: new Date(first).toISOString(),
    later: new Date(second).toISOString(),
  };
}

const instantPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Parses an ISO 8601 timestamp that names its offset; local timestamps are rejected. */
export function parseInstant(value: string, name: string): string {
  const parsed = Date.parse(value);

  if (!instantPattern.test(value) || !Number.isFinite(parsed))
    throw invalid(`${name} must be an ISO 8601 timestamp with Z or an explicit UTC offset`);

  return new Date(parsed).toISOString();
}

/** Resolves an `instant` or `local` schedule time to its UTC instant. */
export function resolveFixedTime(time: Exclude<ScheduleTime, { readonly kind: "queue" }>): string {
  if (time.kind === "instant") return parseInstant(time.at, "at");

  const resolution = resolveLocalTime(time);

  switch (resolution.kind) {
    case "exact":
      return resolution.at;
    case "nonexistent":
      throw invalid(
        `${time.date} ${time.time} does not exist in ${time.timeZone} because of a daylight-saving change`,
      );
    case "ambiguous":
      if (time.ambiguous === "earlier") return resolution.earlier;

      if (time.ambiguous === "later") return resolution.later;

      throw invalid(
        `${time.date} ${time.time} occurs twice in ${time.timeZone}; set ambiguous to "earlier" or "later"`,
      );
    default: {
      const _exhaustive: never = resolution;

      return _exhaustive;
    }
  }
}

export function validateQueue(time: Extract<ScheduleTime, { readonly kind: "queue" }>): void {
  if (time.queueId.trim() === "" || time.queueId.length > 200)
    throw invalid("queueId must be a nonempty string of at most 200 characters");
  assertTimeZone(time.timeZone);

  if (time.slots.length === 0 || time.slots.length > 100)
    throw invalid("A queue needs from 1 through 100 slots");

  const seen = new Set<string>();

  for (const slot of time.slots) {
    parseClock(slot.time);

    const days = slot.weekdays === undefined ? [0, 1, 2, 3, 4, 5, 6] : [...new Set(slot.weekdays)];

    if (days.length === 0 || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6))
      throw invalid("Slot weekdays must be integers from 0 (Sunday) through 6");

    for (const day of days) {
      const key = `${day}@${slot.time}`;

      if (seen.has(key)) throw invalid(`Queue slot ${slot.time} is listed twice for one weekday`);
      seen.add(key);
    }
  }

  if (time.notBefore !== undefined) parseInstant(time.notBefore, "notBefore");
}

/**
 * Queue slot instants strictly after `after`, in order, for up to `horizonDays` local days.
 * Skipped wall times are omitted and repeated wall times yield their earlier instant.
 */
export function* queueSlotInstants(input: {
  readonly timeZone: string;
  readonly slots: readonly QueueSlot[];
  readonly after: number;
  readonly horizonDays: number;
}): Generator<string> {
  const day = 86_400_000;
  const startWall = wallClockMs(input.after, input.timeZone);
  const start = new Date(startWall - day);

  const times = [...new Set(input.slots.map((slot) => slot.time))].sort();

  for (let offset = 0; offset <= input.horizonDays + 1; offset++) {
    const date = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offset),
    );

    const weekday = date.getUTCDay();

    for (const time of times) {
      const applies = input.slots.some(
        (slot) =>
          slot.time === time &&
          (slot.weekdays === undefined || slot.weekdays.some((value) => value === weekday)),
      );

      if (!applies) continue;

      const clock = parseClock(time);

      const wall = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        clock.hour,
        clock.minute,
      );

      const first = resolveWall(wall, input.timeZone)[0];

      if (first !== undefined && first > input.after) yield new Date(first).toISOString();
    }
  }
}
