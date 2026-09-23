import { defineConfig } from "drizzle-kit";

// Generates SQL migrations from the schema. `bun run db:migrate` applies them with the app's own driver.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
