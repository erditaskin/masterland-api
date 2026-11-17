import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";

export type Executor = postgres.Sql | postgres.TransactionSql;
export const token = () => randomBytes(32).toString("base64url");
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const challenge = (text: string) =>
  createHash("sha256").update(text).digest("base64url");
export const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const uuid = () => randomUUID();
const statuses = {
  unauthenticated: 401,
  forbidden: 403,
  validation: 422,
  not_found: 404,
  conflict: 409,
  idempotency_mismatch: 409,
  reauthentication_required: 403,
  disabled: 503,
  provider_unavailable: 503,
  internal: 500,
  rate_limited: 429,
} as const;
export class ApiError extends Error {
  readonly statusCode: number;
  constructor(readonly code: keyof typeof statuses) {
    super(code);
    this.statusCode = statuses[code];
  }
}
export const errorSchema = z.object({
  error: z.object({ code: z.string(), requestId: z.string() }),
});
export const errors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  422: errorSchema,
  429: errorSchema,
  500: errorSchema,
  503: errorSchema,
};
export const ownerLock = async (tx: Executor, owner: string) => {
  await tx`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`;
  const [row] =
    await tx`select id from users where id=${owner} and status='active' for update`;
  if (!row) throw new ApiError("unauthenticated");
};
