// The cost calculator's page script. The form is the input boundary: its values
// go through parseScenario, the same parser the shared URL uses, so a typed or
// pasted value is clamped and checked once before the model sees it.
import {
  defaultScenario,
  estimate,
  formatUsd,
  limits,
  mergeScenarioParams,
  parseScenario,
  type Scenario,
} from "./cost";
import { copyText, element, elements, flash, wireCopyButtons } from "./dom";
import { SNIPPET_TEXT, socialSnippet } from "./snippet";

const form = element("calculator", HTMLFormElement);

const profilesRange = element("profiles-range", HTMLInputElement);

const profiles = element("profiles", HTMLInputElement);

const postsRange = element("posts-range", HTMLInputElement);

const posts = element("posts", HTMLInputElement);

const linksRange = element("links-range", HTMLInputElement);

const links = element("links", HTMLInputElement);

const xRate = element("x-rate", HTMLInputElement);

const xUrlRate = element("x-url-rate", HTMLInputElement);

const hosting = element("hosting", HTMLInputElement);

const otherFees = element("other-fees", HTMLInputElement);

const profileRate = element("profile-rate", HTMLInputElement);

const baseFee = element("base-fee", HTMLInputElement);

const ownX = element("own-x", HTMLInputElement);

const platformBoxes = elements('input[name="platforms"]', HTMLInputElement);

const presets = elements("button[data-preset]", HTMLButtonElement);

const output = {
  volume: element("volume", HTMLElement),
  directTotal: element("direct-total", HTMLElement),
  directFill: element("direct-fill", HTMLElement),
  directLines: element("direct-lines", HTMLElement),
  unifiedTotal: element("unified-total", HTMLElement),
  unifiedTrack: element("unified-track", HTMLElement),
  unifiedFill: element("unified-fill", HTMLElement),
  unifiedLines: element("unified-lines", HTMLElement),
  unifiedNote: element("unified-note", HTMLElement),
  perProfile: element("per-profile", HTMLElement),
  snippet: element("snippet", HTMLElement),
  status: element("share-status", HTMLElement),
};

/** A range input's position for `value`; the number field next to it keeps the exact value. */
const rangePosition = (range: HTMLInputElement, value: number) =>
  String(Math.min(Math.max(value, Number(range.min)), Number(range.max)));

/** The form's current values, parsed like a shared link. */
function readForm(): Scenario {
  const params = new URLSearchParams({
    profiles: profiles.value,
    posts: posts.value,
    platforms: platformBoxes.flatMap((box) => (box.checked ? [box.value] : [])).join(","),
    links: links.value,
    xRate: xRate.value,
    xUrlRate: xUrlRate.value,
    hosting: hosting.value,
    otherFees: otherFees.value,
    profileRate: profileRate.value,
    baseFee: baseFee.value,
    ownX: ownX.checked ? "1" : "0",
  });

  return parseScenario(params);
}

function writeForm(scenario: Scenario): void {
  profiles.value = String(scenario.profiles);
  profilesRange.value = rangePosition(profilesRange, scenario.profiles);
  posts.value = String(scenario.postsPerProfile);
  postsRange.value = rangePosition(postsRange, scenario.postsPerProfile);
  links.value = String(scenario.linkShare);
  linksRange.value = rangePosition(linksRange, scenario.linkShare);
  xRate.value = String(scenario.xPostRate);
  xUrlRate.value = String(scenario.xUrlPostRate);
  hosting.value = String(scenario.hosting);
  otherFees.value = String(scenario.otherPlatformFees);
  profileRate.value =
    scenario.unifiedRatePerProfile === null ? "" : String(scenario.unifiedRatePerProfile);
  baseFee.value = String(scenario.unifiedBaseFee);
  ownX.checked = scenario.unifiedUsesOwnXApp;

  for (const box of platformBoxes)
    box.checked = scenario.platforms.some((platform) => platform === box.value);
}

