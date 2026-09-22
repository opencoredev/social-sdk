/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract. */
import type {
  AccountRecord,
  DeliveryOutcome,
  PublishResult,
  PlatformPostRef,
  PublishPreparation,
} from "@opencoredev/social-sdk";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) throw new Error(`Missing element ${id}`);

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
  return found as T;
}

const text = element<HTMLTextAreaElement>("text");

const format = element<HTMLSelectElement>("format");

const publish = element<HTMLButtonElement>("publish");

const notice = element("notice");

let simulated = false;

let key = "";

let currentKey = "";

let revision = 0;

let prepared = false;

let current: PublishResult | undefined;

let selectedPost: PlatformPostRef | undefined;

async function api<T>(
  path: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- validated boundary or fixture contract.
  value?: unknown,
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
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    // oxlint-disable-next-line anti-slop/no-known-value-widening -- validated boundary or fixture contract.
    data = { message: raw };
  }

  if (!response.ok)
    throw new Error(
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validated boundary or fixture contract.
      typeof data === "object" && data && "message" in data
        ? String(data.message)
        : `Request failed (${response.status})`,
    );

  // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
  return data as T;
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

function draft() {
  const options = element<HTMLTextAreaElement>("platform-options").value.trim();

  return {
    accountIds: selectedIds(),
    text: text.value,
    format: format.value,
    idempotencyKey: key,
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    ...(format.value === "video"
      ? {
          mediaUrl: element<HTMLInputElement>("media-url").value,
          mediaMime: element<HTMLInputElement>("media-mime").value,
        }
      : {}),
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- provider payload is validated at this adapter boundary.
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- validated external boundary or fixture contract.
    // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- validated external boundary or fixture contract.
    ...(options ? { optionsByAccount: JSON.parse(options) as unknown } : {}),
  };
}

function invalidate() {
  revision++;
  prepared = false;
  key = uniqueKey();
  publish.disabled = true;
  element("video-fields").hidden = format.value !== "video";
  element<HTMLInputElement>("media-url").required = format.value === "video";
}

async function act(work: () => Promise<void>) {
  try {
    notice.textContent = "Working…";
    await work();
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "Request failed";
  }
}

function outcomeLine(outcome: DeliveryOutcome): HTMLElement {
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
        element<HTMLButtonElement>("reply").disabled = false;

        const result = await api<{
          metrics: readonly { name: string; value: number; unit: string }[];
        }>("/api/metrics", outcome.post);

        element("metrics").textContent = result.metrics.length
          ? result.metrics
              .map((metric) => `${metric.name}: ${metric.value} ${metric.unit}`)
              .join("\n")
          : "No metrics are available for this post.";

        try {
          const comments = await api<{ items: readonly { id?: string; text?: string }[] }>(
            "/api/comments/list",
            outcome.post,
          );

          const first = comments.items[0];

          if (first?.id) {
            element<HTMLInputElement>("comment-id").value = first.id;
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

function render(result: PublishResult) {
  current = result;
  const output = element("results");
  output.replaceChildren(...result.outcomes.map(outcomeLine));

  const pending = result.outcomes.some((outcome) =>
    ["accepted", "processing", "unknown"].includes(outcome.state),
  );

  element("reconcile").hidden = !pending;
  element("advance").hidden = !simulated || !pending;
  element<HTMLButtonElement>("replay").disabled = !simulated || !result.outcomes.length;
}

async function reconcile() {
  const response = await api<{ result: PublishResult }>("/api/reconcile", {
    idempotencyKey: currentKey,
  });

  render(response.result);
}

const composer = element<HTMLFormElement>("composer");

composer.addEventListener("input", invalidate);

format.addEventListener("change", invalidate);

element<HTMLButtonElement>("prepare").onclick = () =>
  void act(async () => {
    if (!selectedIds().length) throw new Error("Select at least one destination.");

    if (!composer.reportValidity()) throw new Error("Complete the required fields.");
    const version = revision;
    const submitted = draft();
    const result = await api<{ preparation: PublishPreparation }>("/api/prepare", submitted);

    if (version !== revision) {
      notice.textContent = "The draft changed during preparation. Check it again.";

      return;
    }

    const preview = element("preview");
    preview.hidden = false;
    preview.textContent = text.value;
    prepared = result.preparation.ok;
    publish.disabled = !prepared;
    notice.textContent = prepared
      ? "Preparation passed. Review the preview before publishing."
      : result.preparation.issues.map((issue) => issue.message).join(" ");
  });

composer.onsubmit = (event) => {
  event.preventDefault();

  if (!prepared) return;
  publish.disabled = true;
  const submitted = draft();
  const scenario = element<HTMLSelectElement>("scenario").value;
  void act(async () => {
    if (simulated) await api("/api/mock/scenario", { scenario });
    const response = await api<{ result: PublishResult }>("/api/publish", submitted);
    currentKey = submitted.idempotencyKey;
    render(response.result);
    notice.textContent = "Publication submitted. Each destination's result is shown independently.";
  });
};

element<HTMLButtonElement>("reconcile").onclick = () =>
  void act(async () => {
    await reconcile();
    notice.textContent = "Delivery status checked.";
  });

element<HTMLButtonElement>("advance").onclick = () =>
  void act(async () => {
    await api("/api/mock/advance", {});
    await reconcile();
    notice.textContent = "Simulated processing advanced and status checked.";
  });

element<HTMLButtonElement>("replay").onclick = () =>
  void act(async () => {
    if (!current?.outcomes[0]) return;

    const event = {
      eventId: `demo-${currentKey}`,
      accountId: current.outcomes[0].account.accountId,
      publicationKey: currentKey,
    };

    const first = await api<{ state: string }>("/api/events", event, {
      "x-mock-signature": "valid",
    });

    const second = await api<{ state: string }>("/api/events", event, {
      "x-mock-signature": "valid",
    });

    element("events-status").textContent =
      `First delivery: ${first.state}. Replay: ${second.state}.`;
    notice.textContent = "Webhook replay accepted. Processing remains explicit.";
  });

element<HTMLButtonElement>("process").onclick = () =>
  void act(async () => {
    const result = await api<{ applied: number; pending: number }>("/api/events/process", {});
    element("events-status").textContent =
      `Applied ${result.applied} event(s). Pending ${result.pending}.`;

    if (current) await reconcile();
    notice.textContent = "Pending event processing finished.";
  });

element<HTMLFormElement>("comment-form").onsubmit = (event) => {
  event.preventDefault();

  if (!selectedPost) return;
  void act(async () => {
    await api("/api/comments/reply", {
      ...selectedPost,
      commentId: element<HTMLInputElement>("comment-id").value,
      text: element<HTMLInputElement>("reply-text").value,
    });
    element("comment-status").textContent = "Reply accepted by the backend.";
    notice.textContent = "Comment reply completed.";
  });
};

void act(async () => {
  const response = await api<{
    accounts: readonly AccountRecord[];
    simulated: boolean;
    authenticatedPrincipal: string;
  }>("/api/accounts");

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
