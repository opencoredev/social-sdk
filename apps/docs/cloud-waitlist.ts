// The Social SDK Cloud early-access form: its options, shared by the /cloud page
// and api/cloud-waitlist.ts, and the parser that turns a submitted body into a
// signup. The page renders the options; the function trusts only what
// parseSignup returns.

type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export const platformOptions = [
  { id: "x", label: "X" },
  { id: "bluesky", label: "Bluesky" },
  { id: "threads", label: "Threads" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "pinterest", label: "Pinterest" },
  { id: "other", label: "Other" },
] as const satisfies readonly { id: string; label: string }[];

export type PlatformId = (typeof platformOptions)[number]["id"];

export const accountOptions = [
  { id: "1", label: "Just one" },
  { id: "2-10", label: "2 to 10" },
  { id: "11-50", label: "11 to 50" },
  { id: "51-250", label: "51 to 250" },
  { id: "250+", label: "More than 250" },
  { id: "unsure", label: "Not sure yet" },
] as const satisfies readonly { id: string; label: string }[];

export type AccountRange = (typeof accountOptions)[number]["id"];

/** A trimmed, lowercased address that passed the format check. */
export type Email = string & { readonly __brand: "Email" };

export const limits = { email: 254, otherPlatforms: 200, currentTool: 1000, cameFrom: 200 };

export type Signup = {
  email: Email;
  /** Without repeats, in the order the form lists them; empty when none was ticked. */
  platforms: readonly PlatformId[];
  otherPlatforms: string | null;
  accounts: AccountRange | null;
  currentTool: string | null;
  /** The same-site path the visitor arrived from, when the page knew it. */
  cameFrom: string | null;
  /** Milliseconds from page load to submit, as the page's script measured it; null without JavaScript. */
  elapsedMs: number | null;
};

/** The form field a rejected submission is about, so the page can point at it. */
export type SignupField = "email" | "platforms" | "otherPlatforms" | "accounts" | "currentTool";

export type ParsedSignup =
  | { kind: "signup"; signup: Signup }
  | { kind: "invalid"; field: SignupField }
  /** The hidden trap field was filled in. Answer as if it worked and store nothing. */
  | { kind: "trap" }
  /** A disposable inbox service, which nobody reads a launch email from. */
  | { kind: "throwaway-email" };

/** The hidden field people never see; bots that fill every input fill it too. */
export const trapField = "website";

/** A person needs longer than this between opening the page and pressing Join. */
export const minFillMs = 1500;

// Well-known disposable inbox services. Not complete: the mail-domain check in
// the API function catches made-up domains, and the rate limit catches volume.
const throwawayDomains = new Set([
  "10minutemail.com",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "guerrillamail.net",
  "mailinator.com",
  "maildrop.cc",
  "mailnesia.com",
  "mintemail.com",
  "mohmal.com",
  "sharklasers.com",
  "tempail.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

/** The part after the @. */
export function emailDomain(email: Email): string {
  return email.slice(email.lastIndexOf("@") + 1);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isMilliseconds(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlatformId(value: string): value is PlatformId {
  return platformOptions.some((option) => option.id === value);
}

function isAccountRange(value: string): value is AccountRange {
  return accountOptions.some((option) => option.id === value);
}

const emailPattern = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function isEmail(value: string): value is Email {
  return value.length <= limits.email && emailPattern.test(value);
}

// Postgres text can't hold NUL, and no answer needs other control characters
// except line breaks and tabs in the free-text field.
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;

    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d))
      return true;
  }

  return false;
}

type Text = { kind: "empty" } | { kind: "text"; value: string } | { kind: "invalid" };

/** An optional free-text answer: absent or blank is empty, too long or with control characters is invalid. */
function optionalText(value: JsonValue | undefined, max: number): Text {
  if (value === undefined || value === null) return { kind: "empty" };

  if (!isString(value)) return { kind: "invalid" };

  const trimmed = value.trim();

  if (trimmed === "") return { kind: "empty" };

  if (trimmed.length > max || hasControlCharacters(trimmed)) return { kind: "invalid" };

  return { kind: "text", value: trimmed };
}

function textOrNull(text: Text): string | null {
  return text.kind === "text" ? text.value : null;
}

/** A same-site path such as `/guides/threads-api`; anything else is dropped. */
function sitePath(value: JsonValue | undefined): string | null {
  if (!isString(value) || value.length > limits.cameFrom) return null;

  return /^\/(?!\/)[\w\-./]*$/.test(value) ? value : null;
}

/** One platform id or a list of them, or null when any value is unknown. */
function platformList(value: JsonValue | undefined): readonly PlatformId[] | null {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  const chosen = new Set<PlatformId>();

  for (const item of values) {
    if (!isString(item) || !isPlatformId(item)) return null;
    chosen.add(item);
  }

  // Keep the form's order so stored rows read the same way.
  return platformOptions.flatMap((option) => (chosen.has(option.id) ? [option.id] : []));
}

/** The account range, or null when the question was skipped. */
function accountRange(value: JsonValue | undefined): AccountRange | null | undefined {
  if (value === undefined || value === null || value === "") return null;

  return isString(value) && isAccountRange(value) ? value : undefined;
}

/** Turns a decoded request body into a signup, or names the first field that is wrong. */
export function parseSignup(body: JsonValue): ParsedSignup {
  if (!isJsonObject(body)) return { kind: "invalid", field: "email" };

  const trap = body[trapField];

  if (isString(trap) && trap.trim() !== "") return { kind: "trap" };

  const rawEmail = body.email;
  const email = isString(rawEmail) ? rawEmail.trim().toLowerCase() : "";

  if (!isEmail(email)) return { kind: "invalid", field: "email" };

  if (throwawayDomains.has(emailDomain(email))) return { kind: "throwaway-email" };

  const platforms = platformList(body.platforms);

  if (platforms === null) return { kind: "invalid", field: "platforms" };

  const otherPlatforms = optionalText(body.otherPlatforms, limits.otherPlatforms);

  if (otherPlatforms.kind === "invalid") return { kind: "invalid", field: "otherPlatforms" };

  const accounts = accountRange(body.accounts);

  if (accounts === undefined) return { kind: "invalid", field: "accounts" };

  const currentTool = optionalText(body.currentTool, limits.currentTool);

  if (currentTool.kind === "invalid") return { kind: "invalid", field: "currentTool" };

  return {
    kind: "signup",
    signup: {
      email,
      platforms,
      // Only kept when the visitor ticked Other.
      otherPlatforms: platforms.includes("other") ? textOrNull(otherPlatforms) : null,
      accounts,
      currentTool: textOrNull(currentTool),
      cameFrom: sitePath(body.cameFrom),
      elapsedMs: isMilliseconds(body.elapsedMs) ? Math.round(body.elapsedMs) : null,
    },
  };
}

/** A urlencoded form post as the same object the page's script sends as JSON. */
export function formBody(params: URLSearchParams): JsonObject {
  const body: { [key: string]: JsonValue } = {};

  for (const key of new Set(params.keys()))
    body[key] = key === "platforms" ? params.getAll(key) : (params.get(key) ?? "");

  return body;
}
