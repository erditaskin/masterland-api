import { verify, createPublicKey } from "node:crypto";
import { Buffer } from "node:buffer";
export interface AdmobReward {
  transactionID: string;
  userID: string;
  intentID: string;
  timestamp: number;
  adUnit: string;
  kind: "energy" | "producer";
}
/** Verify the original encoded query bytes. Re-encoding query parameters changes the signed message. */
export const verifyAdmobSignature = (
  rawURL: string,
  keys: ReadonlyMap<string, string>,
): URLSearchParams => {
  const raw = new URL(rawURL).search.slice(1);
  if (raw.length > 8192) throw Error("Invalid callback");
  const match = /^(.*)&signature=([A-Za-z0-9_=-]+)&key_id=(\d+)$/.exec(raw);
  if (!match) throw Error("Invalid signature parameters");
  const [, signed, signature, keyID] = match;
  const params = new URLSearchParams(raw);
  for (const key of new Set(params.keys()))
    if (params.getAll(key).length !== 1) throw Error("Duplicate parameter");
  const pem = keys.get(keyID!);
  if (
    !pem ||
    !verify(
      "sha256",
      Buffer.from(signed!, "utf8"),
      createPublicKey(pem),
      Buffer.from(signature!, "base64url"),
    )
  )
    throw Error("Invalid signature");
  return params;
};
export const verifyAdmobCallback = (
  rawURL: string,
  keys: ReadonlyMap<string, string>,
  allowedAdUnit: string,
  now: number,
  producerAdUnit = "",
): AdmobReward => {
  const params = verifyAdmobSignature(rawURL, keys);
  const transactionID = params.get("transaction_id") ?? "";
  const userID = params.get("user_id") ?? "";
  const intentID = params.get("custom_data") ?? "";
  const timestamp = Number(params.get("timestamp"));
  const adUnit = params.get("ad_unit") ?? "";
  // AdMob documents the callback ad_unit as the numeric suffix, not the SDK's full ca-app-pub ID.
  const expectedUnit = allowedAdUnit.split("/").at(-1);
  const producerUnit = producerAdUnit.split("/").at(-1);
  const kind = producerUnit && adUnit === producerUnit ? "producer" : "energy";
  if (
    (kind === "producer" ? adUnit !== producerUnit : adUnit !== expectedUnit) ||
    params.get("reward_amount") !== (kind === "producer" ? "1" : "25") ||
    params.get("reward_item") !==
      (kind === "producer" ? "producer_refresh" : "energy") ||
    !/^[a-f0-9]{16,128}$/i.test(transactionID) ||
    !/^[a-f0-9-]{36}$/i.test(userID) ||
    !/^[a-f0-9-]{36}$/i.test(intentID) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < now - 86400000 ||
    timestamp > now + 300000
  )
    throw Error("Unexpected reward");
  return { transactionID, userID, intentID, timestamp, adUnit, kind };
};
