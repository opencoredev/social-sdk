import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";

import { headScripts } from "./analytics";

type Sent = [string, Record<string, string>];

type Listener = (event: { target: FakeElement; button: number }) => void;

// Just enough of the DOM for the Databuddy loader: the selectors its click
// listener uses, the script tags it appends, and their load callbacks.
class FakeElement {
  parent: FakeElement | null = null;
  readonly children: FakeElement[];
  isConnected = true;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  async = false;

  constructor(
    readonly tag: string,
    readonly attributes: Record<string, string> = {},
    children: FakeElement[] = [],
    readonly text = "",
  ) {
    this.children = children;

    for (const child of children) child.parent = this;
  }

  get dataset() {
    return { language: this.attributes["data-language"] };
  }

  get classList() {
    return { contains: (name: string) => (this.attributes.class ?? "").split(" ").includes(name) };
  }

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  matches(selector: string): boolean {
    return selector.split(",").some((part) => this.matchesOne(part.trim()));
  }

  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this;

    return this.parent?.closest(selector) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    if (selector.startsWith(":scope > ")) {
      const direct = selector.slice(":scope > ".length);

      return this.children.find((child) => child.matches(direct)) ?? null;
    }

    for (const child of this.children) {
      if (child.matches(selector)) return child;

      const found = child.querySelector(selector);

      if (found) return found;
    }

    return null;
  }

  private matchesOne(selector: string): boolean {
    if (selector === "a[href]") return this.tag === "a" && "href" in this.attributes;

    const attribute = selector.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);

    if (!attribute) return this.tag === selector;

    const [, name = "", value] = attribute;

    return value === undefined ? name in this.attributes : this.attributes[name] === value;
  }
}

function load(path: string) {
  const listeners = new Map<string, Listener[]>();
  const appended: FakeElement[] = [];
  const sent: Sent[] = [];

  const document = {
    readyState: "loading",
    createElement: (tag: string) => new FakeElement(tag),
    head: { append: (tag: FakeElement) => appended.push(tag) },
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
  };

  const context = createContext({
    document,
    location: new URL(path, "https://social-sdk.dev"),
    Element: FakeElement,
    addEventListener: () => undefined,
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    URL,
  });

  runInContext("window = globalThis;", context);

  // Both head scripts, in production order. The page never fires load here, so
  // the product analytics snippet never starts its SDK.
  for (const content of headScripts) runInContext(content, context);

  const tracker = () => appended.find((tag) => tag.src === "/_p/s.js");

  return {
    sent,
    dispatch: (type: string, target: FakeElement, button = 0) => {
      for (const listener of listeners.get(type) ?? []) listener({ target, button });
    },
    // JSON, since values built in the vm context carry that context's prototypes.
    pendingJson: (): string =>
      runInContext("JSON.stringify(window.databuddyPending ?? [])", context),
    startTracker: () => {
      context.databuddy = {
        track: (event: string, properties: Record<string, string>) =>
          sent.push([event, { ...properties }]),
      };
      tracker()?.onload?.();
    },
    failTracker: () => tracker()?.onerror?.(),
    siteTrack: (event: string, properties: Record<string, string>) =>
      runInContext(
        `window.siteTrack(${JSON.stringify(event)}, ${JSON.stringify(properties)})`,
        context,
      ),
  };
}

const copyButton = () => new FakeElement("button", { "data-blume-copy": "" });

const link = (href: string) => new FakeElement("a", { href });

test("queues landing install copies and GitHub clicks, then sends them once the tracker loads", () => {
  const page = load("/");

  page.dispatch("click", new FakeElement("button", { "data-cta": "install_copy" }));
  page.dispatch("click", link("https://github.com/opencoredev/social-sdk"));

  const where = { surface: "landing", page: "/" };

  const expected: Sent[] = [
    ["install_command_copy", where],
    ["outbound_click", { destination: "github", ...where }],
  ];

  assert.equal(page.pendingJson(), JSON.stringify(expected));

  page.startTracker();

  assert.deepEqual(page.sent, expected);
  assert.equal(page.pendingJson(), "[]");
});

test("matches only the SDK's own npm package, on a click or a middle click", () => {
  const page = load("/about");

  page.startTracker();
  page.dispatch("click", link("https://www.npmjs.com/package/@opencoredev/social-sdk/v/0.6.0"));
  page.dispatch("click", link("https://www.npmjs.com/package/@opencoredev/social-sdk-other"));
  page.dispatch("auxclick", link("https://www.npmjs.com/package/@opencoredev/social-sdk"), 1);
  page.dispatch("auxclick", link("https://github.com/opencoredev/social-sdk"), 2);

  const npm: Sent = ["outbound_click", { destination: "npm", surface: "site", page: "/about" }];

  assert.deepEqual(page.sent, [npm, npm]);
});

test("reports the visible tab of a tabbed install block as an install copy", () => {
  const page = load("/docs/getting-started/installation/");
  const button = copyButton();

  const tab = (language: string, code: string, hidden: boolean) =>
    new FakeElement("div", hidden ? { class: "hidden" } : {}, [
      new FakeElement("pre", { "data-language": language }, [], code),
    ]);

  new FakeElement("blume-tabs", {}, [
    new FakeElement("div", { "data-blume-tab-actions": "" }, [button]),
    new FakeElement("div", { "data-blume-tab-content": "" }, [
      tab("TypeScript", 'import { createX } from "@opencoredev/social-sdk/x";', true),
      tab("Bash", "aube add @opencoredev/social-sdk", false),
    ]),
  ]);

  page.startTracker();
  page.dispatch("click", button);

  const where = { surface: "docs", page: "/docs/getting-started/installation/" };

  assert.deepEqual(page.sent, [
    ["docs_code_copy", { ...where, language: "Bash" }],
    ["install_command_copy", where],
  ]);
});

test("reports other code copies without the copied text", () => {
  const page = load("/docs/platforms/x");
  const button = copyButton();

  new FakeElement(
    "pre",
    { "data-language": "TypeScript" },
    [button],
    'import { createX } from "@opencoredev/social-sdk/x";',
  );

  page.startTracker();
  page.dispatch("click", button);

  assert.deepEqual(page.sent, [
    ["docs_code_copy", { surface: "docs", page: "/docs/platforms/x", language: "TypeScript" }],
  ]);
});

test("caps the queue shared with window.siteTrack", () => {
  const page = load("/");

  for (let click = 0; click < 60; click += 1) {
    page.dispatch("click", new FakeElement("button", { "data-cta": "install_copy" }));
    page.siteTrack("landing_cta_click", { cta: "install_copy" });
  }

  assert.equal(page.pendingJson().split("],[").length, 50);
});

test("drops queued events when the tracker fails to load", () => {
  const page = load("/");

  page.dispatch("click", new FakeElement("button", { "data-cta": "install_copy" }));
  page.failTracker();
  page.dispatch("click", new FakeElement("button", { "data-cta": "install_copy" }));
  page.siteTrack("landing_cta_click", { cta: "install_copy" });

  assert.equal(page.pendingJson(), "[]");
});
