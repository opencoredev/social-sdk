// Counts native provider features that the SDK or its docs do not cover yet.
// The inventory lives in planning/feature-coverage/<provider>.json and is
// sourced from each provider's official API documentation (SOC-37).
//
// A feature open to third-party apps needs three things: its wire field or
// route in the adapter source, a contract test that mentions it, and a
// mention on the provider's docs page. A partner-only or deprecated feature
// needs only the docs mention, which should say why it is unavailable.
// Ads-scope rows are tracked but not scored. Each missing piece is one gap.
//
// Usage: bun scripts/check-feature-coverage.ts [--list] [--provider <id>]

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../packages/social-sdk/src/core/types.js";
import { isJsonValue } from "../packages/social-sdk/src/transport/json.js";
import {
  isJsonArray,
  isJsonObject,
  isString,
  type JsonField,
} from "../packages/social-sdk/src/transport/validation.js";

const root = fileURLToPath(new URL("../", import.meta.url));

const inventoryDir = join(root, "planning/feature-coverage");

const sdkDir = join(root, "packages/social-sdk");

const docsDir = join(root, "apps/docs/docs");

const providerSources = new Map<string, readonly string[]>([
  [
    "x",
    [
      "src/platforms/x.ts",
      "src/platforms/x-stream.ts",
      "src/platforms/x-engagement.ts",
      "src/platforms/x-text.ts",
    ],
  ],
  ["bluesky", ["src/platforms/bluesky.ts", "src/server/bluesky-oauth.ts"]],
  ["facebook", ["src/platforms/facebook.ts"]],
  ["instagram", ["src/platforms/instagram.ts"]],
  ["threads", ["src/platforms/threads.ts"]],
  ["linkedin", ["src/platforms/linkedin.ts"]],
  ["tiktok", ["src/platforms/tiktok.ts", "src/platforms/tiktok-upload.ts"]],
  ["youtube", ["src/platforms/youtube.ts", "src/platforms/youtube-upload.ts"]],
  [
    "zernio",
    [
      "src/cloud/zernio.ts",
      "src/cloud/zernio-native.ts",
      "src/cloud/common.ts",
      "src/cloud/lifecycle.ts",
    ],
  ],
  ["post-for-me", ["src/cloud/post-for-me.ts", "src/cloud/common.ts", "src/cloud/lifecycle.ts"]],
  ["postfast", ["src/cloud/postfast.ts", "src/cloud/common.ts", "src/cloud/lifecycle.ts"]],
  ["postiz", ["src/cloud/postiz.ts", "src/cloud/common.ts", "src/cloud/lifecycle.ts"]],
  ["buffer", ["src/cloud/buffer.ts", "src/cloud/common.ts", "src/cloud/lifecycle.ts"]],
]);

// Webhook decoding and OAuth live in shared server modules.
const sharedSources = [
  "src/server/webhooks.ts",
  "src/server/oauth.ts",
  "src/server/oauth-internal.ts",
];

// Tests of the shared OAuth and webhook modules count for every provider, as their source does.
const sharedTestModules = sharedSources.map((path) =>
  path.replace(/^src/, "").replace(/\.ts$/, ".js"),
);

// Modules several managed adapters share; importing one does not make a test provider-specific.
const sharedModules = new Set(["src/cloud/common.ts", "src/cloud/lifecycle.ts"]);

const managedProviders = new Set(["zernio", "post-for-me", "postfast", "postiz", "buffer"]);

const fullAccess = new Set(["public", "approval", "paid-tier", "beta"]);

const docsOnlyAccess = new Set(["partner-only", "deprecated"]);

interface Probe {
  readonly src: readonly RegExp[];
  readonly test: readonly RegExp[];
  readonly docs: readonly RegExp[];
  readonly forbid: readonly RegExp[];
  /** Text that must be gone from the provider's source, its tests and its docs. */
  readonly absent: readonly RegExp[];
}

interface Feature {
  readonly id: string;
  readonly provider: string;
  readonly access: string;
  readonly scope: string;
  readonly probe: Probe;
}

interface Gap {
  readonly id: string;
  readonly part: "src" | "test" | "docs" | "forbid";
  readonly pattern: string;
}

function patterns(value: JsonField, where: string): RegExp[] {
  if (value === undefined) return [];

  if (!isJsonArray(value)) throw new Error(`${where} must be an array of patterns`);

  const out: RegExp[] = [];

  for (const item of value) {
    if (!isString(item) || item.length === 0)
      throw new Error(`${where} has an empty or non-string pattern`);

    out.push(new RegExp(item, "m"));
  }

  return out;
}

