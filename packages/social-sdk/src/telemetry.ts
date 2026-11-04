// Anonymous usage counts for the `social-sdk` CLI. Only `cli.ts` imports this
// module; the SDK library never sends telemetry.
//
// One event per CLI command, keyed by a random ID stored in the user's config
// directory. A one-time notice goes to stderr before the first event. Turned off
// by `social-sdk telemetry disable`, SOCIAL_SDK_TELEMETRY_DISABLED, DO_NOT_TRACK
// or any CI environment. The full field list is documented at TELEMETRY_DOCS_URL.

import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { definedFields } from "./core/fields.js";
import { parseJson } from "./transport/json.js";
import { isBoolean, isJsonObject, isString } from "./transport/validation.js";

export const TELEMETRY_DOCS_URL = "https://social-sdk.dev/docs/reference/telemetry";

// The project's own analytics proxy and its public ingestion key, shared with
// the docs site. The key can only write events; it cannot read anything back.
const TELEMETRY_ENDPOINT = "https://y.social-sdk.dev/i/v0/e/";

const TELEMETRY_PROJECT_KEY = "phc_CdT9A2MqdyY8WhzQkNZRRengT93aQenEbQxeERaog5Bw";

const DEFAULT_TIMEOUT_MS = 1500;

export const TELEMETRY_NOTICE = [
  "Social SDK collects anonymous CLI usage data (command, adapter, SDK version, runtime and OS)",
  "to count active users. It never collects arguments, file contents, credentials or account data.",
  "Turn it off with `social-sdk telemetry disable` or SOCIAL_SDK_TELEMETRY_DISABLED=1.",
  `Details: ${TELEMETRY_DOCS_URL}`,
  "",
].join("\n");

/** Field names a usage event can contain, in the order the docs list them. */
export const telemetryFields = [
  "command",
  "adapter",
  "sdk_version",
  "runtime",
  "runtime_version",
  "os",
  "arch",
] as const;

export const cliCommandNames = [
  "help",
  "version",
  "adapters",
  "capabilities",
  "doctor",
  "examples",
  "validate",
  "mcp",
  "unknown",
] as const;

export type CliCommandName = (typeof cliCommandNames)[number];

export function isCliCommandName(value: string): value is CliCommandName {
  return cliCommandNames.some((name) => name === value);
}

export type TelemetryEnv = Readonly<Record<string, string | undefined>>;

export type TelemetryDisabledReason = "do-not-track" | "environment" | "ci" | "config";

export type TelemetryStatus =
  | { readonly kind: "enabled" }
  | { readonly kind: "disabled"; readonly reason: TelemetryDisabledReason };

export interface CliUsageEvent {
  readonly command: CliCommandName;
  /** Only a name from the CLI's built-in adapter list. */
  readonly adapter?: string | undefined;
}

export interface RuntimeInfo {
  readonly name: "node" | "bun" | "deno";
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
}

/** What the `telemetry` command and the CLI entry point need. */
export interface CliTelemetry {
  /** Where the setting and anonymous ID live, or undefined when no config directory exists. */
  readonly configFile: string | undefined;
  status(): Promise<TelemetryStatus>;
  /** Saves the setting. Rejects when the config file cannot be written. */
  setEnabled(enabled: boolean): Promise<TelemetryStatus>;
  /** Sends one usage event when telemetry is on. Never rejects. */
  record(event: CliUsageEvent): Promise<void>;
}

interface TelemetryState {
  readonly version: 1;
  readonly anonymousId: string;
  readonly enabled: boolean;
  /** The notice has been printed on this machine; no event is sent before it is. */
  readonly noticeShown: boolean;
}

type StoredState =
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "found"; readonly state: TelemetryState };

const ciVariables = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
  "BITBUCKET_BUILD_NUMBER",
] as const;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Set and not an explicit "off" value, so `DO_NOT_TRACK=0` and `CI=false` stay off. */
export function isTruthyEnvValue(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();

  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

/** Environment settings that turn telemetry off, whatever the config file says. */
export function environmentOptOut(env: TelemetryEnv): TelemetryDisabledReason | undefined {
  if (isTruthyEnvValue(env["DO_NOT_TRACK"])) return "do-not-track";

  if (isTruthyEnvValue(env["SOCIAL_SDK_TELEMETRY_DISABLED"])) return "environment";

  if (ciVariables.some((name) => isTruthyEnvValue(env[name]))) return "ci";

  return undefined;
}

/** `$XDG_CONFIG_HOME/social-sdk`, `%APPDATA%\social-sdk` on Windows, else `~/.config/social-sdk`. */
export function telemetryConfigDirectory(input: {
  readonly env: TelemetryEnv;
  readonly platform: string;
  readonly home: string | undefined;
}): string | undefined {
  const xdg = input.env["XDG_CONFIG_HOME"]?.trim();

  if (xdg && isAbsolute(xdg)) return join(xdg, "social-sdk");

  const appData = input.env["APPDATA"]?.trim();

  if (input.platform === "win32" && appData) return join(appData, "social-sdk");

  return input.home ? join(input.home, ".config", "social-sdk") : undefined;
}

export function parseTelemetryState(text: string): TelemetryState | undefined {
  let value;

  try {
    value = parseJson(text);
  } catch {
    return undefined;
  }

  if (!isJsonObject(value) || value["version"] !== 1) return undefined;
  const anonymousId = value["anonymousId"];
  const enabled = value["enabled"];

  const noticeShown = value["noticeShown"] ?? false;

  if (
    !isString(anonymousId) ||
    !uuidPattern.test(anonymousId) ||
    !isBoolean(enabled) ||
    !isBoolean(noticeShown)
  )
    return undefined;

  return { version: 1, anonymousId, enabled, noticeShown };
}

/** The exact JSON body sent for one event. Every property is listed in `telemetryFields`. */
export function usagePayload(input: {
  readonly anonymousId: string;
  readonly event: CliUsageEvent;
  readonly sdkVersion: string | undefined;
  readonly runtime: RuntimeInfo;
  readonly timestamp: string;
}) {
  return {
    api_key: TELEMETRY_PROJECT_KEY,
    event: "cli_command",
    distinct_id: input.anonymousId,
    timestamp: input.timestamp,
    properties: {
      command: input.event.command,
      ...definedFields({ adapter: input.event.adapter, sdk_version: input.sdkVersion }),
      runtime: input.runtime.name,
      runtime_version: input.runtime.version,
      os: input.runtime.platform,
      arch: input.runtime.arch,
      // Ingestion settings, not data: no person profile and no IP geolocation.
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "social-sdk-cli",
    },
  };
}

async function readStoredState(file: string): Promise<StoredState> {
  let text;

  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    return missing ? { kind: "missing" } : { kind: "unreadable" };
  }

  const state = parseTelemetryState(text);

  return state ? { kind: "found", state } : { kind: "unreadable" };
}

