// The post limits page script: re-runs the preflight check as the reader types
// and filters the platform matrix. Form values are parsed here, at the input
// boundary, into the MediaPlan and platform list the pure checker takes; a media
// field the parser rejects is marked on the form and nothing is checked.
import { element, elements, wireCopyButtons } from "./dom";
import { parseMedia, type MediaField, type MediaParse, type RawField } from "./media-input";
import { isPlatformId, platformIds, type PlatformId } from "./platforms";
import { preflight } from "./preflight";
import { renderResults, summary } from "./preflight-view";
import { socialSnippet } from "./snippet";

const form = element("preflight", HTMLFormElement);

const text = element("post-text", HTMLTextAreaElement);

const count = element("media-count", HTMLInputElement);

const seconds = element("video-seconds", HTMLInputElement);

const size = element("media-size", HTMLInputElement);

const fields = {
  count: element("count-field", HTMLElement),
  seconds: element("seconds-field", HTMLElement),
  size: element("size-field", HTMLElement),
};

const inputs: Readonly<Record<MediaField, HTMLInputElement>> = { count, seconds, size };

const fieldErrors: Readonly<Record<MediaField, HTMLElement>> = {
  count: element("media-count-error", HTMLElement),
  seconds: element("video-seconds-error", HTMLElement),
  size: element("media-size-error", HTMLElement),
};

const facebookNote = element("facebook-note", HTMLElement);

const platformBoxes = elements('#preflight input[name="platforms"]', HTMLInputElement);

const mediaRadios = elements('#preflight input[name="media"]', HTMLInputElement);

const results = element("results", HTMLElement);

const summaryLine = element("summary", HTMLElement);

const snippet = element("snippet", HTMLElement);

const raw = (input: HTMLInputElement): RawField => ({
  value: input.value,
  badInput: input.validity.badInput,
});

function readMedia(): MediaParse {
  return parseMedia({
    kind: mediaRadios.find((radio) => radio.checked)?.value ?? "none",
    count: raw(count),
    seconds: raw(seconds),
    size: raw(size),
  });
}

/** Marks each rejected field, and clears the rest. */
function showFieldErrors(parsed: MediaParse): void {
  const errors = parsed.kind === "error" ? parsed.errors : [];

  for (const field of ["count", "seconds", "size"] as const) {
    const message = errors.find((error) => error.field === field)?.message;

    if (message === undefined) inputs[field].removeAttribute("aria-invalid");
    else inputs[field].setAttribute("aria-invalid", "true");

    fieldErrors[field].textContent = message ?? "";
    fieldErrors[field].hidden = message === undefined;
  }
}

function readPlatforms(): PlatformId[] {
  const checked = platformBoxes.flatMap((box) =>
    box.checked && isPlatformId(box.value) ? [box.value] : [],
  );

  return platformIds.filter((id) => checked.includes(id));
}

function update(): void {
  const parsed = readMedia();

  const kind = mediaRadios.find((radio) => radio.checked)?.value ?? "none";

  const platforms = readPlatforms();

  fields.count.hidden = kind !== "carousel";
  fields.seconds.hidden = kind !== "video";
  fields.size.hidden = kind === "none";
  facebookNote.hidden = !platforms.includes("facebook");
  showFieldErrors(parsed);

  if (parsed.kind === "error") {
    results.innerHTML = "";
    summaryLine.textContent = "Fix the media details marked above to check the post.";
    snippet.textContent =
      "// Fix the media details marked above to generate the matching code sample.";

    return;
  }

  snippet.textContent = socialSnippet(platforms, text.value, parsed.media);

  const checked = preflight(text.value, platforms, parsed.media);

  results.innerHTML = renderResults(checked);
  summaryLine.textContent = summary(checked);
}

form.addEventListener("input", update);

form.addEventListener("submit", (event) => event.preventDefault());

// ---------- the platform matrix filter ----------

const search = element("matrix-search", HTMLInputElement);

const filterRadios = elements('input[name="matrix-filter"]', HTMLInputElement);

const rows = elements("#matrix tbody tr", HTMLTableRowElement);

const empty = element("matrix-empty", HTMLElement);

function filterMatrix(): void {
  const query = search.value.trim().toLowerCase();

  const filter = filterRadios.find((radio) => radio.checked)?.value ?? "all";

  let shown = 0;

  for (const row of rows) {
    const matchesQuery = query === "" || (row.dataset["name"] ?? "").includes(query);

    const matchesFilter = filter === "all" || row.dataset[filter] === "true";

    row.hidden = !(matchesQuery && matchesFilter);

    if (!row.hidden) shown += 1;
  }

  empty.hidden = shown > 0;
}

search.addEventListener("input", filterMatrix);

for (const radio of filterRadios) radio.addEventListener("change", filterMatrix);

update();

wireCopyButtons();
