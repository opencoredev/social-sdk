import type { JsonObject, JsonValue } from "@opencoredev/social-sdk";

function element(id: string): HTMLElement;
function element<T extends HTMLElement>(id: string, type: abstract new () => T): T;
function element(id: string, type: abstract new () => HTMLElement = HTMLElement): HTMLElement {
  const found = document.getElementById(id);

  if (!found) throw new Error(`Missing element ${id}`);

  if (!(found instanceof type)) throw new Error(`Element ${id} is not a ${type.name}`);

  return found;
}

/** JSON.parse output is always JSON; checking it keeps `any` out of typed code. */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;

  if (typeof value === "number") return Number.isFinite(value);

  if (Array.isArray(value)) return value.every(isJsonValue);

  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function parseJson(raw: string): JsonValue {
  const parsed: unknown = JSON.parse(raw);

  if (!isJsonValue(parsed)) throw new SyntaxError("Expected a JSON value");

  return parsed;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns a successful JSON response into the shape one call site reads, or throws. */
type Decoder<T> = (value: JsonValue) => T;

function malformed(what: string): never {
  throw new Error(`Unexpected response from the example server: ${what}`);
}

function objectOf(value: JsonValue | undefined, what: string): JsonObject {
  return isJsonObject(value) ? value : malformed(`${what} must be an object`);
}

function arrayOf(value: JsonValue | undefined, what: string): readonly JsonValue[] {
  return Array.isArray(value) ? value : malformed(`${what} must be an array`);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}

function isBoolean(value: JsonValue | undefined): value is boolean {
  return typeof value === "boolean";
}

function stringOf(value: JsonValue | undefined, what: string): string {
  return isString(value) ? value : malformed(`${what} must be a string`);
}

function numberOf(value: JsonValue | undefined, what: string): number {
  return isNumber(value) ? value : malformed(`${what} must be a number`);
}

function booleanOf(value: JsonValue | undefined, what: string): boolean {
  return isBoolean(value) ? value : malformed(`${what} must be a boolean`);
}

function optionalStringOf(value: JsonValue | undefined, what: string): string | undefined {
  return value === undefined ? undefined : stringOf(value, what);
}

/** The account fields the UI shows for a destination. */
type AccountView = { readonly platform: string; readonly accountId: string };

/** A platform post reference kept verbatim so the server receives exactly what it returned. */
type PostView = { readonly ref: JsonObject; readonly postId: string };

type OutcomeView =
  | {
      readonly state: "published";
      readonly account: AccountView;
      readonly post: PostView;
      readonly url: string | undefined;
    }
  | { readonly state: "failed"; readonly account: AccountView; readonly message: string }
  | { readonly state: "not-submitted"; readonly account: AccountView; readonly reason: string }
  | {
      readonly state: "scheduled" | "accepted" | "processing" | "cancelled" | "unknown";
      readonly account: AccountView;
    };

type ResultView = { readonly outcomes: readonly OutcomeView[] };

const passiveStates = ["scheduled", "accepted", "processing", "cancelled", "unknown"] as const;

function isPassiveState(state: string): state is (typeof passiveStates)[number] {
  return passiveStates.some((candidate) => candidate === state);
}

function decodeAccountRef(value: JsonValue | undefined, what: string): AccountView {
  const ref = objectOf(value, what);

  return {
    platform: stringOf(ref["platform"], `${what}.platform`),
    accountId: stringOf(ref["accountId"], `${what}.accountId`),
  };
}

function decodeOutcome(value: JsonValue, index: number): OutcomeView {
  const what = `outcomes[${index}]`;
  const outcome = objectOf(value, what);
  const state = stringOf(outcome["state"], `${what}.state`);
  const account = decodeAccountRef(outcome["account"], `${what}.account`);

  if (state === "published") {
    const ref = objectOf(outcome["post"], `${what}.post`);

    return {
      state,
      account,
      post: { ref, postId: stringOf(ref["postId"], `${what}.post.postId`) },
      url: optionalStringOf(outcome["url"], `${what}.url`),
    };
  }

  if (state === "failed")
    return { state, account, message: stringOf(outcome["message"], `${what}.message`) };

  if (state === "not-submitted")
    return { state, account, reason: stringOf(outcome["reason"], `${what}.reason`) };

  if (isPassiveState(state)) return { state, account };

  return malformed(`${what}.state "${state}" is not a delivery state`);
}

/** Reads `{ result: PublishResult }` from /api/publish and /api/reconcile. */
function decodeResultResponse(value: JsonValue): ResultView {
  const result = objectOf(objectOf(value, "response")["result"], "result");

  return { outcomes: arrayOf(result["outcomes"], "result.outcomes").map(decodeOutcome) };
}

function decodeAccountsResponse(value: JsonValue) {
  const response = objectOf(value, "response");

  return {
    simulated: booleanOf(response["simulated"], "simulated"),
    authenticatedPrincipal: stringOf(response["authenticatedPrincipal"], "authenticatedPrincipal"),
    accounts: arrayOf(response["accounts"], "accounts").map((entry, index) => {
      const account = objectOf(entry, `accounts[${index}]`);

      return {
        displayName: stringOf(account["displayName"], `accounts[${index}].displayName`),
        ref: decodeAccountRef(account["ref"], `accounts[${index}].ref`),
      };
    }),
  };
}

function decodePreparationResponse(value: JsonValue) {
  const preparation = objectOf(objectOf(value, "response")["preparation"], "preparation");

  return {
    ok: booleanOf(preparation["ok"], "preparation.ok"),
    issues: arrayOf(preparation["issues"], "preparation.issues").map((entry, index) => ({
      message: stringOf(
        objectOf(entry, `preparation.issues[${index}]`)["message"],
        `preparation.issues[${index}].message`,
      ),
    })),
  };
}

function decodeMetricsResponse(value: JsonValue) {
  return arrayOf(objectOf(value, "response")["metrics"], "metrics").map((entry, index) => {
    const metric = objectOf(entry, `metrics[${index}]`);

    return {
      name: stringOf(metric["name"], `metrics[${index}].name`),
      value: numberOf(metric["value"], `metrics[${index}].value`),
      unit: stringOf(metric["unit"], `metrics[${index}].unit`),
    };
  });
}

/** Comment items are provider JSON; the UI only reads a string `id` and `text` when present. */
function decodeCommentsResponse(value: JsonValue) {
  return arrayOf(objectOf(value, "response")["items"], "items").map((entry, index) => {
    const item = objectOf(entry, `items[${index}]`);
    const id = item["id"];
    const text = item["text"];

    return {
      id: isString(id) ? id : undefined,
      text: isString(text) ? text : undefined,
    };
  });
}

function decodeEventResponse(value: JsonValue): string {
  return stringOf(objectOf(value, "response")["state"], "state");
}

function decodeProcessResponse(value: JsonValue) {
  const response = objectOf(value, "response");

  return {
    applied: numberOf(response["applied"], "applied"),
    pending: numberOf(response["pending"], "pending"),
  };
}

/** For routes whose success body the UI does not read. */
function ignoreBody(): void {}

const text = element("text", HTMLTextAreaElement);

const format = element("format", HTMLSelectElement);

const publish = element("publish", HTMLButtonElement);

const notice = element("notice");

let simulated = false;

let key = "";

let currentKey = "";

let revision = 0;

let prepared = false;

let current: ResultView | undefined;

let selectedPost: PostView | undefined;

/** JSON bodies the UI posts: plain JSON objects and drafts. */
type RequestBody = JsonObject | Draft;

async function api<T>(
  path: string,
  value: RequestBody | undefined,
  decode: Decoder<T>,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(
    path,
    value === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(value),
        },
  );

  const raw = await response.text();
  let data: JsonValue;

  try {
    data = parseJson(raw);
  } catch {
    data = { message: raw };
  }

  if (!response.ok)
    throw new Error(
      isJsonObject(data) && "message" in data
        ? String(data["message"])
        : `Request failed (${response.status})`,
    );

  return decode(data);
}