function stringField(row: JsonObject, key: string, where: string): string {
  const value = row[key];

  if (!isString(value) || value.length === 0) throw new Error(`${where}.${key} must be a string`);

  return value;
}

function decodeFeature(value: JsonField, where: string): Feature {
  if (!isJsonObject(value)) throw new Error(`${where} must be an object`);

  const id = stringField(value, "id", where);
  const provider = stringField(value, "provider", where);
  const access = stringField(value, "access", where);
  const scope = stringField(value, "scope", where);

  if (!providerSources.has(provider))
    throw new Error(`${where} (${id}) has unknown provider ${provider}`);

  if (!fullAccess.has(access) && !docsOnlyAccess.has(access))
    throw new Error(`${where} (${id}) has unknown access ${access}`);

  if (scope !== "core" && scope !== "ads")
    throw new Error(`${where} (${id}) has unknown scope ${scope}`);

  const rawProbe = value["probe"];

  if (!isJsonObject(rawProbe)) throw new Error(`${where} (${id}) needs a probe`);

  const probe: Probe = {
    src: patterns(rawProbe["src"], `${id}.probe.src`),
    test: patterns(rawProbe["test"], `${id}.probe.test`),
    docs: patterns(rawProbe["docs"], `${id}.probe.docs`),
    forbid: patterns(rawProbe["forbid"], `${id}.probe.forbid`),
    absent: patterns(rawProbe["absent"], `${id}.probe.absent`),
  };

  // A pattern that matches empty text passes against nothing, so it proves nothing.
  // Use `absent` for text that must be gone.
  for (const part of ["src", "test", "docs"] as const)
    for (const pattern of probe[part])
      if (pattern.test(""))
        throw new Error(`${id}.probe.${part} matches empty text: ${pattern.source}`);

  if (scope === "core" && probe.docs.length === 0) throw new Error(`${id} needs a docs probe`);

  // A row may rely on a tagged contract test alone when no wire token tells
  // the implemented and missing states apart.
  const tagged = probe.test.some((pattern) => pattern.source.startsWith("feature:"));

  if (
    scope === "core" &&
    fullAccess.has(access) &&
    (probe.test.length === 0 || (probe.src.length === 0 && !tagged))
  )
    throw new Error(`${id} needs src and test probes`);

  return { id, provider, access, scope, probe };
}

// Comments do not count as an implementation. URLs inside strings keep their "//".
// A small scanner, so "image/*" in a string or "//" in a regex literal is not a comment.
function stripComments(source: string): string {
  let out = "";
  let index = 0;
  let previous = "";

  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index++;

      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);

      index = end === -1 ? source.length : end + 2;

      continue;
    }

    const regexStart =
      char === "/" && (previous === "" || "(,=:[!&|?{};+-*%<>~^".includes(previous));

    if (char === '"' || char === "'" || char === "`" || regexStart) {
      const close = char;
      let inClass = false;

      out += char;
      index++;

      while (index < source.length) {
        const inner = source[index] ?? "";

        out += inner;
        index++;

        if (inner === "\\") {
          out += source[index] ?? "";
          index++;
        } else if (regexStart && inner === "[") inClass = true;
        else if (regexStart && inner === "]") inClass = false;
        else if (inner === close && !inClass) break;
        else if (regexStart && inner === "\n") break;
      }

      previous = close;

      continue;
    }

    out += char;

    if (char.trim() !== "") previous = char;

    index++;
  }

  return out;
}

async function readText(path: string): Promise<string> {
  return existsSync(path) ? readFile(path, "utf8") : "";
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries)
    if (entry.isFile() && entry.name.endsWith(suffix))
      files.push(join(entry.parentPath, entry.name));

  return files.toSorted();
}

