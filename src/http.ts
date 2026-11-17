import Fastify from "fastify";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import type postgres from "postgres";
import { type Config } from "./config.js";
import { ApiError, errors, uuid } from "./core.js";
import { registerAuth } from "./auth/routes.js";
import { registerCloud } from "./cloud.js";
import { registerRewards } from "./rewards/routes.js";
import { registerDeletion } from "./deletion.js";

declare module "fastify" {
  interface FastifyInstance {
    db: postgres.Sql;
    config: Config;
  }
}
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
>;
export const buildApp = async (
  config: Config,
  db: postgres.Sql,
): Promise<App> => {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    requestTimeout: 30000,
    connectionTimeout: 10000,
    requestIdHeader: false,
    genReqId: () => uuid(),
    // The API only binds to loopback; nginx overwrites forwarded headers.
    trustProxy:
      config.NODE_ENV === "production" ? (_address, hop) => hop === 0 : false,
    logger:
      config.LOG_LEVEL === "silent"
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
              "token",
              "receipt",
              "identity_token",
              "apple_authorization_code",
              "client_secret",
            ],
            serializers: {
              req: (request) => ({
                method: request.method,
                path: String(request.url).split("?")[0],
                remoteAddress: request.ip,
              }),
              // Database/provider exceptions can contain secrets or entire save payloads. Never serialize them.
              err: () => ({
                type: "RequestFailure",
                message: "Request failed",
                stack: "",
              }),
            },
          },
  }).withTypeProvider<ZodTypeProvider>();
  app.decorate("db", db);
  app.decorate("config", config);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error, request, reply) => {
    const boundary = z
      .object({
        statusCode: z.number().optional(),
        validation: z.unknown().optional(),
      })
      .safeParse(error);
    const status =
      error instanceof ApiError
        ? error.statusCode
        : boundary.success && boundary.data.statusCode === 429
          ? 429
          : (boundary.success &&
                (boundary.data.validation ||
                  boundary.data.statusCode === 400)) ||
              error instanceof z.ZodError
            ? 422
            : 500;
    const code =
      error instanceof ApiError
        ? error.code
        : status === 429
          ? "rate_limited"
          : status === 422
            ? "validation"
            : "internal";
    if (status === 500)
      request.log.error({ requestId: request.id }, "Request failed");
    void reply.code(status).send({ error: { code, requestId: request.id } });
  });
  await app.register(helmet, { contentSecurityPolicy: true });
  await app.register(cors, {
    origin: [config.SITE_ORIGIN],
    credentials: false,
    methods: ["GET", "POST", "PUT", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-masterland-owner"],
    exposedHeaders: ["x-request-id"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (request, reply) => {
    void reply
      .header("x-request-id", request.id)
      .header("cache-control", "no-store");
    // No cookies are accepted as API authority. Native requests use bearer sessions.
    if (request.headers.origin && request.headers.origin !== config.SITE_ORIGIN)
      throw new ApiError("forbidden");
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send({ error: { code: "not_found", requestId: request.id } }),
  );
  app.get(
    "/health",
    { schema: { response: { 200: z.object({ status: z.literal("ok") }) } } },
    async () => ({ status: "ok" as const }),
  );
  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ready"), release: z.string() }),
          ...errors,
        },
      },
    },
    async () => {
      await db`select 1 from users limit 1`;
      return {
        status: "ready" as const,
        release: process.env.RELEASE_ID ?? "local",
      };
    },
  );
  registerAuth(app);
  registerCloud(app);
  registerRewards(app);
  registerDeletion(app);
  await app.ready();
  return app;
};
