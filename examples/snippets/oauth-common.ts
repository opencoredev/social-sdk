import type {
  ConnectionProvider,
  OAuthCredentialSink,
  OAuthTokenSet,
} from "@opencoredev/social-sdk/server";
import { ConnectionManager, MemoryConnectionStore } from "@opencoredev/social-sdk/server";
import type { ConnectionAccount, ConnectionAttempt } from "@opencoredev/social-sdk/server";

export function requiredEnvironment(name: string): string {
  const value = process.env[name];

  if (!value) throw new Error(`Missing required server environment variable ${name}`);

  return value;
}

/** Replace this development sink with encrypted, tenant-scoped persistence. */
export class MemoryOAuthCredentialSink implements OAuthCredentialSink {
  readonly records = new Map<
    string,
    {
      readonly account: ConnectionAccount;
      readonly token: OAuthTokenSet;
      readonly attempt: ConnectionAttempt;
    }
  >();

  async save(input: {
    readonly account: ConnectionAccount;
    readonly token: OAuthTokenSet;
    readonly attempt: ConnectionAttempt;
  }): Promise<void> {
    const key = `${input.attempt.tenantId}:${input.account.ref.backend}:${input.account.ref.platform}:${input.account.ref.accountId}`;
    this.records.set(key, structuredClone(input));
  }
}

export async function discoverAndSelect(input: {
  readonly manager: ConnectionManager;
  readonly provider: ConnectionProvider;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly callbackUrl: string;
  readonly returnedState: string;
  readonly allowedRedirectUris: readonly string[];
  readonly selectedAccountIds: readonly string[];
}) {
  const discovered = await input.manager.discover({
    attemptId: input.attemptId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    callbackUrl: input.callbackUrl,
    returnedState: input.returnedState,
    allowedRedirectUris: input.allowedRedirectUris,
    provider: input.provider,
  });

  const grants = await input.manager.select({
    attemptId: input.attemptId,
    tenantId: input.tenantId,
    principalId: input.principalId,
    selectedAccountIds: input.selectedAccountIds,
  });

  return { discovered, grants };
}

export function createConnectionManager(store = new MemoryConnectionStore()): ConnectionManager {
  return new ConnectionManager({ store });
}