function uniqueKey(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function selectedIds(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>("#accounts input:checked")].map(
    (input) => input.value,
  );
}

type Draft = {
  accountIds: string[];
  text: string;
  format: string;
  idempotencyKey: string;
  mediaUrl?: string;
  mediaMime?: string;
  optionsByAccount?: JsonValue;
};

function draft(): Draft {
  const options = element("platform-options", HTMLTextAreaElement).value.trim();

  const submitted: Draft = {
    accountIds: selectedIds(),
    text: text.value,
    format: format.value,
    idempotencyKey: key,
  };

  if (format.value === "video") {
    submitted.mediaUrl = element("media-url", HTMLInputElement).value;
    submitted.mediaMime = element("media-mime", HTMLInputElement).value;
  }

  if (options) submitted.optionsByAccount = parseJson(options);

  return submitted;
}

function invalidate() {
  revision++;
  prepared = false;
  key = uniqueKey();
  publish.disabled = true;
  element("video-fields").hidden = format.value !== "video";
  element("media-url", HTMLInputElement).required = format.value === "video";
}

async function act(work: () => Promise<void>) {
  try {
    notice.textContent = "Working…";
    await work();
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "Request failed";
  }
}

function outcomeLine(outcome: OutcomeView): HTMLElement {
  const row = document.createElement("div");
  row.className = "result";
  const heading = document.createElement("h3");
  heading.textContent = `${outcome.account.platform} · ${outcome.account.accountId} `;
  const state = document.createElement("span");
  state.className = `state ${outcome.state}`;
  state.textContent = outcome.state;
  heading.append(state);
  row.append(heading);
  const detail = document.createElement("p");
  detail.textContent =
    outcome.state === "failed"
      ? outcome.message
      : outcome.state === "unknown"
        ? "Acceptance is uncertain. Check delivery status before considering another publication."
        : outcome.state === "not-submitted"
          ? outcome.reason
          : outcome.state === "published"
            ? `Native post ${outcome.post.postId}`
            : "Retain this result and check delivery status explicitly.";
  row.append(detail);

  if (outcome.state === "published") {
    const actions = document.createElement("div");
    actions.className = "actions";

    if (outcome.url?.startsWith("https://")) {
      const link = document.createElement("a");
      link.href = outcome.url;
      link.textContent = "Open native post";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      actions.append(link);
    }

    const metrics = document.createElement("button");
    metrics.textContent = "Read metrics / select post";
    metrics.onclick = () =>
      void act(async () => {
        selectedPost = outcome.post;
        element("reply", HTMLButtonElement).disabled = false;

        const metrics = await api("/api/metrics", outcome.post.ref, decodeMetricsResponse);

        element("metrics").textContent = metrics.length
          ? metrics.map((metric) => `${metric.name}: ${metric.value} ${metric.unit}`).join("\n")
          : "No metrics are available for this post.";

        try {
          const comments = await api(
            "/api/comments/list",
            outcome.post.ref,
            decodeCommentsResponse,
          );

          const first = comments[0];

          if (first?.id) {
            element("comment-id", HTMLInputElement).value = first.id;
            element("comment-status").textContent = first.text ?? "Parent comment loaded.";
          }
        } catch {
          element("comment-status").textContent =
            "Comment listing is unavailable for this backend. Use an authorized native comment reference if supported.";
        }

        notice.textContent = "Metrics read. This post is selected for comment replies.";
      });
    actions.append(metrics);
    row.append(actions);
  }

  return row;
}

