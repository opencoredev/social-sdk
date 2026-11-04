import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliUsageEvent, runCli } from "../src/cli.js";
import {
  createCliTelemetry,
  environmentOptOut,
  parseTelemetryState,
  TELEMETRY_NOTICE,
  telemetryConfigDirectory,
  telemetryFields,
  type CliTelemetryOptions,
} from "../src/telemetry.js";
import { parseJson } from "../src/transport/json.js";
import { object, string } from "../src/transport/validation.js";

const runtime = { name: "node", version: "24.1.0", platform: "linux", arch: "x64" } as const;

interface Harness {
  readonly directory: string;
  readonly bodies: string[];
  readonly notices: string[];
  readonly options: (overrides?: Partial<CliTelemetryOptions>) => CliTelemetryOptions;
  readonly cleanup: () => Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "social-sdk-telemetry-"));
  const directory = join(root, "config", "social-sdk");
  const bodies: string[] = [];
  const notices: string[] = [];

  const fetch: typeof globalThis.fetch = async (_input, init) => {
    bodies.push(await new Response(init?.body).text());

    return new Response("{}", { status: 200 });
  };

  return {
    directory,
    bodies,
    notices,
    options: (overrides = {}) => ({
      env: {},
      configDirectory: directory,
      fetch,
      writeNotice: (text) => notices.push(text),
      sdkVersion: "0.5.0",
      runtime,
      now: () => new Date("2026-11-04T12:00:00.000Z"),
      ...overrides,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

it("telemetry respects DO_NOT_TRACK, the SDK opt-out variable and CI, but not explicit off values", () => {
  assert.equal(environmentOptOut({}), undefined);
  assert.equal(environmentOptOut({ DO_NOT_TRACK: "1" }), "do-not-track");
  assert.equal(environmentOptOut({ DO_NOT_TRACK: "true", CI: "true" }), "do-not-track");
  assert.equal(environmentOptOut({ SOCIAL_SDK_TELEMETRY_DISABLED: "1" }), "environment");
  assert.equal(environmentOptOut({ CI: "true" }), "ci");
  assert.equal(environmentOptOut({ GITHUB_ACTIONS: "true" }), "ci");
  assert.equal(environmentOptOut({ JENKINS_URL: "https://ci.example.test" }), "ci");

  for (const value of ["0", "false", "FALSE", "no", "off", "", "  "]) {
    assert.equal(environmentOptOut({ DO_NOT_TRACK: value }), undefined, value);
    assert.equal(environmentOptOut({ CI: value }), undefined, value);
  }
});

it("telemetry config lives in the platform config directory", () => {
  assert.equal(
    telemetryConfigDirectory({ env: {}, platform: "linux", home: "/home/dev" }),
    "/home/dev/.config/social-sdk",
  );
  assert.equal(
    telemetryConfigDirectory({ env: { XDG_CONFIG_HOME: "/xdg" }, platform: "linux", home: "/h" }),
    "/xdg/social-sdk",
  );
  // A relative XDG_CONFIG_HOME is invalid per the spec and is ignored.
  assert.equal(
    telemetryConfigDirectory({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", home: "/h" }),
    "/h/.config/social-sdk",
  );
  assert.equal(
    telemetryConfigDirectory({ env: { APPDATA: "/appdata" }, platform: "win32", home: "/h" }),
    join("/appdata", "social-sdk"),
  );
  assert.equal(
    telemetryConfigDirectory({ env: {}, platform: "linux", home: undefined }),
    undefined,
  );
});

it("telemetry state parsing rejects anything but a versioned UUID and boolean", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(
    parseTelemetryState(JSON.stringify({ version: 1, anonymousId: id, enabled: false })),
    {
      version: 1,
      anonymousId: id,
      enabled: false,
      noticeShown: false,
    },
  );

  for (const text of [
    "not json",
    "null",
    JSON.stringify({ version: 2, anonymousId: id, enabled: true }),
    JSON.stringify({ version: 1, anonymousId: "user@example.test", enabled: true }),
    JSON.stringify({ version: 1, anonymousId: id, enabled: "no" }),
    JSON.stringify({ version: 1, anonymousId: id, enabled: true, noticeShown: "yes" }),
  ])
    assert.equal(parseTelemetryState(text), undefined, text);
});

it("telemetry shows the notice once, stores one anonymous ID and sends only documented fields", async () => {
  const h = await harness();

  try {
    const telemetry = createCliTelemetry(h.options());
    await telemetry.record({ command: "doctor", adapter: "youtube" });
    await telemetry.record({ command: "mcp" });

    assert.deepEqual(h.notices, [TELEMETRY_NOTICE]);
    assert.equal(h.bodies.length, 2);

    const first = object(parseJson(h.bodies[0]!));
    const second = object(parseJson(h.bodies[1]!));
    const stored = parseTelemetryState(await readFile(join(h.directory, "telemetry.json"), "utf8"));
    assert.ok(stored);
    assert.equal(first["distinct_id"], stored.anonymousId);
    assert.equal(second["distinct_id"], stored.anonymousId);
    assert.equal(first["event"], "cli_command");
    assert.equal(first["timestamp"], "2026-11-04T12:00:00.000Z");
    assert.deepEqual(Object.keys(first).sort(), [
      "api_key",
      "distinct_id",
      "event",
      "properties",
      "timestamp",
    ]);

    const properties = object(first["properties"]);
    const allowed = new Set<string>(telemetryFields);
    const dataKeys = Object.keys(properties).filter((key) => !key.startsWith("$"));
    assert.deepEqual(
      dataKeys.filter((key) => !allowed.has(key)),
      [],
    );
    assert.deepEqual(properties, {
      command: "doctor",
      adapter: "youtube",
      sdk_version: "0.5.0",
      runtime: "node",
      runtime_version: "24.1.0",
      os: "linux",
      arch: "x64",
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "social-sdk-cli",
    });
    assert.equal(object(second["properties"])["adapter"], undefined);

    if (process.platform !== "win32") {
      const mode = (await stat(join(h.directory, "telemetry.json"))).mode & 0o777;
      assert.equal(mode, 0o600);
    }
  } finally {
    await h.cleanup();
  }
});

it("telemetry sends nothing and writes nothing when an environment opt-out is set", async () => {
  for (const env of [
    { DO_NOT_TRACK: "1" },
    { SOCIAL_SDK_TELEMETRY_DISABLED: "1" },
    { CI: "true" },
  ]) {
    const h = await harness();

    try {
      const telemetry = createCliTelemetry(h.options({ env }));
      await telemetry.record({ command: "doctor" });
      assert.equal(h.bodies.length, 0);
      assert.equal(h.notices.length, 0);
      assert.equal(await exists(h.directory), false);
      assert.equal((await telemetry.status()).kind, "disabled");
    } finally {
      await h.cleanup();
    }
  }
});

it("telemetry disable persists, keeps the ID, and stops every later event", async () => {
  const h = await harness();

  try {
    const telemetry = createCliTelemetry(h.options());
    await telemetry.record({ command: "version" });
    const before = parseTelemetryState(await readFile(join(h.directory, "telemetry.json"), "utf8"));

    assert.deepEqual(await telemetry.setEnabled(false), { kind: "disabled", reason: "config" });
    await telemetry.record({ command: "doctor" });
    assert.equal(h.bodies.length, 1);

    const after = parseTelemetryState(await readFile(join(h.directory, "telemetry.json"), "utf8"));
    assert.equal(after?.anonymousId, before?.anonymousId);
    assert.equal(after?.enabled, false);

    assert.deepEqual(await telemetry.setEnabled(true), { kind: "enabled" });
    await telemetry.record({ command: "doctor" });
    assert.equal(h.bodies.length, 2);
    assert.equal(h.notices.length, 1);
  } finally {
    await h.cleanup();
  }
});

it("a first run racing an opt-out from another process never replaces the opt-out", async () => {
  const h = await harness();

  try {
    const file = join(h.directory, "telemetry.json");

    const disabled = JSON.stringify({
      version: 1,
      anonymousId: "123e4567-e89b-42d3-a456-426614174000",
      enabled: false,
    });

    mkdirSync(h.directory, { recursive: true });
    // The opt-out lands while the first run is reading, whichever side wins.
    const pending = createCliTelemetry(h.options()).record({ command: "doctor" });

    writeFileSync(file, disabled);
    await pending;

    assert.equal(await readFile(file, "utf8"), disabled);
    assert.equal(h.bodies.length, 0);
    assert.deepEqual(await createCliTelemetry(h.options()).status(), {
      kind: "disabled",
      reason: "config",
    });
  } finally {
    await h.cleanup();
  }
});

it("telemetry disabled before the first command never shows a notice or sends", async () => {
  const h = await harness();

  try {
    const telemetry = createCliTelemetry(h.options());
    await telemetry.setEnabled(false);
    await telemetry.record({ command: "doctor" });
    assert.equal(h.bodies.length, 0);
    assert.equal(h.notices.length, 0);
  } finally {
    await h.cleanup();
  }
});

it("turning telemetry on after an opt-out before the first command prints the notice once", async () => {
  const h = await harness();

  try {
    const telemetry = createCliTelemetry(h.options());

    await telemetry.setEnabled(false);
    await telemetry.setEnabled(true);
    assert.deepEqual(h.notices, [TELEMETRY_NOTICE]);

    await telemetry.record({ command: "version" });
    await telemetry.setEnabled(true);
    await telemetry.record({ command: "version" });
    assert.equal(h.notices.length, 1);
    assert.equal(h.bodies.length, 2);
  } finally {
    await h.cleanup();
  }
});

it("the notice is printed before any process can read a state that records it", async () => {
  const h = await harness();

  try {
    const file = join(h.directory, "telemetry.json");
    const seen: string[] = [];

    const writeNotice = () => {
      seen.push(existsSync(file) ? readFileSync(file, "utf8") : "no file");
    };

    await createCliTelemetry(h.options({ writeNotice })).record({ command: "doctor" });
    assert.deepEqual(seen, ["no file"]);

    const disabled = JSON.stringify({
      version: 1,
      anonymousId: "123e4567-e89b-42d3-a456-426614174000",
      enabled: false,
    });

    writeFileSync(file, disabled);
    await createCliTelemetry(h.options({ writeNotice })).setEnabled(true);
    assert.deepEqual(seen, ["no file", disabled]);
  } finally {
    await h.cleanup();
  }
});

it("an enabled state file without a shown notice sends nothing", async () => {
  const h = await harness();

  try {
    mkdirSync(h.directory, { recursive: true });
    writeFileSync(
      join(h.directory, "telemetry.json"),
      JSON.stringify({
        version: 1,
        anonymousId: "123e4567-e89b-42d3-a456-426614174000",
        enabled: true,
      }),
    );

    await createCliTelemetry(h.options()).record({ command: "doctor" });
    assert.equal(h.bodies.length, 0);
    assert.equal(h.notices.length, 0);
  } finally {
    await h.cleanup();
  }
});

it("telemetry treats an unreadable state file as off and leaves it untouched", async () => {
  const h = await harness();

  try {
    mkdirSync(h.directory, { recursive: true });
    const file = join(h.directory, "telemetry.json");
    await writeFile(file, '{"enabled": false, // hand edited');

    const telemetry = createCliTelemetry(h.options());
    await telemetry.record({ command: "doctor" });
    assert.equal(h.bodies.length, 0);
    assert.equal(await readFile(file, "utf8"), '{"enabled": false, // hand edited');
    assert.deepEqual(await telemetry.status(), { kind: "disabled", reason: "config" });
  } finally {
    await h.cleanup();
  }
});

it("telemetry sends nothing when the anonymous ID cannot be stored", async () => {
  const h = await harness();

  try {
    const blocker = join(h.directory, "..", "blocker");
    mkdirSync(h.directory, { recursive: true });
    await writeFile(blocker, "a file, not a directory");

    const telemetry = createCliTelemetry(
      h.options({ configDirectory: join(blocker, "social-sdk") }),
    );

    await telemetry.record({ command: "doctor" });
    assert.equal(h.bodies.length, 0);
    assert.equal(h.notices.length, 0);
    await assert.rejects(telemetry.setEnabled(false));

    const noHome = createCliTelemetry(h.options({ configDirectory: undefined }));
    await noHome.record({ command: "doctor" });
    assert.equal(h.bodies.length, 0);
    assert.equal(noHome.configFile, undefined);
  } finally {
    await h.cleanup();
  }
});

it("telemetry never rejects and gives up on a hanging endpoint after its timeout", async () => {
  const h = await harness();

  try {
    const failing = createCliTelemetry(
      h.options({
        fetch: async () => {
          throw new TypeError("network unreachable");
        },
      }),
    );

    await failing.record({ command: "doctor" });

    const hanging = createCliTelemetry(
      h.options({
        timeoutMs: 50,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            // A real socket keeps the process alive; this timer stands in for it.
            const socket = setTimeout(() => reject(new Error("no timeout fired")), 5000);

            init?.signal?.addEventListener("abort", () => {
              clearTimeout(socket);
              reject(new Error("aborted"));
            });
          }),
      }),
    );

    const started = Date.now();
    await hanging.record({ command: "doctor" });
    assert.ok(Date.now() - started < 2000);
  } finally {
    await h.cleanup();
  }
});

it("CLI usage events carry only a known command and a built-in adapter name", () => {
  assert.deepEqual(cliUsageEvent([]), { command: "help", adapter: undefined });
  assert.deepEqual(cliUsageEvent(["--version"]), { command: "version", adapter: undefined });
  assert.deepEqual(cliUsageEvent(["doctor", "--adapter", "x", "--json"]), {
    command: "doctor",
    adapter: "x",
  });
  assert.deepEqual(cliUsageEvent(["publish", "--adapter", "secret-value"]), {
    command: "unknown",
    adapter: undefined,
  });
  assert.deepEqual(cliUsageEvent(["validate", "--file", "/home/dev/private.json"]), {
    command: "validate",
    adapter: undefined,
  });
  assert.equal(cliUsageEvent(["telemetry", "disable"]), undefined);
});

async function runWith(args: string[], telemetry: CliTelemetryOptions | undefined) {
  let output = "";

  const code = await runCli(args, {
    env: {},
    readInput: async () => "{}",
    write: (text) => {
      output += text;
    },
    telemetry: telemetry ? createCliTelemetry(telemetry) : undefined,
  });

  return { code, output, data: object(object(parseJson(output))["data"]) };
}

it("CLI output and exit codes are identical with telemetry on, off, or failing", async () => {
  const h = await harness();

  try {
    const failingFetch: typeof globalThis.fetch = async () => {
      throw new TypeError("offline");
    };

    for (const args of [
      ["doctor", "--adapter", "zernio", "--json"],
      ["adapters", "--json"],
      ["publish"],
    ]) {
      const without = await runWith(args, undefined);
      const withTelemetry = await runWith(args, h.options());
      const failing = await runWith(args, h.options({ fetch: failingFetch }));

      assert.equal(withTelemetry.output, without.output);
      assert.equal(withTelemetry.code, without.code);
      assert.equal(failing.output, without.output);
      assert.equal(failing.code, without.code);
      assert.ok(!withTelemetry.output.includes("anonymous"), "the notice never goes to stdout");
    }

    assert.equal(h.notices.length, 1);
    assert.equal(h.bodies.length, 3);
  } finally {
    await h.cleanup();
  }
});

it("CLI telemetry command reports, disables and enables without sending an event", async () => {
  const h = await harness();

  try {
    const status = await runWith(["telemetry", "--json"], h.options());
    assert.equal(status.code, 0);
    assert.equal(status.data["enabled"], true);
    assert.equal(string(status.data["configFile"]), join(h.directory, "telemetry.json"));

    const disabled = await runWith(["telemetry", "disable", "--json"], h.options());
    assert.equal(disabled.data["enabled"], false);
    assert.equal(disabled.data["reason"], "config");

    const enabled = await runWith(["telemetry", "enable"], h.options());
    assert.equal(enabled.data["enabled"], true);

    const overridden = await runWith(
      ["telemetry", "enable", "--json"],
      h.options({ env: { DO_NOT_TRACK: "1" } }),
    );

    assert.equal(overridden.data["enabled"], false);
    assert.equal(overridden.data["reason"], "do-not-track");

    assert.equal(h.bodies.length, 0);
    // `telemetry enable` after an opt-out before any command prints the notice once.
    assert.deepEqual(h.notices, [TELEMETRY_NOTICE]);

    assert.equal((await runWith(["telemetry", "maybe"], h.options())).code, 2);
    assert.equal((await runWith(["telemetry", "enable", "now"], h.options())).code, 2);
    assert.equal((await runWith(["telemetry", "status"], undefined)).code, 1);
  } finally {
    await h.cleanup();
  }
});

it(
  "the CLI process exits within the telemetry bound when the endpoint stalls",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "social-sdk-telemetry-exit-"));
    const sockets: Socket[] = [];
    // Accepts TCP and never answers TLS, the case where fetch leaves a
    // connection attempt alive for about ten seconds after its abort.

    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on("error", () => {});
    });

    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();

      assert.ok(address instanceof Object, "server must listen on a TCP port");
      const preload = join(root, "redirect.mjs");

      await writeFile(
        preload,
        `const original = globalThis.fetch;
globalThis.fetch = (url, init) => original(String(url).replace("https://y.social-sdk.dev", "https://127.0.0.1:${address.port}"), init);
`,
      );

      const env: Record<string, string> = {};

      for (const [name, value] of Object.entries(process.env))
        if (
          value !== undefined &&
          !/^(CI|CONTINUOUS_INTEGRATION|GITHUB_ACTIONS|GITLAB_CI|CIRCLECI|TRAVIS|BUILDKITE|TF_BUILD|JENKINS_URL|TEAMCITY_VERSION|CODEBUILD_BUILD_ID|BITBUCKET_BUILD_NUMBER|DO_NOT_TRACK|SOCIAL_SDK_TELEMETRY_DISABLED)$/.test(
            name,
          )
        )
          env[name] = value;

      env["XDG_CONFIG_HOME"] = join(root, "config");

      const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
      const started = Date.now();

      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--import", pathToFileURL(preload).href, cli, "version", "--json"],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      // A hung child is killed well inside the test timeout, so cleanup below
      // always runs and no process outlives the test.
      const code = await new Promise<number | null>((resolve) => {
        const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);

        child.on("close", (exitCode) => {
          clearTimeout(killer);
          resolve(exitCode);
        });
      });

      const elapsed = Date.now() - started;

      assert.equal(code, 0, stderr);
      assert.equal(object(parseJson(stdout))["command"], "version");
      assert.ok(stderr.includes(TELEMETRY_NOTICE), "first run prints the notice on stderr");
      assert.ok(sockets.length > 0, "the event was attempted against the stalled endpoint");
      // 1.5 s telemetry wait plus runtime and TypeScript loader startup.
      assert.ok(elapsed < 7000, `process took ${elapsed} ms to exit`);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