/**
 * Writes the state file atomically. `create` fails when the file already exists,
 * so a first run racing `telemetry disable` in another process can never replace
 * the saved opt-out; `replace` is for an explicit enable or disable.
 */
async function writeState(input: {
  readonly directory: string;
  readonly file: string;
  readonly state: TelemetryState;
  readonly mode: "create" | "replace";
}): Promise<void> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const temporary = `${input.file}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporary, JSON.stringify(input.state, null, 2) + "\n", { mode: 0o600 });

    if (input.mode === "create") await link(temporary, input.file);
    else await rename(temporary, input.file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export interface CliTelemetryOptions {
  readonly env: TelemetryEnv;
  readonly configDirectory: string | undefined;
  readonly fetch: typeof globalThis.fetch;
  readonly writeNotice: (text: string) => void;
  readonly sdkVersion: string | undefined;
  readonly runtime: RuntimeInfo;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

export function createCliTelemetry(options: CliTelemetryOptions): CliTelemetry {
  const directory = options.configDirectory;
  const file = directory === undefined ? undefined : join(directory, "telemetry.json");
  const now = options.now ?? (() => new Date());

  async function status(): Promise<TelemetryStatus> {
    const optOut = environmentOptOut(options.env);

    if (optOut) return { kind: "disabled", reason: optOut };

    if (file === undefined) return { kind: "disabled", reason: "config" };
    const stored = await readStoredState(file);

    // An unreadable file may be a hand-edited opt-out, so it counts as off.
    if (stored.kind === "unreadable") return { kind: "disabled", reason: "config" };

    if (stored.kind === "found" && !stored.state.enabled)
      return { kind: "disabled", reason: "config" };

    return { kind: "enabled" };
  }

  return {
    configFile: file,
    status,

    async setEnabled(enabled) {
      if (directory === undefined || file === undefined)
        throw new Error("No config directory is available for the telemetry setting.");
      const stored = await readStoredState(file);
      const previous = stored.kind === "found" ? stored.state : undefined;
      // Turning telemetry on is where someone who opted out before their first
      // command learns what is sent, so the notice is printed here if it never was.
      const showNotice = enabled && !previous?.noticeShown;

      await writeState({
        directory,
        file,
        state: {
          version: 1,
          anonymousId: previous?.anonymousId ?? randomUUID(),
          enabled,
          noticeShown: (previous?.noticeShown ?? false) || showNotice,
        },
        mode: "replace",
      });

      if (showNotice) options.writeNotice(TELEMETRY_NOTICE);

      return status();
    },

    async record(event) {
      try {
        if (environmentOptOut(options.env) || directory === undefined || file === undefined) return;
        const stored = await readStoredState(file);

        if (stored.kind === "unreadable") return;
        let state: TelemetryState;

        if (stored.kind === "found") {
          // A file that says enabled without a shown notice was edited by hand;
          // send nothing until `telemetry enable` prints the notice.
          if (!stored.state.enabled || !stored.state.noticeShown) return;
          state = stored.state;
        } else {
          // First run: without a stored ID every run would count as a new user, so
          // nothing is sent unless the state file can be created. If another
          // process created it first, this run sends nothing.
          state = { version: 1, anonymousId: randomUUID(), enabled: true, noticeShown: true };
          await writeState({ directory, file, state, mode: "create" });
          options.writeNotice(TELEMETRY_NOTICE);
        }

        const response = await options.fetch(TELEMETRY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            usagePayload({
              anonymousId: state.anonymousId,
              event,
              sdkVersion: options.sdkVersion,
              runtime: options.runtime,
              timestamp: now().toISOString(),
            }),
          ),
          signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });

        await response.body?.cancel();
      } catch {
        // Telemetry never changes a command's output or exit code.
      }
    },
  };
}
