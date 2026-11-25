---
"@opencoredev/social-sdk": minor
---

The `social-sdk` CLI, including `social-sdk mcp`, now sends one anonymous usage event per command while telemetry is enabled, so the maintainers can count daily and weekly CLI users. The event holds the command name, the built-in adapter name, the SDK version, the runtime and its version, and the OS and CPU architecture, keyed by a random ID stored in your config directory. It never holds arguments, file contents, environment values, credentials, account IDs or publish content. The first run prints a notice to stderr; stdout, `--json` output, exit codes and the MCP protocol stream are unchanged.

Turn it off with `social-sdk telemetry disable`, `SOCIAL_SDK_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`. It is also off when a recognized CI variable such as `CI` or `GITHUB_ACTIONS` is set to a non-empty value other than `0`, `false`, `no` or `off`; on a runner that sets none of them, set `SOCIAL_SDK_TELEMETRY_DISABLED=1`. `social-sdk telemetry status` shows the current setting. Sending is best-effort: a failed or slow send is dropped without changing the command. The `telemetry` command itself sends nothing. The SDK library, including `/server` and `/mcp`, sends no telemetry.
