// examples/try-social-sdk installs the published package by exact version, outside the
// workspace. This keeps that pin equal to packages/social-sdk's version: `--write` updates it
// (run by `version-packages`), and the default mode fails when they differ (run by the
// release gate).
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseJson } from "../packages/social-sdk/src/transport/json.js";
import { object, string } from "../packages/social-sdk/src/transport/validation.js";

const root = resolve(import.meta.dir, "..");

const packageName = "@opencoredev/social-sdk";

const examplePath = resolve(root, "examples/try-social-sdk/package.json");

const sdk = object(
  parseJson(await readFile(resolve(root, "packages/social-sdk/package.json"), "utf8")),
);

const example = object(parseJson(await readFile(examplePath, "utf8")));

const version = string(sdk["version"]);

const dependencies = object(example["dependencies"]);

const pinned = string(dependencies[packageName]);

if (pinned === version) {
  console.log(`examples/try-social-sdk pins ${packageName}@${version}`);
} else if (process.argv.includes("--write")) {
  const updated = { ...example, dependencies: { ...dependencies, [packageName]: version } };

  await writeFile(examplePath, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`examples/try-social-sdk now pins ${packageName}@${version} (was ${pinned})`);
} else {
  console.error(
    `examples/try-social-sdk pins ${packageName}@${pinned}, but the package is ${version}. Run bun scripts/check-example-version.ts --write.`,
  );
  process.exit(1);
}
