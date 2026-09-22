#!/usr/bin/env node
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- CLI JSON is parsed and validated at its input boundary. */
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createSocial } from "./core/client.js";
import type { PublishRequest, SocialAdapter } from "./core/index.js";
import { mockBackend } from "./testing/index.js";
import { zernio } from "./cloud/zernio.js";
import { postForMe } from "./cloud/post-for-me.js";
import { bluesky } from "./platforms/bluesky.js";
import { x } from "./platforms/x.js";
import { threads } from "./platforms/threads.js";
import { youtube } from "./platforms/youtube.js";
import { tiktok } from "./platforms/tiktok.js";
import { instagram } from "./platforms/instagram.js";
import { linkedin } from "./platforms/linkedin.js";

const names = [
  "mock",
  "zernio",
  "post-for-me",
  "bluesky",
  "x",
  "threads",
  "youtube",
  "tiktok",
  "instagram",
  "linkedin",
] as const;

type AdapterName = (typeof names)[number];

const environmentNames: Record<AdapterName, readonly string[]> = {
  mock: [],
  zernio: ["ZERNIO_API_KEY"],
  "post-for-me": ["POST_FOR_ME_API_KEY"],
  bluesky: ["BLUESKY_SERVICE", "BLUESKY_DID", "BLUESKY_ACCESS_JWT"],
  x: ["X_USER_ID", "X_ACCESS_TOKEN"],
  threads: ["THREADS_USER_ID", "THREADS_ACCESS_TOKEN"],
  youtube: ["YOUTUBE_CHANNEL_ID", "YOUTUBE_ACCESS_TOKEN"],
  tiktok: ["TIKTOK_OPEN_ID", "TIKTOK_ACCESS_TOKEN"],
  instagram: ["INSTAGRAM_ACCOUNT_ID", "INSTAGRAM_ACCESS_TOKEN"],
  linkedin: ["LINKEDIN_AUTHOR_URN", "LINKEDIN_ACCESS_TOKEN", "LINKEDIN_API_VERSION"],
};

const noNetwork: typeof globalThis.fetch = async () => {
  throw new Error("Offline diagnostics cannot make network requests.");
};

export function createDiagnosticAdapter(
  name: AdapterName,
  accountId = "diagnostic-account",
): SocialAdapter<unknown> {
  switch (name) {
    case "mock":
      return mockBackend();
    case "zernio":
      return zernio({ apiKey: "offline-placeholder", fetch: noNetwork });
    case "post-for-me":
      return postForMe({ apiKey: "offline-placeholder", fetch: noNetwork });
    case "bluesky":
      return bluesky({
        auth: { service: "https://bsky.social", did: accountId, accessJwt: "offline-placeholder" },
        fetch: noNetwork,
      });
    case "x":
      return x({
        auth: { userId: accountId, accessToken: "offline-placeholder" },
        fetch: noNetwork,
      });
    case "threads":
      return threads({
        auth: { userId: accountId, accessToken: "offline-placeholder" },
        fetch: noNetwork,
      });
    case "youtube":
      return youtube({
        auth: { channelId: accountId, accessToken: "offline-placeholder" },
        fetch: noNetwork,
      });
    case "tiktok":
      return tiktok({
        auth: { openId: accountId, accessToken: "offline-placeholder" },
        verifiedMediaOrigins: [],
        fetch: noNetwork,
      });
    case "instagram":
      return instagram({
        auth: { accountId, accessToken: "offline-placeholder" },
        fetch: noNetwork,
      });
    case "linkedin":
      return linkedin({
        auth: {
          author: accountId.startsWith("urn:li:")
            ? (accountId as `urn:li:person:${string}`)
            : "urn:li:person:diagnostic",
          accessToken: "offline-placeholder",
        },
        apiVersion: "202609",
        fetch: noNetwork,
      });
  }
}

export interface CliIO {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readInput: (path: string) => Promise<string>;
  readonly write: (text: string) => void;
}