function render(result: ResultView) {
  current = result;
  const output = element("results");
  output.replaceChildren(...result.outcomes.map(outcomeLine));

  const pending = result.outcomes.some((outcome) =>
    ["scheduled", "accepted", "processing", "unknown"].includes(outcome.state),
  );

  element("reconcile").hidden = !pending;
  element("advance").hidden = !simulated || !pending;
  element("replay", HTMLButtonElement).disabled = !simulated || !result.outcomes.length;
}

async function reconcile() {
  render(await api("/api/reconcile", { idempotencyKey: currentKey }, decodeResultResponse));
}

const composer = element("composer", HTMLFormElement);

composer.addEventListener("input", invalidate);

format.addEventListener("change", invalidate);

element("prepare", HTMLButtonElement).onclick = () =>
  void act(async () => {
    if (!selectedIds().length) throw new Error("Select at least one destination.");

    if (!composer.reportValidity()) throw new Error("Complete the required fields.");
    const version = revision;
    const submitted = draft();
    const preparation = await api("/api/prepare", submitted, decodePreparationResponse);

    if (version !== revision) {
      notice.textContent = "The draft changed during preparation. Check it again.";

      return;
    }

    const preview = element("preview");
    preview.hidden = false;
    preview.textContent = text.value;
    prepared = preparation.ok;
    publish.disabled = !prepared;
    notice.textContent = prepared
      ? "Preparation passed. Review the preview before publishing."
      : preparation.issues.map((issue) => issue.message).join(" ");
  });

