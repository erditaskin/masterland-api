import { z } from "zod";
import type { App } from "../http.js";
import { ApiError, challenge, errors, hash, token, uuid } from "../core.js";
import {
  inspectSession,
  issueSession,
  requireSession,
  sessionSchema,
  userSchema,
  userView,
  type Session,
} from "../sessions.js";
import {
  appleIdentity,
  exchangeProvider,
  identitySchema,
  nativeNonce,
  providerAuthorization,
} from "./providers.js";
import { signInIdentity } from "./service.js";

const provider = z.enum(["google", "facebook"]);
const reauth = z.boolean().default(false);
const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
export const registerAuth = (app: App) => {
  app.post(
    "/v1/auth/guest",
    {
      config: authLimit,
      schema: {
        body: z.object({ request_id: z.uuid() }).strict(),
        response: { 200: sessionSchema, ...errors },
      },
    },
    async (request) => {
      const session = await inspectSession(app, request);
      if (session)
        return app.db.begin(async (tx) =>
          issueSession(tx, session.userID, app.config),
        );
      return app.db.begin(async (tx) => {
        const [user] = await tx`insert into users default values returning id`;
        if (!user) throw new ApiError("internal");
        return issueSession(tx, String(user.id), app.config);
      });
    },
  );
  app.get(
    "/v1/auth/me",
    { schema: { response: { 200: userSchema, ...errors } } },
    async (request) =>
      userView(app.db, (await requireSession(app, request)).userID),
  );
  app.post(
    "/v1/auth/logout",
    {
      schema: {
        body: z.object({}).strict(),
        response: { 200: z.object({ ok: z.literal(true) }), ...errors },
      },
    },
    async (request) => {
      const session = await requireSession(app, request);
      await app.db`update sessions set revoked_at=now() where id=${session.id}`;
      return { ok: true as const };
    },
  );
  app.post(
    "/v1/auth/apple/challenge",
    {
      config: authLimit,
      schema: {
        body: z.object({ reauthenticate: reauth }).strict(),
        response: {
          200: z.object({ id: z.uuid(), nonce: z.string() }),
          ...errors,
        },
      },
    },
    async (request) => {
      const previous = await inspectSession(app, request);
      if (request.body.reauthenticate && !previous)
        throw new ApiError("unauthenticated");
      const id = uuid(),
        nonce = token();
      await app.db`insert into oauth_attempts (id,provider,state_hash,challenge,nonce,provider_verifier,owner_id,session_id,reauthenticate,expires_at)
      values (${id},'apple',${hash(token())},'',${nativeNonce(nonce)},'',${previous?.userID ?? null},${previous?.id ?? null},${request.body.reauthenticate ? 1 : 0},now()+interval '5 minutes')`;
      return { id, nonce };
    },
  );
  app.post(
    "/v1/auth/apple",
    {
      config: authLimit,
      schema: {
        body: z
          .object({
            challenge_id: z.uuid(),
            identity_token: z.string().max(16384),
            full_name: z.string().trim().max(256).nullable(),
          })
          .strict(),
        response: { 200: sessionSchema, ...errors },
      },
    },
    async (request) => {
      const previous = await inspectSession(app, request);
      const [attempt] =
        await app.db`select * from oauth_attempts where id=${request.body.challenge_id} and provider='apple' and expires_at>now()`;
      if (!attempt || attempt.session_id !== (previous?.id ?? null))
        throw new ApiError("unauthenticated");
      const identity = await appleIdentity(
        app.config,
        request.body.identity_token,
        String(attempt.nonce),
      );
      identity.fullName = request.body.full_name;
      return app.db.begin(async (tx) => {
        const consumed =
          await tx`delete from oauth_attempts where id=${attempt.id} and expires_at>now() returning id`;
        if (!consumed.length) throw new ApiError("unauthenticated");
        return signInIdentity(
          tx,
          app.config,
          identity,
          previous,
          attempt.reauthenticate === 1,
        );
      });
    },
  );
  app.post(
    "/v1/auth/oauth/start",
    {
      config: authLimit,
      schema: {
        body: z
          .object({
            provider,
            code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            reauthenticate: reauth,
          })
          .strict(),
        response: {
          200: z.object({ url: z.url(), state: z.string() }),
          ...errors,
        },
      },
    },
    async (request) => {
      const previous = await inspectSession(app, request);
      if (request.body.reauthenticate && !previous)
        throw new ApiError("unauthenticated");
      const state = token(),
        nonce = token(),
        verifier = token();
      const url = providerAuthorization(
        app.config,
        request.body.provider,
        state,
        nonce,
        challenge(verifier),
        request.body.reauthenticate,
      );
      await app.db`insert into oauth_attempts (provider,state_hash,challenge,nonce,provider_verifier,owner_id,session_id,reauthenticate,expires_at)
      values (${request.body.provider},${hash(state)},${request.body.code_challenge},${nonce},${verifier},${previous?.userID ?? null},${previous?.id ?? null},${request.body.reauthenticate ? 1 : 0},now()+interval '10 minutes')`;
      return { url, state };
    },
  );
  app.get(
    "/v1/auth/:provider/callback",
    {
      config: authLimit,
      schema: {
        params: z.object({ provider }),
        querystring: z
          .object({
            state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            code: z.string().max(8192).optional(),
            error: z.string().max(256).optional(),
          })
          .passthrough(),
        response: { 302: z.null(), ...errors },
      },
    },
    async (request, reply) => {
      const [attempt] =
        await app.db`select * from oauth_attempts where state_hash=${hash(request.query.state)} and provider=${request.params.provider} and expires_at>now() and code_hash is null`;
      if (!attempt) throw new ApiError("unauthenticated");
      const redirect = new URL("masterland://auth/callback");
      redirect.searchParams.set("state", request.query.state);
      if (request.query.error || !request.query.code) {
        await app.db`delete from oauth_attempts where id=${attempt.id}`;
        redirect.searchParams.set("error", "access_denied");
      } else {
        const identity = await exchangeProvider(
          app.config,
          request.params.provider,
          request.query.code,
          String(attempt.provider_verifier),
          String(attempt.nonce),
        );
        const code = token();
        const updated =
          await app.db`update oauth_attempts set verified_identity=${app.db.json(identity)},code_hash=${hash(code)},provider_verifier='',expires_at=now()+interval '2 minutes' where id=${attempt.id} and code_hash is null returning id`;
        if (!updated.length) throw new ApiError("unauthenticated");
        redirect.searchParams.set("code", code);
      }
      // An explicit empty fragment prevents browsers inheriting the provider's fragment
      // (for example Facebook's #_=_) across this redirect. Native state/PKCE checks stay strict.
      return reply.redirect(`${redirect.toString()}#`);
    },
  );
  app.post(
    "/v1/auth/oauth/exchange",
    {
      config: authLimit,
      schema: {
        body: z
          .object({
            code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
            code_verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
          })
          .strict(),
        response: { 200: sessionSchema, ...errors },
      },
    },
    async (request) => {
      const previous = await inspectSession(app, request);
      return app.db.begin(async (tx) => {
        const [attempt] =
          await tx`select * from oauth_attempts where code_hash=${hash(request.body.code)} and state_hash=${hash(request.body.state)} and expires_at>now() for update`;
        if (
          !attempt ||
          attempt.challenge !== challenge(request.body.code_verifier) ||
          attempt.session_id !== (previous?.id ?? null)
        )
          throw new ApiError("unauthenticated");
        const identity = identitySchema.parse(attempt.verified_identity);
        const bound: Session | null = previous;
        const session = await signInIdentity(
          tx,
          app.config,
          identity,
          bound,
          attempt.reauthenticate === 1,
        );
        await tx`delete from oauth_attempts where id=${attempt.id}`;
        return session;
      });
    },
  );
};
