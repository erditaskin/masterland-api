import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../config.js";
import { connect } from "./client.js";
const config = parseConfig(process.env);
const client = connect(config);
const reserved = await client.reserve();
try {
  await reserved`select pg_advisory_lock(732041728)`;
  await migrate(drizzle(client), {
    migrationsFolder: fileURLToPath(new URL("./migrations", import.meta.url)),
  });
  console.log("Masterland migrations applied");
} finally {
  await reserved`select pg_advisory_unlock(732041728)`;
  reserved.release();
  await client.end();
}
