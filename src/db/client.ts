import postgres from "postgres";
import type { Config } from "../config.js";
export const connect = (config: Config) =>
  postgres(config.DATABASE_URL, {
    max: config.DB_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    connection: {
      statement_timeout: 15000,
      application_name: "masterland-api",
    },
    onnotice: () => {},
  });
