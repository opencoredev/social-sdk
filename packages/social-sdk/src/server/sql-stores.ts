import type { StoredCredential } from "./credentials.js";
import {
  storeError,
  type DurableAddress,
  type DurableDriver,
  type DurableLeaseInput,
} from "./durable-driver.js";
import {
  createDurableStores,
  storedCredentialCodec,
  type CredentialCodec,
  type DurableStores,
} from "./durable-stores.js";

export type SqlDialect = "postgres" | "sqlite";

export type SqlParameter = string | number;

/**
 * Minimal database access the SQL stores need. Statements use `$1` parameters
 * for Postgres and `?` for SQLite. Adapters must run each call as a single
 * statement on a connection that autocommits (or inside the caller's transaction).
 */
export interface SqlExecutor {
  /** Runs a SELECT and returns its rows as column-name objects. */
  query(sql: string, parameters: readonly SqlParameter[]): Promise<readonly unknown[]>;
  /** Runs an INSERT, UPDATE, or DELETE and returns the number of affected rows. */
  execute(sql: string, parameters: readonly SqlParameter[]): Promise<number>;
}

/** Subset of `pg.Pool` / `pg.Client`. */
export interface PostgresQueryable {
  query(
    sql: string,
    parameters: SqlParameter[],
  ): Promise<{ readonly rows: readonly unknown[]; readonly rowCount: number | null }>;
}

/** Wraps a node-postgres pool or client without importing `pg`. */
export function createPostgresExecutor(client: PostgresQueryable): SqlExecutor {
  return {
    query: async (sql, parameters) => (await client.query(sql, [...parameters])).rows,
    execute: async (sql, parameters) => (await client.query(sql, [...parameters])).rowCount ?? 0,
  };
}

/** Subset of `node:sqlite` `DatabaseSync` (also matches better-sqlite3). */
export interface SqliteDatabase {
  prepare(sql: string): {
    all(...parameters: SqlParameter[]): readonly unknown[];
    run(...parameters: SqlParameter[]): { readonly changes: number | bigint };
  };
}

