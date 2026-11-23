// The social media API cost calculator's model. Every rate is an input the
// reader can change, so the page estimates their own scenario instead of
// promising a provider's price. The X defaults quote X's pricing page as read for
// the X API pricing guide; the per-profile rate has no default because the
// Ayrshare guide deliberately lists no prices.
import { platformIds, type PlatformId } from "./platforms";

/** X's rates on its pricing page, read 22 November 2026 (see /guides/x-api-pricing). */
export const X_RATES_READ = "22 November 2026";

export const X_PRICING_URL = "https://docs.x.com/x-api/getting-started/pricing";

export const X_POST_RATE = 0.015;

export const X_URL_POST_RATE = 0.2;

export type Scenario = {
  /** Customers, brands, or locations, each with its own connected accounts. */
  profiles: number;
  /** Posts each profile sends a month; each post goes to every selected platform. */
  postsPerProfile: number;
  platforms: PlatformId[];
  /** Share of posts that carry a URL, 0 to 100. */
  linkShare: number;
  /** X's price per post without and with a URL, in US dollars. */
  xPostRate: number;
  xUrlPostRate: number;
  /** Fees other platforms bill you each month, if any. */
  otherPlatformFees: number;
  /** What hosting your own OAuth callbacks, queue, and webhooks costs a month. */
  hosting: number;
  /** A per-profile unified API's monthly price per profile; null until the reader sets it. */
  unifiedRatePerProfile: number | null;
  /** A flat monthly platform fee on top of the per-profile price. */
  unifiedBaseFee: number;
  /** The unified API sends X posts through your own X app, so X still bills you. */
  unifiedUsesOwnXApp: boolean;
};

export const defaultScenario: Scenario = {
  profiles: 25,
  postsPerProfile: 30,
  platforms: ["x", "bluesky", "threads", "linkedin"],
  linkShare: 50,
  xPostRate: X_POST_RATE,
  xUrlPostRate: X_URL_POST_RATE,
  otherPlatformFees: 0,
  hosting: 0,
  unifiedRatePerProfile: null,
  unifiedBaseFee: 0,
  unifiedUsesOwnXApp: true,
};

export const profilePresets = [5, 25, 100, 500] as const;

export const limits = {
  profiles: { min: 1, max: 5000 },
  postsPerProfile: { min: 0, max: 3000 },
  linkShare: { min: 0, max: 100 },
  rate: { min: 0, max: 100_000 },
} as const;

export type CostLine = { label: string; amount: number };

export type RouteEstimate = {
  /** Monthly total in US dollars. */
  monthly: number;
  lines: CostLine[];
};

export type Estimate = {
  /** Posts sent to platforms a month: profiles × posts × platforms. */
  platformPosts: number;
  /** Posts sent to X a month. */
  xPosts: number;
  /** X credits a month at the entered rates. */
  xCredits: number;
  direct: RouteEstimate;
  /** Null until a per-profile rate is entered. */
  unified: RouteEstimate | null;
};

const cents = (value: number) => Math.round(value * 100) / 100;