composer.onsubmit = (event) => {
  event.preventDefault();

  if (!prepared) return;
  publish.disabled = true;
  const submitted = draft();
  const scenario = element("scenario", HTMLSelectElement).value;
  void act(async () => {
    if (simulated) await api("/api/mock/scenario", { scenario }, ignoreBody);
    const result = await api("/api/publish", submitted, decodeResultResponse);
    currentKey = submitted.idempotencyKey;
    render(result);
    notice.textContent = "Publication submitted. Each destination's result is shown independently.";
  });
};

element("reconcile", HTMLButtonElement).onclick = () =>
  void act(async () => {
    await reconcile();
    notice.textContent = "Delivery status checked.";
  });

element("advance", HTMLButtonElement).onclick = () =>
  void act(async () => {
    await api("/api/mock/advance", {}, ignoreBody);
    await reconcile();
    notice.textContent = "Simulated processing advanced and status checked.";
  });

element("replay", HTMLButtonElement).onclick = () =>
  void act(async () => {
    if (!current?.outcomes[0]) return;

    const event = {
      eventId: `demo-${currentKey}`,
      accountId: current.outcomes[0].account.accountId,
      publicationKey: currentKey,
    };

    const first = await api("/api/events", event, decodeEventResponse, {
      "x-mock-signature": "valid",
    });

    const second = await api("/api/events", event, decodeEventResponse, {
      "x-mock-signature": "valid",
    });

    element("events-status").textContent = `First delivery: ${first}. Replay: ${second}.`;
    notice.textContent = "Webhook replay accepted. Processing remains explicit.";
  });

element("process", HTMLButtonElement).onclick = () =>
  void act(async () => {
    const result = await api("/api/events/process", {}, decodeProcessResponse);
    element("events-status").textContent =
      `Applied ${result.applied} event(s). Pending ${result.pending}.`;

    if (current) await reconcile();
    notice.textContent = "Pending event processing finished.";
  });

element("comment-form", HTMLFormElement).onsubmit = (event) => {
  event.preventDefault();

  const post = selectedPost;

  if (!post) return;
  void act(async () => {
    await api(
      "/api/comments/reply",
      {
        ...post.ref,
        commentId: element("comment-id", HTMLInputElement).value,
        text: element("reply-text", HTMLInputElement).value,
      },
      ignoreBody,
    );
    element("comment-status").textContent = "Reply accepted by the backend.";
    notice.textContent = "Comment reply completed.";
  });
};

void act(async () => {
  const response = await api("/api/accounts", undefined, decodeAccountsResponse);

  simulated = response.simulated;
  element("mode").textContent = simulated
    ? "Simulated · no live posts"
    : "Live backend · actions contact your provider";
  element("mock-controls").hidden = !simulated;
  element("events-panel").hidden = !simulated;
  const choices = element("accounts");
  choices.replaceChildren();

  for (const account of response.accounts) {
    const label = document.createElement("label");
    label.className = "account";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = account.ref.accountId;
    const title = document.createElement("span");
    title.textContent = `${account.displayName} · ${account.ref.platform}`;
    label.append(checkbox, title);
    choices.append(label);
  }

  if (!response.accounts.length)
    choices.textContent =
      "No authorized accounts. Connect accounts through your configured backend first.";
  invalidate();
  notice.textContent = `Signed in as ${response.authenticatedPrincipal}. Select your destinations.`;
});
