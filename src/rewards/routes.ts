import { z } from "zod";
import type { App } from "../http.js";
import { ApiError, errors } from "../core.js";
import { saveSchema } from "../game/save.js";
import { requireSession } from "../sessions.js";
import {
  prepareAd,
  cancelAd,
  prepareSchema,
  recordReward,
  redeemReward,
} from "./service.js";
import { verifyAdmobCallback, verifyAdmobSignature } from "./signature.js";

const prepared = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily_limit"), used: z.literal(4) }),
  z.object({
    kind: z.literal("ready"),
    intent_id: z.uuid(),
    used: z.number().int().min(0).max(3),
    amount: z.union([z.literal(1), z.literal(25)]),
  }),
]);
const redemption = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({
    kind: z.enum(["conflict", "already_redeemed"]),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("redeemed"),
    revision: z.number().int().positive(),
    amount: z.union([z.literal(1), z.literal(25)]),
    reward_kind: z.enum(["energy", "producer"]),
    city_id: z.string().nullable(),
    producer_id: z.string().nullable(),
    payload: saveSchema,
  }),
]);
let cached: {
  until: number;
  fetchedAt: number;
  keys: Map<string, string>;
} | null = null;
let loading: Promise<Map<string, string>> | null = null;
const verifierKeys = async (keyID: string): Promise<Map<string, string>> => {
  if (
    cached &&
    cached.until > Date.now() &&
    (cached.keys.has(keyID) || Date.now() - cached.fetchedAt < 60000)
  )
    return cached.keys;
  if (loading) return loading;
  loading = (async () => {
    try {
      const result = await fetch(
        "https://www.gstatic.com/admob/reward/verifier-keys.json",
        { signal: AbortSignal.timeout(5000) },
      );
      if (!result.ok) throw new ApiError("provider_unavailable");
      const body = z
        .object({
          keys: z
            .array(z.object({ keyId: z.number().int(), pem: z.string() }))
            .min(1),
        })
        .parse(await result.json());
      const keys = new Map(
        body.keys.map((key) => [String(key.keyId), key.pem]),
      );
      cached = { until: Date.now() + 3600000, fetchedAt: Date.now(), keys };
      return keys;
    } catch {
      throw new ApiError("provider_unavailable");
    } finally {
      loading = null;
    }
  })();
  return loading;
};
export const registerRewards = (app: App) => {
  app.post(
    "/v1/rewards/prepare",
    { schema: { body: prepareSchema, response: { 200: prepared, ...errors } } },
    async (request) => {
      if (!app.config.ADMOB_SSV_ENABLED) throw new ApiError("disabled");
      const session = await requireSession(app, request);
      return app.db.begin(async (tx) => prepareAd(tx, session, request.body));
    },
  );
  app.post(
    "/v1/rewards/redeem",
    {
      schema: {
        body: z
          .object({
            intent_id: z.uuid(),
            expected_revision: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER - 1),
            save_payload: saveSchema,
          })
          .strict(),
        response: { 200: redemption, ...errors },
      },
    },
    async (request) => {
      if (!app.config.ADMOB_SSV_ENABLED) throw new ApiError("disabled");
      const session = await requireSession(app, request);
      return app.db.begin(async (tx) =>
        redeemReward(
          tx,
          session.userID,
          request.body.intent_id,
          request.body.expected_revision,
          request.body.save_payload,
        ),
      );
    },
  );
  app.post(
    "/v1/rewards/:intentID/cancel",
    {
      schema: {
        params: z.object({ intentID: z.uuid() }),
        response: { 200: z.object({ cancelled: z.boolean() }), ...errors },
      },
    },
    async (request) => {
      if (!app.config.ADMOB_SSV_ENABLED) throw new ApiError("disabled");
      const session = await requireSession(app, request);
      return app.db.begin(async (tx) =>
        cancelAd(tx, session, request.params.intentID),
      );
    },
  );
  app.get(
    "/v1/rewards/pending",
    {
      schema: {
        response: {
          200: z.array(z.object({ intent_id: z.uuid() })),
          ...errors,
        },
      },
    },
    async (request) => {
      const session = await requireSession(app, request);
      const rows =
        await app.db`select intent_id from ad_rewards where user_id=${session.userID} and redeemed_at is null order by granted_at limit 100`;
      return rows.map((r) => ({ intent_id: String(r.intent_id) }));
    },
  );
  app.get(
    "/v1/rewards/:intentID",
    {
      schema: {
        params: z.object({ intentID: z.uuid() }),
        response: { 200: z.object({ redeemed: z.boolean() }), ...errors },
      },
    },
    async (request) => {
      const session = await requireSession(app, request);
      const [row] =
        await app.db`select redeemed_at from ad_rewards where user_id=${session.userID} and intent_id=${request.params.intentID}`;
      return { redeemed: !!row?.redeemed_at };
    },
  );
  app.get(
    "/v1/admob/ssv",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        querystring: z.record(z.string(), z.string()),
        response: { 200: z.object({ status: z.string() }), ...errors },
      },
    },
    async (request) => {
      const rawURL = `${app.config.API_URL}${request.raw.url}`;
      const keys = await verifierKeys(request.query.key_id ?? "");
      if (!app.config.ADMOB_SSV_ENABLED) {
        try {
          verifyAdmobSignature(rawURL, keys);
        } catch {
          throw new ApiError("validation");
        }
        return { status: "verified_rewards_disabled" };
      }
      let reward;
      try {
        reward = verifyAdmobCallback(
          rawURL,
          keys,
          app.config.ADMOB_REWARDED_UNIT_ID,
          Date.now(),
          app.config.ADMOB_PRODUCER_REWARDED_UNIT_ID,
        );
      } catch {
        throw new ApiError("validation");
      }
      const status = await app.db.begin(async (tx) => recordReward(tx, reward));
      return { status };
    },
  );
};
