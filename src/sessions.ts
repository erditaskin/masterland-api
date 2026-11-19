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
const deviceSchema = z.object({ id: z.uuid(), os: z.enum(["ios", "android"]) });
export type Device = z.infer<typeof deviceSchema>;
export const readDevice = (request: FastifyRequest) => {
  const id = request.headers["x-masterland-device-id"];
  const os = request.headers["x-masterland-device-os"];
  if (id === undefined && os === undefined) return undefined;
  const device = deviceSchema.safeParse({ id, os });
  if (!device.success) throw new ApiError("validation");
  return device.data;
};
export const recordDevice = async (
  tx: Executor,
  owner: string,
  device?: Device,
) => {
  if (!device) return;
  await tx`insert into user_devices (user_id,device_id,os) values (${owner},${device.id},${device.os})
    on conflict (user_id,device_id) do update set os=excluded.os,last_seen_at=now()
    where user_devices.os<>excluded.os or user_devices.last_seen_at<now()-interval '5 minutes'`;
};
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
    await app.db`select s.id,s.user_id,u.kind,s.authenticated_at,(s.last_seen_at<now()-interval '5 minutes') as needs_refresh from sessions s join users u on u.id=s.user_id
    where s.token_hash=${hash(header.slice(7))} and s.expires_at>now() and s.revoked_at is null and u.status='active' and not u.deleted`;
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
  if (row.needs_refresh === true)
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
    await tx`select u.id,u.kind,coalesce(u.provider_email,u.email) as email,u.full_name,
    (select coalesce(jsonb_agg(jsonb_build_object('provider',i.provider) order by i.provider),'[]'::jsonb)
      from identities i where i.user_id=u.id) as identities
    from users u where u.id=${owner} and u.status='active' and not u.deleted`;
  if (!user) throw new ApiError("unauthenticated");
  return userSchema.parse({
    id: user.id,
    is_anonymous: user.kind === "guest",
    email: user.email,
    user_metadata: { full_name: user.full_name },
    identities: user.identities,
  });
};
export const issueSession = async (
  tx: Executor,
  owner: string,
  config: Config,
  device?: Device,
) => {
  const raw = token();
  const expires = new Date(Date.now() + config.SESSION_TTL_DAYS * 86400000);
  await tx`insert into sessions (user_id,token_hash,expires_at) values (${owner},${hash(raw)},${expires})`;
  await recordDevice(tx, owner, device);
  return {
    access_token: raw,
    expires_at: Math.floor(expires.getTime() / 1000),
    user: await userView(tx, owner),
  };
};