/** Wraps a synchronous SQLite database without importing a driver. */
export function createSqliteExecutor(database: SqliteDatabase): SqlExecutor {
  return {
    query: async (sql, parameters) => database.prepare(sql).all(...parameters),
    execute: async (sql, parameters) => Number(database.prepare(sql).run(...parameters).changes),
  };
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export interface SqlDurableDriverOptions {
  readonly executor: SqlExecutor;
  readonly dialect: SqlDialect;
  /** Prefix for the two tables. Letters, digits, and underscores. Defaults to `social_sdk_`. */
  readonly tablePrefix?: string;
  /** Clock used for lease expiry. All workers sharing the tables need synchronized clocks. */
  readonly now?: () => Date;
}

function isRecordRow(row: unknown): row is { readonly revision: string; readonly body: string } {
  return (
    typeof row === "object" &&
    row !== null &&
    "revision" in row &&
    "body" in row &&
    typeof row.revision === "string" &&
    typeof row.body === "string"
  );
}

/**
 * {@link DurableDriver} over SQL. Construction runs no queries; call
 * {@link SqlDurableDriver.createSchema} (or apply {@link SqlDurableDriver.schema}
 * through your migrations) before first use.
 */
export class SqlDurableDriver implements DurableDriver {
  readonly #executor: SqlExecutor;
  readonly #dialect: SqlDialect;
  readonly #records: string;
  readonly #leases: string;
  readonly #now: () => Date;

  constructor(options: SqlDurableDriverOptions) {
    const prefix = options.tablePrefix ?? "social_sdk_";

    if (!IDENTIFIER.test(`${prefix}records`))
      throw storeError(
        "sql.configure",
        "tablePrefix must contain only letters, digits, and underscores",
        "invalid_config",
      );

    if (options.dialect !== "postgres" && options.dialect !== "sqlite")
      throw storeError("sql.configure", "dialect must be postgres or sqlite", "invalid_config");
    this.#executor = options.executor;
    this.#dialect = options.dialect;
    this.#records = `${prefix}records`;
    this.#leases = `${prefix}leases`;
    this.#now = options.now ?? (() => new Date());
  }

  /** `CREATE TABLE IF NOT EXISTS` statements for migrations. */
  schema(): readonly string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.#records} (namespace TEXT NOT NULL, record_key TEXT NOT NULL, revision TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (namespace, record_key))`,
      `CREATE TABLE IF NOT EXISTS ${this.#leases} (namespace TEXT NOT NULL, lease_key TEXT NOT NULL, token TEXT NOT NULL, expires_at BIGINT NOT NULL, PRIMARY KEY (namespace, lease_key))`,
    ];
  }

  async createSchema(): Promise<void> {
    for (const statement of this.schema()) await this.#executor.execute(statement, []);
  }

  /** Statements are written with `?`; Postgres gets numbered placeholders. */
  #sql(statement: string): string {
    if (this.#dialect === "sqlite") return statement;
    let index = 0;

    return statement.replaceAll("?", () => `$${++index}`);
  }

  async read(
    input: DurableAddress,
  ): Promise<{ readonly text: string; readonly revision: string } | undefined> {
    const rows = await this.#executor.query(
      this.#sql(
        `SELECT revision, body FROM ${this.#records} WHERE namespace = ? AND record_key = ?`,
      ),
      [input.namespace, input.key],
    );

    if (rows.length === 0) return undefined;
    const row = rows[0];

    if (rows.length > 1 || !isRecordRow(row))
      throw storeError("sql.read", "SQL executor returned an unexpected row");

    return { text: row.body, revision: row.revision };
  }

  async write(
    input: DurableAddress & {
      readonly expectedRevision: string | undefined;
      readonly revision: string;
      readonly text: string;
    },
  ): Promise<boolean> {
    const affected =
      input.expectedRevision === undefined
        ? await this.#executor.execute(
            this.#sql(
              `INSERT INTO ${this.#records} (namespace, record_key, revision, body) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, record_key) DO NOTHING`,
            ),
            [input.namespace, input.key, input.revision, input.text],
          )
        : await this.#executor.execute(
            this.#sql(
              `UPDATE ${this.#records} SET revision = ?, body = ? WHERE namespace = ? AND record_key = ? AND revision = ?`,
            ),
            [input.revision, input.text, input.namespace, input.key, input.expectedRevision],
          );

    return affected === 1;
  }

  async remove(input: DurableAddress & { readonly expectedRevision?: string }): Promise<boolean> {
    const affected =
      input.expectedRevision === undefined
        ? await this.#executor.execute(
            this.#sql(`DELETE FROM ${this.#records} WHERE namespace = ? AND record_key = ?`),
            [input.namespace, input.key],
          )
        : await this.#executor.execute(
            this.#sql(
              `DELETE FROM ${this.#records} WHERE namespace = ? AND record_key = ? AND revision = ?`,
            ),
            [input.namespace, input.key, input.expectedRevision],
          );

    return affected === 1;
  }

  async acquireLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean> {
    const now = this.#now().getTime();

    // The upsert only replaces an expired lease; a live one leaves zero affected rows.
    const affected = await this.#executor.execute(
      this.#sql(
        `INSERT INTO ${this.#leases} (namespace, lease_key, token, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (namespace, lease_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at WHERE ${this.#leases}.expires_at <= ?`,
      ),
      [input.namespace, input.key, input.token, now + input.ttlMs, now],
    );

    return affected === 1;
  }

  async renewLease(input: DurableLeaseInput & { readonly ttlMs: number }): Promise<boolean> {
    const now = this.#now().getTime();

    const affected = await this.#executor.execute(
      this.#sql(
        `UPDATE ${this.#leases} SET expires_at = ? WHERE namespace = ? AND lease_key = ? AND token = ? AND expires_at > ?`,
      ),
      [now + input.ttlMs, input.namespace, input.key, input.token, now],
    );

    return affected === 1;
  }

  async releaseLease(input: DurableLeaseInput): Promise<boolean> {
    const affected = await this.#executor.execute(
      this.#sql(`DELETE FROM ${this.#leases} WHERE namespace = ? AND lease_key = ? AND token = ?`),
      [input.namespace, input.key, input.token],
    );

    return affected === 1;
  }
}

export type SqlStores<TCredential> = DurableStores<TCredential> & {
  readonly driver: SqlDurableDriver;
};

/**
 * Builds every durable store on one SQL driver. Runs no queries. Without a
 * codec, credentials use plain JSON {@link storedCredentialCodec}, which leaves
 * tokens readable to anyone with table access; pass an encrypting codec, or a
 * codec for an encrypted envelope type, to change that.
 */
export function createSqlStores(options: SqlDurableDriverOptions): SqlStores<StoredCredential>;
export function createSqlStores<TCredential>(
  options: SqlDurableDriverOptions & { readonly credentialCodec: CredentialCodec<TCredential> },
): SqlStores<TCredential>;
export function createSqlStores<TCredential>(
  options: SqlDurableDriverOptions & { readonly credentialCodec?: CredentialCodec<TCredential> },
): SqlStores<TCredential> | SqlStores<StoredCredential> {
  const driver = new SqlDurableDriver(options);

  return options.credentialCodec === undefined
    ? { driver, ...createDurableStores({ driver, codec: storedCredentialCodec, now: options.now }) }
    : {
        driver,
        ...createDurableStores({ driver, codec: options.credentialCodec, now: options.now }),
      };
}
