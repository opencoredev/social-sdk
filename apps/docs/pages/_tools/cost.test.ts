import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultScenario,
  estimate,
  formatRate,
  formatUsd,
  mergeScenarioParams,
  parseScenario,
  scenarioParams,
  X_POST_RATE,
  X_URL_POST_RATE,
  type Scenario,
} from "./cost";

const scenario = (changes: Partial<Scenario>): Scenario => ({ ...defaultScenario, ...changes });

test("defaults quote X's posted rates", () => {
  assert.equal(X_POST_RATE, 0.015);
  assert.equal(X_URL_POST_RATE, 0.2);
  assert.equal(defaultScenario.unifiedRatePerProfile, null);
});

test("bills X per post, with the URL rate for the share of posts with a link", () => {
  // 10 profiles × 30 posts = 300 X posts; half carry a link.
  const result = estimate(scenario({ profiles: 10, postsPerProfile: 30, linkShare: 50 }));

  assert.equal(result.xPosts, 300);
  assert.equal(result.xCredits, 150 * 0.015 + 150 * 0.2);
  assert.equal(result.direct.monthly, 32.25);
});

test("matches the X pricing guide's worked example", () => {
  // One account, 10 posts a day for 30 days: $4.50 plain, $60 with links.
  assert.equal(
    estimate(scenario({ profiles: 1, postsPerProfile: 300, linkShare: 0, platforms: ["x"] }))
      .xCredits,
    4.5,
  );
  assert.equal(
    estimate(scenario({ profiles: 1, postsPerProfile: 300, linkShare: 100, platforms: ["x"] }))
      .xCredits,
    60,
  );
});

test("charges no X credits when X isn't selected", () => {
  const result = estimate(scenario({ platforms: ["bluesky", "linkedin"] }));

  assert.equal(result.xPosts, 0);
  assert.equal(result.direct.monthly, 0);
  assert.equal(result.platformPosts, 25 * 30 * 2);
});

test("adds hosting and other platform fees to the direct route", () => {
  const result = estimate(
    scenario({ platforms: ["bluesky"], hosting: 20, otherPlatformFees: 5.5 }),
  );

  assert.equal(result.direct.monthly, 25.5);
  assert.deepEqual(
    result.direct.lines.map((line) => line.label),
    [
      "Social SDK (MIT license)",
      "X API credits",
      "Other platform fees",
      "Your hosting and webhooks",
    ],
  );
  assert.equal(result.direct.lines[0]?.amount, 0);
});

test("leaves the unified route empty until a rate is entered", () => {
  assert.equal(estimate(defaultScenario).unified, null);
});

test("prices the unified route per profile, plus its fee and X credits from your own app", () => {
  const base = scenario({
    profiles: 100,
    unifiedRatePerProfile: 2,
    unifiedBaseFee: 49,
    platforms: ["x"],
    linkShare: 0,
    postsPerProfile: 10,
  });

  assert.equal(estimate(base).unified?.monthly, 200 + 49 + 15);
  assert.equal(estimate({ ...base, unifiedUsesOwnXApp: false }).unified?.monthly, 249);
});

test("round-trips a scenario through query parameters", () => {
  const custom = scenario({
    profiles: 500,
    postsPerProfile: 12,
    platforms: ["x", "tiktok", "youtube"],
    linkShare: 25,
    xUrlPostRate: 0.25,
    hosting: 40,
    unifiedRatePerProfile: 1.5,
    unifiedUsesOwnXApp: false,
  });

  assert.deepEqual(parseScenario(scenarioParams(custom)), custom);
});

test("writes only what differs from the defaults", () => {
  assert.equal(scenarioParams(defaultScenario).toString(), "");
  assert.equal(scenarioParams(scenario({ profiles: 100 })).toString(), "profiles=100");
});

test("clamps and rejects bad query values", () => {
  const parsed = parseScenario(
    new URLSearchParams(
      "profiles=-4&posts=abc&links=250&platforms=x,myspace,threads&xRate=Infinity&profileRate=",
    ),
  );

  assert.equal(parsed.profiles, 1);
  assert.equal(parsed.postsPerProfile, defaultScenario.postsPerProfile);
  assert.equal(parsed.linkShare, 100);
  assert.deepEqual(parsed.platforms, ["x", "threads"]);
  assert.equal(parsed.xPostRate, X_POST_RATE);
  assert.equal(parsed.unifiedRatePerProfile, null);
});

test("keeps an explicitly empty platform list", () => {
  assert.deepEqual(parseScenario(new URLSearchParams("platforms=")).platforms, []);
});

test("formats US dollars to the cent", () => {
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(0), "$0.00");
});

test("keeps a sub-cent per-profile rate in the line label", () => {
  const result = estimate(scenario({ profiles: 5000, unifiedRatePerProfile: 0.005 }));

  assert.deepEqual(result.unified?.lines[0], { label: "5,000 profiles × $0.005", amount: 25 });
  assert.equal(formatRate(2), "$2.00");
  assert.equal(formatRate(1.5), "$1.50");
  assert.equal(formatRate(0.0125), "$0.0125");
});

test("a shared link parses to the same scenario after it is written back", () => {
  for (const query of [
    "links=12.5",
    "links=12.5&profiles=5000&posts=3000&profileRate=0.005",
    "xRate=0.0151&xUrlRate=0.2&hosting=19.99&platforms=x,youtube&ownX=0",
    "profiles=12.5",
  ]) {
    const parsed = parseScenario(new URLSearchParams(query));

    assert.deepEqual(parseScenario(scenarioParams(parsed)), parsed, query);
    assert.deepEqual(
      parseScenario(mergeScenarioParams(new URLSearchParams(query), parsed)),
      parsed,
    );
  }

  assert.equal(parseScenario(new URLSearchParams("links=12.5")).linkShare, 12.5);
  assert.equal(
    scenarioParams(parseScenario(new URLSearchParams("links=12.5"))).get("links"),
    "12.5",
  );
});

test("keeps query parameters the calculator doesn't own", () => {
  const current = new URLSearchParams("utm_source=test&links=12.5&ref=newsletter&profiles=40");

  const merged = mergeScenarioParams(current, scenario({ linkShare: 12.5, profiles: 100 }));

  assert.equal(merged.toString(), "utm_source=test&ref=newsletter&profiles=100&links=12.5");
  assert.equal(
    mergeScenarioParams(new URLSearchParams("utm_source=a&profiles=9"), defaultScenario).toString(),
    "utm_source=a",
  );
});
