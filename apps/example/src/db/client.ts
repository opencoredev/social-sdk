import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Pool } from "@neondatabase/serverless";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { migrate as migrateNeon } from "drizzle-orm/neon-serverless/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema.js";

/** Any Drizzle Postgres database or transaction over the example schema. */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface ExampleDatabase {
  readonly db: Database;
  readonly driver: "neon" | "pglite";
  close(): Promise<void>;
}

export type ExampleDatabaseOptions = {
  /** Postgres connection string. When set, the example connects to Neon over WebSockets. */
  readonly url?: string | undefined;
  /** PGlite data directory used when `url` is absent. Omit it for an in-memory database. */
  readonly dataDir?: string | undefined;
};

const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url));

export const defaultPgliteDir = fileURLToPath(new URL("../../.data/pglite", import.meta.url));

// Arbitrary advisory lock key reserved for example migrations.
const migrationLock = 7_424_031;

/** Opens the example database and applies pending migrations before returning it. */
export async function openExampleDatabase(
  options: ExampleDatabaseOptions = {},
): Promise<ExampleDatabase> {
  if (options.url) {
    const pool = new Pool({ connectionString: options.url });
    // An idle connection can drop when Neon suspends compute; without a listener that crashes the process.
    pool.on("error", (error: Error) => console.error("Postgres pool error", error));
    const db = drizzleNeon({ client: pool, schema });

    try {
      // Instances sharing a database take turns so each migration runs once.
      const lock = await pool.connect();

      try {
        await lock.query("select pg_advisory_lock($1)", [migrationLock]);
        await migrateNeon(db, { migrationsFolder });
      } finally {
        await lock.query("select pg_advisory_unlock($1)", [migrationLock]).catch(() => {});
        lock.release();
      }
    } catch (error) {
      await pool.end();
      throw error;
    }

    return { db, driver: "neon", close: () => pool.end() };
  }

  if (options.dataDir) mkdirSync(options.dataDir, { recursive: true });
  const client = await PGlite.create(options.dataDir);
  const db = drizzlePglite({ client, schema });

  try {
    await migratePglite(db, { migrationsFolder });
  } catch (error) {
    await client.close();
    throw error;
  }

  return { db, driver: "pglite", close: () => client.close() };
}

/** Selects Neon when `DATABASE_URL` is set, otherwise a persistent local PGlite directory. */
export function openDatabaseFromEnv(env: NodeJS.ProcessEnv): Promise<ExampleDatabase> {
  return openExampleDatabase({
    url: env["DATABASE_URL"],
    dataDir: env["EXAMPLE_DB"] ?? defaultPgliteDir,
  });
}
