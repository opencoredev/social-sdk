---
"@opencoredev/social-sdk": minor
---

Add `@opencoredev/social-sdk/ai` and `@opencoredev/social-sdk/mcp`.

`createSocialToolkit` builds JSON Schema agent tools from a configured client. Tools appear only
when a backend declares their operation available. They cover capability discovery, diagnostics,
local validation and publish planning, accounts, posts, delivery reconciliation, analytics,
comments, messages and notifications. List tools cap an agent's `limit` at `maxPageSize` (default 50) and ask for 20 when it omits one, a size every built-in list operation accepts. Write tools return a dry-run preview until called with
`confirmWrite: true` (or `writes: "allow"`), and executing a publish requires an idempotency key.
Every call threads the caller's `AuthorizationContext` through the client's policy and limits;
native actions run through `defineNativeTool`, which requires the policy and adds a per-backend
concurrency limit. Adapters cover the Vercel AI SDK (`toAISDKTools`, Standard Schema inputs) and
OpenAI function calling (`toOpenAIChatTools`, `toOpenAIResponsesTools`, `runOpenAIToolCall`).

`createMcpServer` serves a toolkit over MCP 2025-06-18 (also 2025-03-26 and 2024-11-05) through
`serveMcpStdio` or `createMcpHttpHandler`, a stateless Streamable HTTP handler for Web `Request`
runtimes that requires an `authorize` callback and rejects untrusted origins. Each element of a
stdio JSON-RPC batch counts against `maxInFlight` and `maxQueued`.

The CLI adds `social-sdk mcp [--adapter NAME]`, an offline stdio server with capability, doctor,
validation and planning tools only.