async function providerDocs(provider: string): Promise<string> {
  const section = managedProviders.has(provider) ? "backends" : "platforms";
  const page = await readText(join(docsDir, section, `${provider}.mdx`));
  const nestedDir = join(docsDir, section, provider);
  let nested = "";

  if (existsSync(nestedDir))
    for (const file of await listFiles(nestedDir, ".mdx")) nested += `\n${await readText(file)}`;

  return page + nested;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const list = args.includes("--list");
  const onlyIndex = args.indexOf("--provider");
  const only = onlyIndex === -1 ? undefined : args[onlyIndex + 1];

  if (onlyIndex !== -1 && (only === undefined || !providerSources.has(only)))
    throw new Error(
      `--provider needs one of: ${[...providerSources.keys()].join(", ")} (got ${only ?? "nothing"})`,
    );

  const features: Feature[] = [];
  const seen = new Set<string>();

  for (const file of await listFiles(inventoryDir, ".json")) {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

    if (!isJsonValue(parsed) || !isJsonArray(parsed)) throw new Error(`${file} must hold an array`);

    for (const [index, row] of parsed.entries()) {
      const feature = decodeFeature(row, `${file}[${index}]`);

      if (seen.has(feature.id)) throw new Error(`duplicate feature id ${feature.id}`);

      seen.add(feature.id);
      features.push(feature);
    }
  }

  const shared = await Promise.all(
    sharedSources.map(async (path) => stripComments(await readText(join(sdkDir, path)))),
  );

  const testFiles = await listFiles(join(sdkDir, "tests"), ".ts");

  const testTexts = await Promise.all(
    testFiles.map(async (path) => ({ name: basename(path), text: await readText(path) })),
  );

  // Tagged probes (`feature:<id>`) may sit in any test file. Other test probes only count in
  // the provider's own test files: named after it, or importing one of its adapter modules.
  const allTests = testTexts.map(({ text }) => text).join("\n");

  const providerTests = new Map<string, string>();

  for (const [provider, paths] of providerSources) {
    const modules = paths
      .filter((path) => !sharedModules.has(path))
      .map((path) => path.replace(/^src/, "").replace(/\.ts$/, ".js"));

    providerTests.set(
      provider,
      testTexts
        .filter(
          ({ name, text }) =>
            name.startsWith(`${provider}-`) ||
            name === `${provider}.test.ts` ||
            modules.some((module) => text.includes(module)) ||
            sharedTestModules.some((module) => text.includes(module)),
        )
        .map(({ text }) => text)
        .join("\n"),
    );
  }

  const allDocs = (
    await Promise.all((await listFiles(docsDir, ".mdx")).map(async (path) => readText(path)))
  ).join("\n");

  const sourceCache = new Map<string, string>();

  const docsCache = new Map<string, string>();

  const gaps: Gap[] = [];
  const perProvider = new Map<string, number>();
  let scored = 0;

  for (const feature of features) {
    if (only !== undefined && feature.provider !== only) continue;

    if (feature.scope === "ads") continue;

    scored++;

    let source = sourceCache.get(feature.provider);

    if (source === undefined) {
      const own = await Promise.all(
        (providerSources.get(feature.provider) ?? []).map(async (path) =>
          stripComments(await readText(join(sdkDir, path))),
        ),
      );

      source = [...own, ...shared].join("\n");
      sourceCache.set(feature.provider, source);
    }

    let docs = docsCache.get(feature.provider);

    if (docs === undefined) {
      docs = await providerDocs(feature.provider);
      docsCache.set(feature.provider, docs);
    }

    const before = gaps.length;
    const checkCode = fullAccess.has(feature.access);

    if (checkCode) {
      for (const pattern of feature.probe.src)
        if (!pattern.test(source))
          gaps.push({ id: feature.id, part: "src", pattern: pattern.source });

      for (const pattern of feature.probe.test)
        if (
          !pattern.test(
            pattern.source.startsWith("feature:")
              ? allTests
              : (providerTests.get(feature.provider) ?? ""),
          )
        )
          gaps.push({ id: feature.id, part: "test", pattern: pattern.source });
    }

    for (const pattern of feature.probe.docs)
      if (!pattern.test(docs)) gaps.push({ id: feature.id, part: "docs", pattern: pattern.source });

    for (const pattern of feature.probe.absent)
      if (
        pattern.test(source) ||
        pattern.test(providerTests.get(feature.provider) ?? "") ||
        pattern.test(docs)
      )
        gaps.push({ id: feature.id, part: "absent", pattern: pattern.source });

    for (const pattern of feature.probe.forbid)
      if (pattern.test(allDocs))
        gaps.push({ id: feature.id, part: "forbid", pattern: pattern.source });

    perProvider.set(
      feature.provider,
      (perProvider.get(feature.provider) ?? 0) + gaps.length - before,
    );
  }

  if (list) for (const gap of gaps) console.log(`${gap.id}\t${gap.part}\t${gap.pattern}`);

  for (const [provider, count] of [...perProvider].toSorted(([a], [b]) => a.localeCompare(b)))
    console.log(`${provider}: ${count}`);

  console.log(`features=${scored}`);
  console.log(`gaps=${gaps.length}`);
}

await main();
