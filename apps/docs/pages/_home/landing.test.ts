import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the landing code note shows renderOutcome as the typechecked recipe has it", async () => {
  const landing = await read("./landing.html");

  const recipe = await read(
    "../../../../skills/integrate-social-sdk/references/render-outcomes.ts",
  );

  const shown = landing.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  const start = recipe.indexOf("function renderOutcome");

  assert.ok(shown);
  assert.notEqual(start, -1);

  const text = shown
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

  assert.ok(text.endsWith(recipe.slice(start).trimEnd()));
});
