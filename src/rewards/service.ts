import { z } from "zod";
import { ApiError, ownerLock, type Executor } from "../core.js";
import { producerCities, saveSchema, type Save } from "../game/save.js";
import { writeSave } from "../cloud.js";
import type { Session } from "../sessions.js";
import type { AdmobReward } from "./signature.js";

export const targetSchema = z
  .object({ city_id: z.string(), producer_id: z.string() })
  .strict();
export const prepareSchema = z
  .object({ request_id: z.uuid(), target: targetSchema.optional() })
  .strict();
export const prepareAd = async (
  tx: Executor,
  session: Session,
  input: z.infer<typeof prepareSchema>,
) => {
  await ownerLock(tx, session.userID);
  const kind = input.target ? "producer" : "energy";
  if (
    input.target &&
    producerCities.get(input.target.producer_id) !== input.target.city_id
  )
    throw new ApiError("validation");
  if (input.target) {
    const [current] =
      await tx`select payload from game_saves where user_id=${session.userID}`;
    const save = saveSchema.safeParse(current?.payload);
    if (
      !save.success ||
      !save.data.cities[input.target.city_id]?.owned.includes(
        input.target.producer_id,
      )
    )
      throw new ApiError("validation");
  }
  const [count] =
    await tx`select count(*)::int as used from ad_rewards where user_id=${session.userID} and reward_day=to_char(now() at time zone 'UTC','YYYY-MM-DD')`;
  const used = Number(count?.used ?? 0);
  const [previous] =
    await tx`select * from ad_intents where user_id=${session.userID} and request_id=${input.request_id}`;
  if (previous) {
    if (
      previous.session_id !== session.id ||
      previous.reward_kind !== kind ||
      previous.city_id !== (input.target?.city_id ?? null) ||
      previous.producer_id !== (input.target?.producer_id ?? null)
    )
      throw new ApiError("idempotency_mismatch");
    const [paid] =
      await tx`select intent_id from ad_rewards where intent_id=${previous.id}`;
    if (
      paid ||
      previous.cancelled_at ||
      new Date(previous.expires_at).getTime() <= Date.now()
    )
      throw new ApiError("conflict");
    return {
      kind: "ready" as const,
      intent_id: String(previous.id),
      used,
      amount: kind === "producer" ? (1 as const) : (25 as const),
    };
  }
  // Reserve distinct intents across devices rather than sharing an existing pending intent.
  const [reserved] =
    await tx`select count(*)::int as count from ad_intents i where user_id=${session.userID} and expires_at>now() and cancelled_at is null
    and not exists (select 1 from ad_rewards r where r.intent_id=i.id)`;
  if (used + Number(reserved?.count ?? 0) >= 4)
    return { kind: "daily_limit" as const, used: 4 as const };
  const [row] =
    await tx`insert into ad_intents (user_id,session_id,request_id,reward_kind,city_id,producer_id,expires_at)
    values (${session.userID},${session.id},${input.request_id},${kind},${input.target?.city_id ?? null},${input.target?.producer_id ?? null},now()+interval '15 minutes') returning id`;
  if (!row) throw new ApiError("internal");
  return {
    kind: "ready" as const,
    intent_id: String(row.id),
    used,
    amount: kind === "producer" ? (1 as const) : (25 as const),
  };
};
export const recordReward = async (tx: Executor, reward: AdmobReward) => {
  // Deleted accounts are acknowledged without recreating data or paying stale callbacks.
  const [user] =
    await tx`select id from users where id=${reward.userID} and status='active'`;
  if (!user) return "account_unavailable";
  await ownerLock(tx, reward.userID);
  const [duplicate] =
    await tx`select transaction_id from ad_rewards where transaction_id=${reward.transactionID} or intent_id=${reward.intentID}`;
  if (duplicate) return "duplicate";
  const [intent] =
    await tx`select * from ad_intents where id=${reward.intentID} and user_id=${reward.userID}`;
  if (
    !intent ||
    intent.reward_kind !== reward.kind ||
    reward.timestamp < new Date(intent.created_at).getTime() - 300000 ||
    reward.timestamp > new Date(intent.expires_at).getTime() + 300000
  )
    return "invalid_intent";
  const day = new Date(reward.timestamp).toISOString().slice(0, 10);
  const [count] =
    await tx`select count(*)::int as used from ad_rewards where user_id=${reward.userID} and reward_day=${day}`;
  if (Number(count?.used ?? 0) >= 4) return "daily_limit";
  // A transaction collision across owners cannot abort a legitimate parallel callback.
  const inserted =
    await tx`insert into ad_rewards (transaction_id,intent_id,user_id,reward_day,amount)
    values (${reward.transactionID},${reward.intentID},${reward.userID},${day},${reward.kind === "producer" ? 1 : 25}) on conflict do nothing returning intent_id`;
  return inserted.length ? "granted" : "duplicate";
};
export const redeemReward = async (
  tx: Executor,
  owner: string,
  intentID: string,
  expected: number,
  before: Save,
) => {
  await ownerLock(tx, owner);
  const [reward] =
    await tx`select r.*, i.reward_kind,i.city_id,i.producer_id from ad_rewards r join ad_intents i on i.id=r.intent_id where r.intent_id=${intentID} and r.user_id=${owner}`;
  if (!reward) return { kind: "pending" as const };
  if (reward.redeemed_at)
    return {
      kind: "already_redeemed" as const,
      revision: Number(reward.redeemed_revision),
    };
  const updated = structuredClone(before);
  if (updated.transactions?.includes(`ad:${intentID}`))
    throw new ApiError("validation");
  if (reward.reward_kind === "producer") {
    const cityID = String(reward.city_id),
      producerID = String(reward.producer_id);
    const city = updated.cities[cityID];
    if (!city?.owned.includes(producerID)) throw new ApiError("validation");
    city.batches[producerID] = { remaining: 80, readyAt: 0 };
  } else {
    updated.stamina += Number(reward.amount);
    if (!Number.isSafeInteger(updated.stamina))
      throw new ApiError("validation");
  }
  updated.transactions = [...(updated.transactions ?? []), `ad:${intentID}`];
  const result = await writeSave(tx, owner, expected, intentID, updated);
  if (result.kind !== "saved") return result;
  await tx`update ad_rewards set redeemed_at=now(),redeemed_revision=${result.revision} where intent_id=${intentID} and user_id=${owner}`;
  return {
    kind: "redeemed" as const,
    revision: result.revision,
    amount: reward.reward_kind === "producer" ? (1 as const) : (25 as const),
    reward_kind: z.enum(["energy", "producer"]).parse(reward.reward_kind),
    city_id: z.string().nullable().parse(reward.city_id),
    producer_id: z.string().nullable().parse(reward.producer_id),
    payload: updated,
  };
};

/** Release a cancelled reservation without erasing metadata needed by a delayed signed callback. */
export const cancelAd = async (
  tx: Executor,
  session: Session,
  intentID: string,
) => {
  await ownerLock(tx, session.userID);
  const rows =
    await tx`update ad_intents set cancelled_at=coalesce(cancelled_at,now())
    where id=${intentID} and user_id=${session.userID} and session_id=${session.id}
    and not exists (select 1 from ad_rewards where intent_id=${intentID}) returning id`;
  return { cancelled: rows.length > 0 };
};
