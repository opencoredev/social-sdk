// Markup for preflight results. The page renders it on the server for the
// sample post, and limits.client.ts renders it again as the reader types, so
// both always match. Every value is escaped here.
import { escapeHtml } from "./escape";
import { platformSpec } from "./platforms";
import type { PlatformResult, Verdict } from "./preflight";

export const verdictLabels: Readonly<Record<Verdict, string>> = {
  pass: "Fits",
  warn: "Check",
  fail: "Over limit",
};

function meter(result: PlatformResult): string {
  const { used, limit, unit } = result.meter;

  const share = Math.min(100, (used / limit) * 100);

  const over = used > limit ? " over" : "";

  return `<div class="meter${over}" role="img" aria-label="${escapeHtml(`${used} of ${limit} ${unit}`)}"><span style="width:${share.toFixed(1)}%"></span></div>
              <p class="meter-num"><span class="num">${used.toLocaleString("en-US")}</span> / ${limit.toLocaleString("en-US")} ${escapeHtml(unit)}</p>`;
}

function resultItem(result: PlatformResult): string {
  const spec = platformSpec(result.platform);

  // A passing text check is already shown by the meter.
  const checks = result.checks
    .flatMap((check) =>
      check.verdict === "pass" && check.label === "Text"
        ? []
        : [
            `<li class="${check.verdict}"><b>${escapeHtml(check.label)}.</b> ${escapeHtml(check.detail)}</li>`,
          ],
    )
    .join("");

  const notes = result.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");

  return `<li class="result ${result.verdict}">
              <div class="result-head"><b>${escapeHtml(result.name)}</b><span class="stamp ${result.verdict}">${verdictLabels[result.verdict]}</span></div>
              ${meter(result)}
              ${checks === "" ? "" : `<ul class="checks">${checks}</ul>`}
              ${notes === "" ? "" : `<ul class="notes">${notes}</ul>`}
              <a class="more" href="${spec.docsPath}">${escapeHtml(spec.name)} limits in the docs</a>
            </li>`;
}

export function summary(results: readonly PlatformResult[]): string {
  if (results.length === 0) return "Pick at least one platform.";

  const count = (verdict: Verdict) => results.filter((result) => result.verdict === verdict).length;

  const parts = [
    [count("pass"), "fit"],
    [count("warn"), "need a check"],
    [count("fail"), "over a limit"],
  ] as const;

  return parts
    .flatMap(([n, label]) =>
      n === 0 ? [] : [`${n} ${n === 1 && label === "need a check" ? "needs a check" : label}`],
    )
    .join(", ")
    .concat(".");
}

export function renderResults(results: readonly PlatformResult[]): string {
  return results.map(resultItem).join("\n            ");
}
