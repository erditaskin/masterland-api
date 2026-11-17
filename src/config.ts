import { z } from "zod";

const flag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");
const httpsOrigin = z.url().refine((v) => new URL(v).origin === v);
const schema = z.object({
  NODE_ENV: z.enum(["local", "test", "production"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4200),
  API_URL: httpsOrigin.default("http://127.0.0.1:4200"),
  SITE_ORIGIN: httpsOrigin.default("https://masterland.app"),
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(10).default(3),
  LOG_LEVEL: z
    .enum(["silent", "error", "warn", "info", "debug"])
    .default("info"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  FACEBOOK_APP_ID: z.string().default("999025329335282"),
  FACEBOOK_APP_SECRET: z.string().default(""),
  FACEBOOK_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default("v25.0"),
  APPLE_CLIENT_ID: z
    .literal("com.erditaskin.masterland")
    .default("com.erditaskin.masterland"),
  APPLE_TEAM_ID: z.string().default("F3F723W4SF"),
  APPLE_KEY_ID: z.string().default(""),
  APPLE_PRIVATE_KEY_PATH: z.string().default(""),
  ADMOB_SSV_ENABLED: flag,
  ADMOB_REWARDED_UNIT_ID: z
    .string()
    .default("ca-app-pub-2972187520207492/2927598891"),
  ADMOB_PRODUCER_REWARDED_UNIT_ID: z
    .string()
    .default("ca-app-pub-2972187520207492/2798328693"),
  ACCOUNT_DELETION_ENABLED: flag,
});
export type Config = z.infer<typeof schema>;
export const parseConfig = (input: NodeJS.ProcessEnv): Config => {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw Error(
      `Invalid configuration keys: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  const database = new URL(config.DATABASE_URL).pathname.slice(1);
  if (!/^masterland_[a-z0-9_]+$/.test(database))
    throw Error("Masterland database required");
  if (config.NODE_ENV === "test" && !database.startsWith("masterland_test"))
    throw Error("Test database required");
  if (
    config.NODE_ENV === "production" &&
    (!config.API_URL.startsWith("https://") ||
      !config.SITE_ORIGIN.startsWith("https://"))
  )
    throw Error("Production requires HTTPS");
  return config;
};
