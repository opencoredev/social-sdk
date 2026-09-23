import { openDatabaseFromEnv } from "./client.js";

// Opening the database applies pending migrations with the same driver the server uses.
const database = await openDatabaseFromEnv(process.env);

await database.close();

console.log(`Migrations applied (${database.driver})`);