function lineList(target: HTMLElement, lines: readonly { label: string; amount: number }[]): void {
  target.replaceChildren(
    ...lines.map((line) => {
      const item = document.createElement("li");

      const label = document.createElement("span");

      const amount = document.createElement("span");

      label.textContent = line.label;
      amount.className = "num";
      amount.textContent = formatUsd(line.amount);
      item.append(label, amount);

      return item;
    }),
  );
}

const percent = (value: number, max: number) => (max <= 0 ? "0%" : `${(value / max) * 100}%`);

function render(scenario: Scenario): void {
  const result = estimate(scenario);

  const unified = result.unified;

  const max = Math.max(result.direct.monthly, unified?.monthly ?? 0);

  output.volume.textContent = `${result.platformPosts.toLocaleString("en-US")} platform posts, ${result.xPosts.toLocaleString("en-US")} of them on X.`;
  output.directTotal.textContent = formatUsd(result.direct.monthly);
  output.directFill.style.width = percent(result.direct.monthly, max);
  lineList(output.directLines, result.direct.lines);

  output.unifiedTrack.classList.toggle("empty", unified === null);
  output.unifiedFill.style.width = unified === null ? "0%" : percent(unified.monthly, max);
  output.unifiedTotal.textContent = unified === null ? "Add a rate" : formatUsd(unified.monthly);
  lineList(output.unifiedLines, unified?.lines ?? []);
  output.unifiedNote.textContent =
    unified === null
      ? "Enter the per-profile price from the provider's own pricing page to compare."
      : "The provider holds the platform apps and account connections for most networks.";

  const perProfile = (amount: number) => formatUsd(amount / scenario.profiles);

  if (unified === null)
    output.perProfile.textContent = `Per profile: ${perProfile(result.direct.monthly)} a month direct.`;
  else {
    const difference = unified.monthly - result.direct.monthly;

    output.perProfile.textContent =
      difference === 0
        ? `Both routes cost ${formatUsd(unified.monthly)} a month.`
        : `Direct is ${formatUsd(Math.abs(difference))} a month ${difference > 0 ? "less" : "more"}: ${perProfile(result.direct.monthly)} against ${perProfile(unified.monthly)} per profile.`;
  }

  output.snippet.textContent = socialSnippet(scenario.platforms, SNIPPET_TEXT);

  // Other parameters (utm_source, ref) and the #fragment stay as they were.
  const query = mergeScenarioParams(new URLSearchParams(location.search), scenario).toString();

  history.replaceState(
    history.state,
    "",
    `${location.pathname}${query === "" ? "" : `?${query}`}${location.hash}`,
  );
}

function update(): void {
  const scenario = readForm();

  for (const preset of presets)
    preset.setAttribute(
      "aria-pressed",
      String(Number(preset.dataset["preset"]) === scenario.profiles),
    );

  render(scenario);
}

profilesRange.addEventListener("input", () => {
  profiles.value = profilesRange.value;
});

postsRange.addEventListener("input", () => {
  posts.value = postsRange.value;
});

linksRange.addEventListener("input", () => {
  links.value = linksRange.value;
});

profiles.addEventListener("input", () => {
  profilesRange.value = rangePosition(profilesRange, Number(profiles.value) || limits.profiles.min);
});

posts.addEventListener("input", () => {
  postsRange.value = rangePosition(postsRange, Number(posts.value) || 0);
});

links.addEventListener("input", () => {
  linksRange.value = rangePosition(linksRange, Number(links.value) || 0);
});

for (const preset of presets)
  preset.addEventListener("click", () => {
    profiles.value = preset.dataset["preset"] ?? String(defaultScenario.profiles);
    profilesRange.value = profiles.value;
    update();
  });

form.addEventListener("input", update);

form.addEventListener("change", () => writeForm(readForm()));

form.addEventListener("submit", (event) => event.preventDefault());

element("reset", HTMLButtonElement).addEventListener("click", () => {
  writeForm(defaultScenario);
  update();
});

element("share", HTMLButtonElement).addEventListener("click", async () => {
  flash(
    output.status,
    (await copyText(location.href))
      ? "Link copied. It opens with these numbers."
      : "Copy the address bar to share these numbers.",
  );
});

writeForm(parseScenario(new URLSearchParams(location.search)));

update();

wireCopyButtons();
