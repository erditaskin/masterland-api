import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Config } from "../config.js";
import { ApiError, equal, hash } from "../core.js";

const googleKeys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 5000 },
);
const appleKeys = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
  { timeoutDuration: 5000 },
);
export const identitySchema = z.object({
  provider: z.enum(["apple", "google", "facebook"]),
  subject: z.string().min(1).max(256),
  email: z.string().max(254).nullable(),
  fullName: z.string().max(256).nullable(),
});
export type Identity = z.infer<typeof identitySchema>;
const jsonResponse = async (
  url: string,
  init?: RequestInit,
): Promise<unknown> => {
  try {
    const result = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10000),
    });
    if (!result.ok) throw new ApiError("provider_unavailable");
    return await result.json();
  } catch {
    throw new ApiError("provider_unavailable");
  }
};
export const appleIdentity = async (
  config: Config,
  token: string,
  nonce: string,
): Promise<Identity> => {
  try {
    const { payload } = await jwtVerify(token, appleKeys, {
      issuer: "https://appleid.apple.com",
      audience: config.APPLE_CLIENT_ID,
      algorithms: ["RS256"],
      maxTokenAge: "10 minutes",
    });
    if (
      !payload.sub ||
      typeof payload.nonce !== "string" ||
      !equal(payload.nonce, nonce)
    )
      throw new ApiError("unauthenticated");
    return identitySchema.parse({
      provider: "apple",
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      fullName: null,
    });
  } catch {
    throw new ApiError("unauthenticated");
  }
};
export const providerAuthorization = (
  config: Config,
  provider: "google" | "facebook",
  state: string,
  nonce: string,
  verifierChallenge: string,
  reauthenticate: boolean,
) => {
  const url = new URL(
    provider === "google"
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : `https://www.facebook.com/${config.FACEBOOK_API_VERSION}/dialog/oauth`,
  );
  const id =
    provider === "google" ? config.GOOGLE_CLIENT_ID : config.FACEBOOK_APP_ID;
  const secret =
    provider === "google"
      ? config.GOOGLE_CLIENT_SECRET
      : config.FACEBOOK_APP_SECRET;
  if (!id || !secret) throw new ApiError("disabled");
  url.search = new URLSearchParams({
    client_id: id,
    redirect_uri: `${config.API_URL}/v1/auth/${provider}/callback`,
    response_type: "code",
    state,
    scope:
      provider === "google" ? "openid email profile" : "public_profile,email",
  }).toString();
  if (provider === "google") {
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", verifierChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("prompt", "select_account");
    if (reauthenticate) url.searchParams.set("max_age", "0");
  } else if (reauthenticate)
    url.searchParams.set("auth_type", "reauthenticate");
  return url.toString();
};
export const exchangeProvider = async (
  config: Config,
  provider: "google" | "facebook",
  code: string,
  verifier: string,
  nonce: string,
): Promise<Identity> => {
  const redirect = `${config.API_URL}/v1/auth/${provider}/callback`;
  if (provider === "google") {
    const result = z.object({ id_token: z.string() }).parse(
      await jsonResponse("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.GOOGLE_CLIENT_ID,
          client_secret: config.GOOGLE_CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        }),
      }),
    );
    try {
      const { payload } = await jwtVerify(result.id_token, googleKeys, {
        issuer: ["https://accounts.google.com", "accounts.google.com"],
        audience: config.GOOGLE_CLIENT_ID,
        algorithms: ["RS256"],
        maxTokenAge: "10 minutes",
      });
      if (
        !payload.sub ||
        typeof payload.nonce !== "string" ||
        !equal(payload.nonce, nonce)
      )
        throw new ApiError("unauthenticated");
      return identitySchema.parse({
        provider,
        subject: payload.sub,
        email:
          payload.email_verified === true && typeof payload.email === "string"
            ? payload.email
            : null,
        fullName: typeof payload.name === "string" ? payload.name : null,
      });
    } catch {
      throw new ApiError("unauthenticated");
    }
  }
  const result = z.object({ access_token: z.string() }).parse(
    await jsonResponse(
      `https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.FACEBOOK_APP_ID,
          client_secret: config.FACEBOOK_APP_SECRET,
          redirect_uri: redirect,
          code,
        }),
      },
    ),
  );
  const debugURL = new URL(
    `https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/debug_token`,
  );
  debugURL.searchParams.set("input_token", result.access_token);
  const debug = z
    .object({
      data: z.object({
        is_valid: z.literal(true),
        app_id: z.string(),
        user_id: z.string(),
        expires_at: z.number(),
      }),
    })
    .parse(
      await jsonResponse(debugURL.toString(), {
        headers: {
          Authorization: `Bearer ${config.FACEBOOK_APP_ID}|${config.FACEBOOK_APP_SECRET}`,
        },
      }),
    );
  if (
    debug.data.app_id !== config.FACEBOOK_APP_ID ||
    debug.data.expires_at * 1000 <= Date.now()
  )
    throw new ApiError("unauthenticated");
  const profile = z
    .object({
      id: z.string(),
      name: z.string().optional(),
      email: z.string().optional(),
    })
    .parse(
      await jsonResponse(
        `https://graph.facebook.com/${config.FACEBOOK_API_VERSION}/me?fields=id,name,email`,
        { headers: { Authorization: `Bearer ${result.access_token}` } },
      ),
    );
  if (profile.id !== debug.data.user_id) throw new ApiError("unauthenticated");
  return identitySchema.parse({
    provider,
    subject: profile.id,
    email: profile.email ?? null,
    fullName: profile.name ?? null,
  });
};
export const nativeNonce = (nonce: string) => hash(nonce);
