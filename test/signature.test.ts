import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  verifyAdmobCallback,
  verifyAdmobSignature,
} from "../src/rewards/signature.js";
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const keys = new Map([
  ["123", publicKey.export({ format: "pem", type: "spki" }).toString()],
]);
const now = 1700000000000,
  unit = "ca-app-pub-2972187520207492/2927598891";
function callback(extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    ad_network: "1",
    ad_unit: "2927598891",
    custom_data: "00000000-0000-4000-8000-000000000001",
    reward_amount: "25",
    reward_item: "energy",
    timestamp: String(now),
    transaction_id: "0123456789abcdef",
    user_id: "00000000-0000-4000-8000-000000000002",
    ...extra,
  });
  const raw = params.toString();
  return (
    "https://example.test/ssv?" +
    raw +
    "&signature=" +
    sign("sha256", Buffer.from(raw), privateKey).toString("base64url") +
    "&key_id=123"
  );
}
test("SSV verifies original query bytes with a trusted ECDSA key", () => {
  const result = verifyAdmobCallback(callback(), keys, unit, now);
  assert.equal(result.transactionID, "0123456789abcdef");
});
test("SSV rejects tampering, wrong unit/reward, expiry, key mismatch and duplicate parameters", () => {
  for (const url of [
    callback().replace("reward_amount=25", "reward_amount=250"),
    callback({ ad_unit: "123" }),
    callback({ reward_amount: "16" }),
    callback({ reward_item: "coins" }),
    callback({ timestamp: String(now - 86400001) }),
    callback().replace("key_id=123", "key_id=456"),
    callback().replace("ad_network=1", "ad_network=1&ad_network=2"),
  ])
    assert.throws(() => verifyAdmobCallback(url, keys, unit, now));
});

test("console sample metadata passes signature verification but cannot pass production reward validation", () => {
  const sample = callback({
    ad_unit: "1234567890",
    transaction_id: "123456789",
  });
  assert.equal(verifyAdmobSignature(sample, keys).get("ad_unit"), "1234567890");
  assert.throws(() => verifyAdmobCallback(sample, keys, unit, now));
});

test("producer ad signatures cannot masquerade as energy rewards", () => {
  const producerUnit = "ca-app-pub-2972187520207492/1111111111";
  const valid = callback({
    ad_unit: "1111111111",
    reward_amount: "1",
    reward_item: "producer_refresh",
  });
  assert.equal(
    verifyAdmobCallback(valid, keys, unit, now, producerUnit).kind,
    "producer",
  );
  assert.throws(() => verifyAdmobCallback(valid, keys, unit, now));
  assert.throws(() =>
    verifyAdmobCallback(
      callback({ ad_unit: "1111111111" }),
      keys,
      unit,
      now,
      producerUnit,
    ),
  );
});
