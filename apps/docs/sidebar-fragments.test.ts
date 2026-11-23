import assert from "node:assert/strict";
import { test } from "node:test";

import { hasDeferredSidebar, inlineSidebarFragments } from "./sidebar-fragments";

// Markup in the shape Blume 2.0.3 renders: a closed group whose children are
// deferred to a fragment, and a fragment that holds another closed group.
const slot = (id: string) =>
  `<div class="space-y-0.5 border-border border-s ps-3" data-nav-src="/blume-nav/current/default/${id}"></div>`;

const group = (label: string, id: string) =>
  `<li><details><summary class="blume-nav-summary"><span>${label}</span></summary>${slot(id)}</details></li>`;

const link = (path: string) => `<li><a class="blume-nav-link" href="/docs${path}">${path}</a></li>`;

const fragments = new Map([
  ["/blume-nav/current/default/g1", `<ul>${link("/backends")}${link("/backends/zernio")}</ul>`],
  [
    "/blume-nav/current/default/g2",
    `<ul>${link("/integrations")}${group("Frameworks", "g3")}${group("Job runners", "g5")}</ul>`,
  ],
  [
    "/blume-nav/current/default/g3",
    `<ul>${link("/integrations/nextjs")}${link("/integrations/hono")}</ul>`,
  ],
  ["/blume-nav/current/default/g5", `<ul>${link("/integrations/inngest")}</ul>`],
]);

const read = (src: string) => fragments.get(src);

const page = `<nav><ul>${link("/getting-started/installation")}${group("Managed backends", "g1")}${group("Integrations", "g2")}</ul></nav>`;

test("inlines each deferred group's links into the page", () => {
  const { html, inlined } = inlineSidebarFragments(page, read);

  for (const path of ["/backends", "/backends/zernio", "/integrations", "/integrations/nextjs"])
    assert.ok(html.includes(`href="/docs${path}"`), path);

  assert.equal(inlined, 4);
});

test("inlines nested collapsed groups recursively", () => {
  const { html } = inlineSidebarFragments(page, read);

  assert.ok(html.includes('href="/docs/integrations/hono"'));
  assert.ok(html.includes('href="/docs/integrations/inngest"'));
  assert.equal(hasDeferredSidebar(html), false);
});

test("keeps every group closed and its slot's other attributes", () => {
  const { html } = inlineSidebarFragments(page, read);

  assert.equal((html.match(/<details>/g) ?? []).length, 4);
  assert.ok(!html.includes("<details open"));
  assert.equal(
    (html.match(/<div class="space-y-0\.5 border-border border-s ps-3">/g) ?? []).length,
    4,
  );
});

test("puts each fragment inside its own group, once", () => {
  const { html } = inlineSidebarFragments(page, read);

  assert.equal(html.split('href="/docs/integrations/nextjs"').length - 1, 1);
  assert.ok(
    html.includes(
      `<span>Frameworks</span></summary><div class="space-y-0.5 border-border border-s ps-3">${fragments.get("/blume-nav/current/default/g3")}</div></details>`,
    ),
  );
});

test("is idempotent", () => {
  const once = inlineSidebarFragments(page, read).html;

  const twice = inlineSidebarFragments(once, read);

  assert.equal(twice.html, once);
  assert.equal(twice.inlined, 0);
});

test("leaves a page without deferred groups unchanged", () => {
  const html = `<nav>${link("/reference")}</nav>`;

  assert.deepEqual(inlineSidebarFragments(html, read), { html, inlined: 0 });
});

test("fails on a missing fragment instead of dropping the links", () => {
  assert.throws(
    () => inlineSidebarFragments(group("Concepts", "g9"), read),
    /fragment \/blume-nav\/current\/default\/g9 is missing/,
  );
});

test("fails when a slot already has content", () => {
  const filled = `<details><div data-nav-src="/blume-nav/current/default/g1"><ul></ul></div></details>`;

  assert.throws(() => inlineSidebarFragments(filled, read), /isn't empty/);
});

test("fails on a fragment that includes itself", () => {
  const loop = new Map([["/blume-nav/current/default/g1", group("Again", "g1")]]);

  assert.throws(
    () => inlineSidebarFragments(group("Loop", "g1"), (src) => loop.get(src)),
    /includes itself/,
  );
});

test("leaves data-nav-src inside an HTML comment alone", () => {
  const commented = `<!-- ${slot("g9")} --><nav>${group("Managed backends", "g1")}</nav>`;

  const { html, inlined } = inlineSidebarFragments(commented, read);

  assert.equal(inlined, 1);
  assert.ok(html.startsWith(`<!-- ${slot("g9")} -->`));
  assert.equal(hasDeferredSidebar(html), false);
  assert.equal(hasDeferredSidebar(`<!-- ${slot("g9")} -->`), false);
});

test("inlines a single-quoted data-nav-src", () => {
  const single = `<details><div class="rows" data-nav-src='/blume-nav/current/default/g1'></div></details>`;

  assert.equal(hasDeferredSidebar(single), true);

  const { html, inlined } = inlineSidebarFragments(single, read);

  assert.equal(inlined, 1);
  assert.equal(
    html,
    `<details><div class="rows">${fragments.get("/blume-nav/current/default/g1")}</div></details>`,
  );
});
