import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { promisify } from "node:util";
import {
  ConnectionManager,
  createRedisStores,
  type RedisScriptRunner,
} from "../src/server/index.js";
import type { ConnectionProvider } from "../src/server/connections.js";

const execute = promisify(execFile);

const redisRoot = process.env["SOCIAL_SDK_TEST_REDIS_ROOT"];

function isReply(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

// Optional local integration: point at an extracted Redis distribution. This
// test owns its server, disables TCP, and never connects to an existing service.
it(
  "executes durable store contracts against real Redis Lua scripts",
  { skip: redisRoot === undefined, timeout: 20_000 },
  async () => {
    assert.ok(redisRoot);
    const root = resolve(redisRoot);
    const scratch = resolve("tmp");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "redis-contract-"));
    // Redis rejects Unix socket names longer than 107 bytes. Use a short
    // relative path because worktree paths can already exceed that limit.
    const relativeSocket = "redis.sock";

    const environment = {
      ...process.env,
      LD_LIBRARY_PATH: join(root, "usr/lib/x86_64-linux-gnu"),
    };

    const server = spawn(
      join(root, "usr/bin/redis-server"),
      [
        "--port",
        "0",
        "--unixsocket",
        relativeSocket,
        "--unixsocketperm",
        "700",
        "--save",
        "",
        "--appendonly",
        "no",
        "--daemonize",
        "no",
        "--logfile",
        "redis.log",
      ],
      { cwd: directory, env: environment, stdio: "ignore" },
    );

    // Observe startup errors immediately instead of leaving an unhandled event.
    let startupError: Error | undefined;
    server.on("error", (error) => {
      startupError = error;
    });

    async function command(arguments_: readonly string[]): Promise<string> {
      const result = await execute(
        join(root, "usr/bin/redis-cli"),
        ["-s", relativeSocket, "--json", ...arguments_],
        { cwd: directory, env: environment, timeout: 3000, maxBuffer: 1024 * 1024 },
      );

      return result.stdout.trim();
    }

    try {
      const deadline = Date.now() + 5000;

      for (;;) {
        if (startupError !== undefined) throw startupError;

        try {
          assert.equal(await command(["PING"]), '"PONG"');
          break;
        } catch (error) {
          if (Date.now() >= deadline || server.exitCode !== null) throw error;
          await delay(25);
        }
      }

      const runner: RedisScriptRunner = {
        async eval(script, keys, args) {
          const value: unknown = JSON.parse(
            await command(["EVAL", script, String(keys.length), ...keys, ...args]),
          );

          assert.ok(isReply(value));

          return value;
        },
      };

      const stores = createRedisStores({ runner, prefix: "contract:" });
      const second = createRedisStores({ runner, prefix: "contract:" });

      const created = await stores.credentials.compareAndSet({
        key: "account",
        expectedRevision: undefined,
        value: { accessToken: "offline-access", refreshToken: "offline-refresh" },
      });

      assert.equal(created.updated, true);
      assert.equal((await second.credentials.get("account"))?.revision, created.revision);

      const competing = await Promise.all([
        stores.credentials.compareAndSet({
          key: "account",
          expectedRevision: created.revision,
          value: { accessToken: "one" },
        }),
        second.credentials.compareAndSet({
          key: "account",
          expectedRevision: created.revision,
          value: { accessToken: "two" },
        }),
      ]);

      assert.equal(competing.filter((result) => result.updated).length, 1);

      const replacement = await second.credentials.get("account");

      assert.ok(replacement);
      assert.equal(
        await stores.credentials.deleteIfRevision("account", created.revision ?? ""),
        false,
      );
      assert.equal(
        await second.credentials.deleteIfRevision("account", replacement.revision),
        true,
      );
      assert.equal(await stores.credentials.get("account"), undefined);

      await stores.credentials.compareAndSet({
        key: "account",
        expectedRevision: undefined,
        value: { accessToken: "recreated" },
      });
      await second.credentials.delete("account");
      assert.equal(await stores.credentials.get("account"), undefined);

      const firstLease = await stores.credentialLock.acquire("owned", 50);
      assert.ok(firstLease);
      await delay(100);
      const nextLease = await second.credentialLock.acquire("owned", 2000);
      assert.ok(nextLease);
      await stores.credentialLock.release(firstLease);
      assert.equal(await stores.credentialLock.acquire("owned", 2000), undefined);
      assert.ok(await second.credentialLock.renew(nextLease, 2000));
      await second.credentialLock.release(nextLease);
      const available = await stores.credentialLock.acquire("owned", 2000);
      assert.ok(available);
      await stores.credentialLock.release(available);

      const claimInput = {
        scope: "tenant",
        key: "intent",
        fingerprint: "payload",
        targetKeys: ["one", "two"],
      };

      const claim = await stores.idempotency.claim(claimInput);
      assert.equal(claim.kind, "new");

      const account = {
        kind: "connected-account",
        version: 1,
        backend: "direct",
        platform: "youtube",
        accountId: "channel",
      } satisfies import("../src/core/types.js").ConnectedAccountRef;

      const outcome = {
        state: "accepted",
        account,
        targetIndex: 0,
        observedAt: "2026-10-24T12:00:00Z",
      } satisfies import("../src/core/types.js").DeliveryOutcome;

      await Promise.all([
        stores.idempotency.saveOutcome({ claimId: claim.claimId, targetKey: "one", outcome }),
        second.idempotency.saveOutcome({
          claimId: claim.claimId,
          targetKey: "two",
          outcome: { ...outcome, targetIndex: 1 },
        }),
      ]);
      const replay = await second.idempotency.claim(claimInput);
      assert.equal(replay.kind, "existing");
      assert.deepEqual(Object.keys(replay.outcomes).sort(), ["one", "two"]);
      assert.deepEqual(await stores.idempotency.claim({ ...claimInput, fingerprint: "changed" }), {
        kind: "conflict",
      });

      let exchanges = 0;

      const provider: ConnectionProvider = {
        start: async () => ({ authorizationUrl: "https://provider.example/authorize" }),
        complete: async () => {
          exchanges++;

          return [{ ref: account, displayName: "Offline channel" }];
        },
      };

      const manager = new ConnectionManager({ store: stores.connections });
      const principal = { tenantId: "tenant", principalId: "principal" };

      const started = await manager.begin({
        ...principal,
        backend: "direct",
        platforms: ["youtube"],
        provider,
        redirectUri: "https://app.example/callback",
        allowedRedirectUris: ["https://app.example/callback"],
      });

      const discovery = {
        ...principal,
        attemptId: started.attempt.id,
        provider,
        callbackUrl: "https://app.example/callback?state=" + started.attempt.state,
        returnedState: started.attempt.state,
        allowedRedirectUris: ["https://app.example/callback"],
      };

      await manager.discover(discovery);
      await manager.discover(discovery);
      assert.equal(exchanges, 1);

      const selected = {
        ...principal,
        attemptId: started.attempt.id,
        selectedAccountIds: ["channel"],
      };

      const completions = await Promise.allSettled([
        manager.select(selected),
        manager.select(selected),
      ]);

      assert.equal(completions.filter((result) => result.status === "fulfilled").length, 1);
      const grants = await second.connections.listGrants(started.attempt.id);
      assert.equal(grants.length, 1);
      const grant = grants[0];
      assert.ok(grant);
      assert.deepEqual(await stores.connections.getGrant(grant.grantId), grant);
      assert.equal(await second.connections.revokeGrant(grant.grantId), true);
      assert.equal(await stores.connections.getGrant(grant.grantId), undefined);
    } finally {
      if (server.pid !== undefined && server.exitCode === null) {
        const exited = once(server, "exit", { signal: AbortSignal.timeout(5000) });
        server.kill("SIGTERM");

        try {
          await exited;
        } catch {
          const killed = once(server, "exit", { signal: AbortSignal.timeout(5000) });
          server.kill("SIGKILL");
          await killed;
        }
      }

      await rm(directory, { recursive: true, force: true });
    }
  },
);