/** A per-unit rate in US dollars, with as many decimals as it has (at least 2), such as $0.005. */
export function formatRate(rate: number): string {
  return rate.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function sum(lines: readonly CostLine[]): number {
  return cents(lines.reduce((total, line) => total + line.amount, 0));
}

export function estimate(scenario: Scenario): Estimate {
  const posts = scenario.profiles * scenario.postsPerProfile;

  const xPosts = scenario.platforms.includes("x") ? posts : 0;

  const linkPosts = (xPosts * scenario.linkShare) / 100;

  const xCredits = cents(
    (xPosts - linkPosts) * scenario.xPostRate + linkPosts * scenario.xUrlPostRate,
  );

  const directLines: CostLine[] = [
    { label: "Social SDK (MIT license)", amount: 0 },
    { label: "X API credits", amount: xCredits },
    { label: "Other platform fees", amount: cents(scenario.otherPlatformFees) },
    { label: "Your hosting and webhooks", amount: cents(scenario.hosting) },
  ];

  const rate = scenario.unifiedRatePerProfile;

  const unifiedLines: CostLine[] | null =
    rate === null
      ? null
      : [
          {
            label: `${scenario.profiles.toLocaleString("en-US")} profiles × ${formatRate(rate)}`,
            amount: cents(scenario.profiles * rate),
          },
          { label: "Platform fee", amount: cents(scenario.unifiedBaseFee) },
          {
            label: "X API credits (your own X app)",
            amount: scenario.unifiedUsesOwnXApp ? xCredits : 0,
          },
        ];

  return {
    platformPosts: posts * scenario.platforms.length,
    xPosts,
    xCredits,
    direct: { monthly: sum(directLines), lines: directLines },
    unified: unifiedLines === null ? null : { monthly: sum(unifiedLines), lines: unifiedLines },
  };
}

// ---------- URL query parameters, so a scenario can be shared ----------

const keys = {
  profiles: "profiles",
  postsPerProfile: "posts",
  platforms: "platforms",
  linkShare: "links",
  xPostRate: "xRate",
  xUrlPostRate: "xUrlRate",
  otherPlatformFees: "otherFees",
  hosting: "hosting",
  unifiedRatePerProfile: "profileRate",
  unifiedBaseFee: "baseFee",
  unifiedUsesOwnXApp: "ownX",
} as const satisfies Record<keyof Scenario, string>;

function readNumber(
  params: URLSearchParams,
  key: string,
  range: { min: number; max: number },
  fallback: number,
): number {
  const raw = params.get(key);

  if (raw === null || raw.trim() === "") return fallback;

  const value = Number(raw);

  if (!Number.isFinite(value)) return fallback;

  return Math.min(range.max, Math.max(range.min, value));
}

function readInteger(
  params: URLSearchParams,
  key: string,
  range: { min: number; max: number },
  fallback: number,
): number {
  return Math.round(readNumber(params, key, range, fallback));
}

/** Reads a scenario from query parameters. Missing or invalid values fall back to the defaults. */
export function parseScenario(params: URLSearchParams): Scenario {
  const listed = params.get(keys.platforms);

  const platforms = listed === null ? defaultScenario.platforms : parsePlatforms(listed.split(","));

  const rate = params.get(keys.unifiedRatePerProfile);

  const ownX = params.get(keys.unifiedUsesOwnXApp);

  return {
    profiles: readInteger(params, keys.profiles, limits.profiles, defaultScenario.profiles),
    postsPerProfile: readInteger(
      params,
      keys.postsPerProfile,
      limits.postsPerProfile,
      defaultScenario.postsPerProfile,
    ),
    platforms,
    linkShare: readNumber(params, keys.linkShare, limits.linkShare, defaultScenario.linkShare),
    xPostRate: readNumber(params, keys.xPostRate, limits.rate, defaultScenario.xPostRate),
    xUrlPostRate: readNumber(params, keys.xUrlPostRate, limits.rate, defaultScenario.xUrlPostRate),
    otherPlatformFees: readNumber(
      params,
      keys.otherPlatformFees,
      limits.rate,
      defaultScenario.otherPlatformFees,
    ),
    hosting: readNumber(params, keys.hosting, limits.rate, defaultScenario.hosting),
    unifiedRatePerProfile:
      rate === null || rate.trim() === "" || !Number.isFinite(Number(rate))
        ? null
        : readNumber(params, keys.unifiedRatePerProfile, limits.rate, 0),
    unifiedBaseFee: readNumber(
      params,
      keys.unifiedBaseFee,
      limits.rate,
      defaultScenario.unifiedBaseFee,
    ),
    unifiedUsesOwnXApp: ownX === null ? defaultScenario.unifiedUsesOwnXApp : ownX !== "0",
  };
}

/** Writes the values that differ from the defaults, so a shared link stays short. */
export function scenarioParams(scenario: Scenario): URLSearchParams {
  const params = new URLSearchParams();

  const numeric = [
    "profiles",
    "postsPerProfile",
    "linkShare",
    "xPostRate",
    "xUrlPostRate",
    "otherPlatformFees",
    "hosting",
    "unifiedBaseFee",
  ] as const;

  for (const key of numeric)
    if (scenario[key] !== defaultScenario[key]) params.set(keys[key], String(scenario[key]));

  if (scenario.platforms.join(",") !== defaultScenario.platforms.join(","))
    params.set(keys.platforms, scenario.platforms.join(","));

  if (scenario.unifiedRatePerProfile !== null)
    params.set(keys.unifiedRatePerProfile, String(scenario.unifiedRatePerProfile));

  if (scenario.unifiedUsesOwnXApp !== defaultScenario.unifiedUsesOwnXApp)
    params.set(keys.unifiedUsesOwnXApp, scenario.unifiedUsesOwnXApp ? "1" : "0");

  return params;
}

/**
 * The page's query string for `scenario`, keeping every parameter the calculator
 * doesn't own (such as utm_source or ref) from `current`, in its original order.
 */
export function mergeScenarioParams(current: URLSearchParams, scenario: Scenario): URLSearchParams {
  const owned: readonly string[] = Object.values(keys);

  const merged = new URLSearchParams();

  for (const [key, value] of current) if (!owned.includes(key)) merged.append(key, value);

  for (const [key, value] of scenarioParams(scenario)) merged.set(key, value);

  return merged;
}

/** Parses a platform list such as "x,bluesky", dropping unknown names. */
export function parsePlatforms(values: readonly string[]): PlatformId[] {
  return platformIds.filter((id) => values.includes(id));
}

export function formatUsd(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