/** All commands are offline and return 0 (valid), 1 (diagnostic failure), or 2 (usage/input error). */
export async function runCli(args: readonly string[], io: CliIO): Promise<number> {
  const command = args[0] ?? "help";
  const json = args.includes("--json");

  const finish = (code: number, data: unknown) => {
    const result = { schemaVersion: 1, command, ok: code === 0, data };
    io.write(json ? JSON.stringify(result) + "\n" : JSON.stringify(result, null, 2) + "\n");

    return code;
  };

  const options = new Map<string, string>();

  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;

    if (arg === "--json") continue;

    if (
      !["--adapter", "--file"].includes(arg) ||
      !args[index + 1] ||
      args[index + 1]!.startsWith("--") ||
      options.has(arg)
    )
      return finish(2, {
        error: "Unknown, duplicate or missing option. Use help for supported arguments.",
      });
    options.set(arg, args[++index]!);
  }

  if (command === "help" || command === "--help")
    return finish(0, {
      usage:
        "social-sdk <doctor|adapters|capabilities|validate|examples> [--adapter NAME] [--file PATH] [--json]",
      offline: true,
      exitCodes: { success: 0, diagnosticFailure: 1, invalidInput: 2 },
    });
  const selected = options.get("--adapter") ?? "mock";

  if (!names.includes(selected as AdapterName))
    return finish(2, { error: "Unknown adapter.", adapters: names });
  const name = selected as AdapterName;

  if (command === "adapters")
    return finish(0, {
      adapters: names,
      verification: "Local contract tests; no live checks are performed by this CLI.",
    });

  if (command === "doctor") {
    const missing = environmentNames[name].filter((key) => !io.env[key]?.trim());

    return finish(missing.length ? 1 : 0, {
      adapter: name,
      offline: true,
      missingEnvironmentVariables: missing,
      authenticated: false,
      nextStep: missing.length
        ? "Set the named variables on your server. No values are printed or sent."
        : "Configuration presence checked only. Confirm platform scopes, account access and app approval separately.",
    });
  }

  if (command === "capabilities")
    return finish(0, {
      manifest: createDiagnosticAdapter(name).capabilities,
      verification:
        "Declared implementation capabilities; account permissions and live behavior were not checked.",
    });

  if (command === "examples")
    return finish(0, {
      adapter: "mock",
      request: {
        targets: [
          {
            account: {
              kind: "connected-account",
              version: 1,
              backend: "default",
              platform: "bluesky",
              accountId: "demo",
            },
          },
        ],
        content: { text: "Hello from Social SDK" },
      },
      run: "social-sdk validate --adapter mock --file request.json --json",
    });

  if (command !== "validate")
    return finish(2, { error: "Unknown command. Use help for supported commands." });
  const file = options.get("--file");

  if (!file)
    return finish(2, { error: "validate requires --file PATH containing a JSON publish request." });

  try {
    const raw = await io.readInput(file);

    if (new TextEncoder().encode(raw).byteLength > 1024 * 1024)
      return finish(2, { error: "Input exceeds the 1 MiB diagnostic limit." });
    const request: unknown = JSON.parse(raw);

    if (
      !request ||
      typeof request !== "object" ||
      !Array.isArray((request as Record<string, unknown>)["targets"])
    )
      return finish(2, { error: "Expected a JSON publish request with a targets array." });
    const input = request as PublishRequest;
    // JSON diagnostics deliberately accept only portable URLs, never executable streams or Blob handles.
    const contents = [input.content, ...input.targets.map((target) => target.content)];

    if (
      contents.some((content) =>
        content?.media?.some((media) => media.source?.kind !== "https-url"),
      )
    )
      return finish(2, {
        error:
          "CLI media validation accepts HTTPS URL inputs only. Validate Blob/stream/media handles through the SDK.",
      });

    const social = createSocial({
      backend: createDiagnosticAdapter(name, input.targets[0]?.account?.accountId),
    });

    const prepared = social.posts.prepare(input);

    // Do not echo content, URLs or account identifiers from the request.
    return finish(prepared.ok ? 0 : 1, {
      adapter: name,
      localOnly: true,
      targetCount: input.targets.length,
      issues: prepared.issues.map(({ code, severity, targetIndex }) => ({
        code,
        severity,
        targetIndex,
      })),
    });
  } catch {
    return finish(2, {
      error:
        "Unable to read or validate the JSON publish request. Check its shape and file permissions.",
    });
  }
}

const invokedPath = process.argv[1];

let invokedRealPath = invokedPath;

if (invokedPath) {
  try {
    invokedRealPath = realpathSync(invokedPath);
  } catch {
    // Keep the original path when it cannot be resolved.
  }
}

if (invokedRealPath && import.meta.url === pathToFileURL(invokedRealPath).href) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    async readInput(path) {
      const info = await stat(path);

      if (!info.isFile() || info.size > 1024 * 1024)
        throw new Error("Expected a JSON file up to 1 MiB.");

      return readFile(path, "utf8");
    },
    write: (text) => process.stdout.write(text),
  });
}
