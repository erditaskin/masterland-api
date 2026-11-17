import { z } from "zod";
import type { FastifyRequest } from "fastify";
import type { App } from "./http.js";
import { ApiError, hash, token, type Executor } from "./core.js";
import type { Config } from "./config.js";

export const userSchema = z.object({
  id: z.uuid(),
  is_anonymous: z.boolean(),
  email: z.string().nullable(),
  user_metadata: z.object({ full_name: z.string().nullable() }),
  identities: z.array(
    z.object({ provider: z.enum(["apple", "google", "facebook"]) }),
  ),
});
export const sessionSchema = z.object({
  access_token: z.string(),
  expires_at: z.number().int(),
  user: userSchema,
});
export type Session = {
  id: string;
  userID: string;
  kind: "guest" | "registered";
  authenticatedAt: Date;
};
export const inspectSession = async (
  app: App,
  request: FastifyRequest,
): Promise<Session | null> => {
  const header = request.headers.authorization;
  if (!header) return null;
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
    throw new ApiError("unauthenticated");
  const [row] =
    await app.db`select s.id,s.user_id,u.kind,s.authenticated_at from sessions s join users u on u.id=s.user_id
    where s.token_hash=${hash(header.slice(7))} and s.expires_at>now() and s.revoked_at is null and u.status='active'`;
  if (!row) throw new ApiError("unauthenticated");
  const session = {
    id: String(row.id),
    userID: String(row.user_id),
    kind: z.enum(["guest", "registered"]).parse(row.kind),
    authenticatedAt: new Date(row.authenticated_at),
  };
  const expected = request.headers["x-masterland-owner"];
  if (expected !== undefined && expected !== session.userID)
    throw new ApiError("forbidden");
  await app.db`update sessions set expires_at=now()+(${app.config.SESSION_TTL_DAYS} * interval '1 day'),last_seen_at=now() where id=${session.id} and last_seen_at<now()-interval '5 minutes'`;
  return session;
};
export const requireSession = async (app: App, request: FastifyRequest) => {
  const session = await inspectSession(app, request);
  if (!session) throw new ApiError("unauthenticated");
  return session;
};
export const userView = async (tx: Executor, owner: string) => {
  const [user] =
    await tx`select id,kind,email,full_name from users where id=${owner} and status='active'`;
  if (!user) throw new ApiError("unauthenticated");
  const identities =
    await tx`select provider from identities where user_id=${owner} order by provider`;
  return userSchema.parse({
    id: user.id,
    is_anonymous: user.kind === "guest",
    email: user.email,
    user_metadata: { full_name: user.full_name },
    identities,
  });
};
export const issueSession = async (
  tx: Executor,
  owner: string,
  config: Config,
) => {
  const raw = token();
  const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400000);
  await tx`insert into sessions (user_id,token_hash,expires_at) values (${owner},${hash(raw)},${expires})`;
  return {
    access_token: raw,
    expires_at: Math.floor(expires.getTime() / 1000),
    user: await userView(tx, owner),
  };
};
