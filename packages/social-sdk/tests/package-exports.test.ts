import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isJsonObject, isString } from "../src/transport/validation.js";
import { parseJson } from "../src/transport/json.js";

it("every conditional export has types, import, and a trailing default", async () => {
  const manifest = parseJson(await readFile(new URL("../package.json", import.meta.url), "utf8"));

  assert.ok(isJsonObject(manifest));
  const exportMap = manifest["exports"];

  assert.ok(isJsonObject(exportMap));
  const problems: string[] = [];

  for (const [subpath, target] of Object.entries(exportMap)) {
    if (isString(target)) continue;

    if (!isJsonObject(target)) {
      problems.push(`${subpath}: not a condition object`);
      continue;
    }

    const conditions = Object.keys(target);

    // Node.js matches conditions in order, so `default` must come last.
    if (conditions.join(",") !== "types,import,default")
      problems.push(`${subpath}: conditions ${conditions.join(",")}`);

    if (target["default"] !== target["import"])
      problems.push(`${subpath}: default does not match import`);
  }

  assert.deepEqual(problems, []);
});
