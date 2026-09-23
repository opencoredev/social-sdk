# Social SDK example

The example uses a simulated backend and a local demo user by default. Its Request/Response handler selects accounts through server-side membership checks, prepares text or URL video, preserves per-target outcomes, and stores publication results, idempotency claims, and the event inbox in Postgres.

From the repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/social-sdk build
bun run --cwd apps/example dev
```

The server binds to the loopback interface on port 3030. `PORT` changes the port. With no configuration it keeps its data in a local embedded Postgres, so it needs no database setup.

The default `EXAMPLE_SCENARIO` is `mixed-success-failure`. Selecting both mock accounts produces one published result and one failed result. Set `EXAMPLE_SCENARIO=media-processing-then-success` to exercise processing. Tests explicitly advance the mock controller before reconciliation; the adapter never starts hidden polling.

## Storage

Publication results, idempotency claims, encrypted credentials, and the event inbox live in Postgres. The example reaches it through Drizzle ORM. `src/db/schema.ts` holds the typed schema, and `src/db/client.ts` picks the driver:

- When `DATABASE_URL` is set, the example connects to Neon with the `@neondatabase/serverless` WebSocket pool. This driver supports the interactive transactions that the event worker and idempotency store use.
- Otherwise it runs PGlite, Postgres compiled to WebAssembly, with its data in `apps/example/.data/pglite`. `EXAMPLE_DB` points it at another directory. Delete the directory to reset the local demo and its idempotency history. Git ignores it.

```sh
DATABASE_URL="postgresql://user:password@ep-example.us-east-2.aws.neon.tech/neondb?sslmode=require" \
  bun run --cwd apps/example dev
```

The server applies pending migrations from `apps/example/drizzle` before it accepts requests. Tests use an in-memory PGlite database. The SDK itself has no database dependency; Postgres is only the example's storage.

After you change the schema, generate a migration and commit it with the schema change:

```sh
bun run --cwd apps/example db:generate
bun run --cwd apps/example db:migrate
```

`db:migrate` uses the same driver selection as the server. It migrates Neon when `DATABASE_URL` is set and the local PGlite directory otherwise.

## Request flow

Fetch `GET /api/accounts` and select the returned account IDs. The default server session can use only `mock-account-1` and `mock-account-2`. The existing-account picker at `/api/connect/start` and `/api/connect/callback` is labeled simulated; it does not pretend to perform OAuth.

Send this JSON to `POST /api/prepare`, then `/api/publish`:

```json
{
  "accountIds": ["mock-account-1", "mock-account-2"],
  "format": "text",
  "text": "Hello from the simulated example",
  "idempotencyKey": "one-intent-generated-by-the-caller"
}
```

Generate a new key for a new intended publication. Reuse its key for a retry. Changed content under the same key returns HTTP 409. Each response preserves the independent outcomes. Video requests use `format: "video"`, `mediaUrl`, and `mediaMime`. `optionsByAccount` accepts each selected account's platform-specific choices and passes them through SDK preparation.

Call `/api/reconcile` with only `idempotencyKey` to read saved delivery references. It does not publish again. `/api/metrics` takes `accountId`, `platform`, and `postId`. `/api/comments/reply` also requires an actual `commentId` and `text`; unsupported backends return HTTP 501.

The mock event endpoint requires `x-mock-signature: valid`. Its JSON includes `eventId`, `accountId`, and `publicationKey`. Unknown mappings are quarantined. `/api/events/process` reconciles pending events and commits publication state with inbox completion in one transaction. Repeated deliveries and worker restarts do not repeat a completed application effect. The worker also supports Zernio and Post for Me publication events. Configure the backend webhook secret. Provider record IDs map to saved delivery references; unmapped or cross-account payloads are quarantined. Each worker invocation processes at most 100 events. Native removal reports and backend-record deletion reports are stored separately from publishing history and can be read through `/api/events/reports`.

## Real backend configuration

Choose a backend explicitly and configure its already-connected account IDs. This changes the backend only; account authorizations do not migrate.

| `EXAMPLE_BACKEND` | Server environment                                                            |
| ----------------- | ----------------------------------------------------------------------------- |
| `zernio`          | `ZERNIO_API_KEY`, `EXAMPLE_ACCOUNT_IDS`                                       |
| `post-for-me`     | `POST_FOR_ME_API_KEY`, `EXAMPLE_ACCOUNT_IDS`                                  |
| `bluesky`         | `BLUESKY_SERVICE`, `BLUESKY_DID`, `BLUESKY_ACCESS_JWT`, `EXAMPLE_ACCOUNT_IDS` |

`EXAMPLE_ACCOUNT_IDS` is a comma-separated membership allowlist. All credentials stay in the server process. Backend construction makes no request. Running account discovery or publishing can contact the selected provider and may incur its charges. Real backend flows have fixture coverage, not live verification.

A hosted application must replace the demo session with authenticated requests and application-owned membership lookup. `createExampleHandler` accepts an optional `ConnectionManager` and `ConnectionProvider` for real OAuth discovery and selection. Supply durable connection and encrypted credential stores. The example includes AES-GCM credential storage with revision checks; it does not invent an OAuth exchange or create a production login system.

## Verify

```sh
bun run --cwd apps/example check-types
node --import tsx --test apps/example/tests/*.test.ts
```

Run these commands from the repository root. The tests exercise request validation, account denial, mixed outcomes, idempotency conflicts, video reconciliation, pending-event recovery, encrypted credential tampering, and database reopening. No live social calls run during these tests.
