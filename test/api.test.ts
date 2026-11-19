import { after, beforeEach, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { parseConfig } from "../src/config.js";
import { connect } from "../src/db/client.js";
import { buildApp, type App } from "../src/http.js";
import { sessionSchema } from "../src/sessions.js";
import { signInIdentity } from "../src/auth/service.js";
import { hash, challenge } from "../src/core.js";
import { saveSchema } from "../src/game/save.js";
import { recordReward } from "../src/rewards/service.js";

const config = parseConfig({
  ...process.env,
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  ADMOB_SSV_ENABLED: "true",
  ACCOUNT_DELETION_ENABLED: "true",
  GOOGLE_CLIENT_ID: "test-client",
  GOOGLE_CLIENT_SECRET: "test-secret",
});
const db = connect(config);
let app: App;
const owners = new Set<string>();
type Login = ReturnType<typeof sessionSchema.parse>;
const fixture = () =>
  saveSchema.parse({
    schema: 2,
    progressionVersion: 2,
    xp: 0,
    gold: 0,
    gems: 0,
    stamina: 100,
    energyAt: 1,
    discoveries: [],
    titles: [],
    mastery: {},
    cityID: "city1",
    cities: {
      city1: {
        board: Array(63).fill(null),
        storage: [],
        storageCapacity: 12,
        owned: ["producer1"],
        opened: ["item1"],
        batches: { producer1: { remaining: 0, readyAt: 999999 } },
        introIndex: 0,
        repeatIndex: 0,
      },
    },
    sound: true,
    reducedMotion: false,
    serial: 0,
  });
const headers = (login: Login) => ({
  authorization: `Bearer ${login.access_token}`,
  "x-masterland-owner": login.user.id,
});
const guest = async () => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/guest",
    payload: { request_id: randomUUID() },
  });
  assert.equal(response.statusCode, 200, response.body);
  const login = sessionSchema.parse(response.json());
  owners.add(login.user.id);
  return login;
};
const write = (
  login: Login,
  revision = 0,
  requestID = randomUUID(),
  save = fixture(),
) =>
  app.inject({
    method: "PUT",
    url: "/v1/save",
    headers: headers(login),
    payload: {
      expected_revision: revision,
      request_id: requestID,
      save_payload: save,
    },
  });
const prepare = async (
  login: Login,
  target?: { city_id: string; producer_id: string },
) => {
  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/prepare",
    headers: headers(login),
    payload: { request_id: randomUUID(), ...(target ? { target } : {}) },
  });
  assert.equal(response.statusCode, 200, response.body);
  const result: unknown = response.json();
  assert(
    result &&
      typeof result === "object" &&
      "intent_id" in result &&
      typeof result.intent_id === "string",
  );
  return result.intent_id;
};
const grant = (
  owner: string,
  intent: string,
  kind: "energy" | "producer" = "energy",
  transactionID = hash(randomUUID()),
) =>
  db.begin(async (tx) =>
    recordReward(tx, {
      userID: owner,
      intentID: intent,
      kind,
      transactionID,
      timestamp: Date.now(),
      adUnit: "2927598891",
    }),
  );
beforeEach(async () => {
  app = await buildApp(config, db);
});
afterEach(async () => {
  await app.close();
});
after(async () => {
  for (const id of owners) {
    await db`delete from users where id=${id}`;
    await db`delete from account_deletions where owner_id=${id}`;
  }
  await db.end();
});
test("health, readiness, default-deny and validation envelopes", async () => {
  assert.equal((await app.inject("/health")).statusCode, 200);
  assert.equal((await app.inject("/ready")).statusCode, 200);
  const response = await app.inject("/v1/save");
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthenticated");
  assert(response.headers["x-request-id"]);
  assert.equal(
    (await app.inject({ method: "POST", url: "/v1/auth/guest", payload: {} }))
      .statusCode,
    422,
  );
  assert.equal(
    (
      await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
});
test("guest session tokens are hashed at rest and logout revokes authority", async () => {
  const login = await guest();
  assert(login.user.is_anonymous);
  const [row] =
    await db`select token_hash from sessions where user_id=${login.user.id}`;
  assert.equal(row?.token_hash, hash(login.access_token));
  await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: headers(login),
    payload: {},
  });
  assert.equal(
    (await app.inject({ url: "/v1/auth/me", headers: headers(login) }))
      .statusCode,
    401,
  );
});
test("cloud owner is session-bound, including an account switch during a pending request", async () => {
  const a = await guest(),
    b = await guest();
  await write(a);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(b) })).json(),
    null,
  );
  assert.equal(
    (
      await app.inject({
        url: "/v1/save",
        headers: { ...headers(b), "x-masterland-owner": a.user.id },
      })
    ).statusCode,
    403,
  );
});
test("concurrent CAS first inserts commit exactly one revision", async () => {
  const login = await guest();
  const responses = await Promise.all([write(login), write(login)]);
  assert.deepEqual(responses.map((r) => r.json().kind).sort(), [
    "conflict",
    "saved",
  ]);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .revision,
    1,
  );
});
test("idempotency accepts exact retry and rejects changed payload for the same request", async () => {
  const login = await guest(),
    id = randomUUID();
  assert.equal((await write(login, 0, id)).json().revision, 1);
  assert.equal((await write(login, 0, id)).json().revision, 1);
  assert.equal(
    (await write(login, 0, id, { ...fixture(), gold: 123 })).statusCode,
    409,
  );
});
test("ten previous snapshots retained and test progress rejected", async () => {
  const login = await guest();
  for (let n = 0; n < 13; n++)
    assert.equal((await write(login, n)).statusCode, 200);
  const [row] =
    await db`select count(*)::int as count from game_save_history where user_id=${login.user.id}`;
  assert.equal(row?.count, 10);
  const response = await app.inject({
    method: "PUT",
    url: "/v1/save",
    headers: headers(login),
    payload: {
      expected_revision: 13,
      request_id: randomUUID(),
      save_payload: { ...fixture(), testOnly: true },
    },
  });
  assert.equal(response.statusCode, 422);
});
test("new identity promotes guest with its save and does not link matching email", async () => {
  const login = await guest();
  await write(login);
  const subject = randomUUID(),
    email = "same@example.test";
  const [session] =
    await db`select id from sessions where token_hash=${hash(login.access_token)}`;
  const promoted = await db.begin(async (tx) =>
    signInIdentity(
      tx,
      config,
      { provider: "google", subject, email, fullName: "Player" },
      {
        id: String(session?.id),
        userID: login.user.id,
        kind: "guest",
        authenticatedAt: new Date(),
      },
      false,
    ),
  );
  assert.equal(promoted.user.id, login.user.id);
  assert.equal(promoted.user.is_anonymous, false);
  assert.equal(
    (await app.inject({ url: "/v1/auth/me", headers: headers(login) }))
      .statusCode,
    401,
  );
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(promoted) })).json()
      .revision,
    1,
  );
  const other = await db.begin(async (tx) =>
    signInIdentity(
      tx,
      config,
      {
        provider: "facebook",
        subject: randomUUID(),
        email,
        fullName: "Player",
      },
      null,
      false,
    ),
  );
  owners.add(other.user.id);
  assert.notEqual(other.user.id, promoted.user.id);
});
test("guest login to an existing identity preserves both distinct saves for explicit client choice", async () => {
  const subject = randomUUID();
  const existing = await db.begin(async (tx) =>
    signInIdentity(
      tx,
      config,
      { provider: "google", subject, email: null, fullName: null },
      null,
      false,
    ),
  );
  owners.add(existing.user.id);
  const login = await guest();
  await write(login, 0, randomUUID(), { ...fixture(), gold: 60 });
  await write(existing, 0, randomUUID(), { ...fixture(), gold: 90 });
  const [s] =
    await db`select id from sessions where token_hash=${hash(login.access_token)}`;
  const signed = await db.begin(async (tx) =>
    signInIdentity(
      tx,
      config,
      { provider: "google", subject, email: null, fullName: null },
      {
        id: String(s?.id),
        userID: login.user.id,
        kind: "guest",
        authenticatedAt: new Date(),
      },
      false,
    ),
  );
  assert.equal(signed.user.id, existing.user.id);
  const rows =
    await db`select payload from game_saves where user_id in (${login.user.id},${existing.user.id})`;
  assert.deepEqual(
    rows.map((r) => saveSchema.parse(r.payload).gold).sort(),
    [60, 90],
  );
});
test("OAuth cancellation does not promote or erase guest state", async () => {
  const login = await guest();
  await write(login);
  const start = await app.inject({
    method: "POST",
    url: "/v1/auth/oauth/start",
    headers: headers(login),
    payload: { provider: "google", code_challenge: challenge("v".repeat(43)) },
  });
  assert.equal(start.statusCode, 200, start.body);
  const response = await app.inject(
    `/v1/auth/google/callback?state=${start.json().state}&error=access_denied`,
  );
  assert.equal(response.statusCode, 302);
  assert(String(response.headers.location).includes("error=access_denied"));
  assert(
    String(response.headers.location).endsWith("#"),
    "An explicit empty fragment prevents inheritance from the provider redirect",
  );
  assert.equal(
    (await app.inject({ url: "/v1/auth/me", headers: headers(login) })).json()
      .is_anonymous,
    true,
  );
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .revision,
    1,
  );
});
test("OAuth exchange binds state, PKCE, original session and one-use code", async () => {
  const a = await guest(),
    b = await guest(),
    verifier = "v".repeat(43),
    state = "s".repeat(43),
    code = "c".repeat(43);
  await db`insert into oauth_attempts (provider,state_hash,challenge,nonce,provider_verifier,owner_id,session_id,verified_identity,code_hash,expires_at)
    select 'google',${hash(state)},${challenge(verifier)},'n','v',${a.user.id},id,${db.json({ provider: "google", subject: randomUUID(), email: null, fullName: null })},${hash(code)},now()+interval '2 minutes' from sessions where token_hash=${hash(a.access_token)}`;
  const exchange = (login: Login, v = verifier) =>
    app.inject({
      method: "POST",
      url: "/v1/auth/oauth/exchange",
      headers: headers(login),
      payload: { code, state, code_verifier: v },
    });
  assert.equal((await exchange(b)).statusCode, 401);
  assert.equal((await exchange(a, "x".repeat(43))).statusCode, 401);
  assert.equal((await exchange(a)).statusCode, 200);
  assert.equal((await exchange(a)).statusCode, 401);
});
test("SSV duplicates and simultaneous redemption pay energy once", async () => {
  const login = await guest();
  await write(login);
  const id = await prepare(login);
  const transaction = hash(randomUUID());
  assert.deepEqual(
    (
      await Promise.all([
        grant(login.user.id, id, "energy", transaction),
        grant(login.user.id, id, "energy", transaction),
      ])
    ).sort(),
    ["duplicate", "granted"],
  );
  const redeem = () =>
    app.inject({
      method: "POST",
      url: "/v1/rewards/redeem",
      headers: headers(login),
      payload: { intent_id: id, expected_revision: 1, save_payload: fixture() },
    });
  const responses = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(responses.map((r) => r.json().kind).sort(), [
    "already_redeemed",
    "redeemed",
  ]);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .payload.stamina,
    125,
  );
});
test("CAS conflict and invalid reward snapshot do not consume verified entitlement", async () => {
  const login = await guest();
  await write(login);
  const id = await prepare(login);
  await grant(login.user.id, id);
  const conflict = await app.inject({
    method: "POST",
    url: "/v1/rewards/redeem",
    headers: headers(login),
    payload: { intent_id: id, expected_revision: 0, save_payload: fixture() },
  });
  assert.equal(conflict.json().kind, "conflict");
  const pending = await app.inject({
    url: "/v1/rewards/pending",
    headers: headers(login),
  });
  assert.deepEqual(pending.json(), [{ intent_id: id }]);
  const wrong = await guest();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/rewards/redeem",
        headers: headers(wrong),
        payload: {
          intent_id: id,
          expected_revision: 0,
          save_payload: fixture(),
        },
      })
    ).json().kind,
    "pending",
  );
});
test("producer reward is target-bound and leaves energy unchanged", async () => {
  const login = await guest();
  await write(login);
  const id = await prepare(login, {
    city_id: "city1",
    producer_id: "producer1",
  });
  assert.equal(await grant(login.user.id, id, "energy"), "invalid_intent");
  await grant(login.user.id, id, "producer");
  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/redeem",
    headers: headers(login),
    payload: { intent_id: id, expected_revision: 1, save_payload: fixture() },
  });
  assert.equal(response.json().payload.stamina, 100);
  assert.deepEqual(response.json().payload.cities.city1.batches.producer1, {
    remaining: 80,
    readyAt: 0,
  });
});
test("two devices never receive the same ad intent; concurrent reservations cap at four", async () => {
  const login = await guest();
  const second = await app.inject({
    method: "POST",
    url: "/v1/auth/guest",
    headers: headers(login),
    payload: { request_id: randomUUID() },
  });
  const other = sessionSchema.parse(second.json());
  const ids = await Promise.all([
    prepare(login),
    prepare(other),
    prepare(login),
    prepare(other),
  ]);
  assert.equal(new Set(ids).size, 4);
  const response = await app.inject({
    method: "POST",
    url: "/v1/rewards/prepare",
    headers: headers(login),
    payload: { request_id: randomUUID() },
  });
  assert.equal(response.json().kind, "daily_limit");
});
test("expired intent metadata is rejected, but a valid late callback is recoverable after logout", async () => {
  const login = await guest();
  const id = await prepare(login);
  await app.inject({
    method: "POST",
    url: "/v1/auth/logout",
    headers: headers(login),
    payload: {},
  });
  assert.equal(await grant(login.user.id, id), "granted");
  const expired = await guest();
  const old = await prepare(expired);
  await db`update ad_intents set expires_at=now()-interval '1 hour' where id=${old}`;
  assert.equal(await grant(expired.user.id, old), "invalid_intent");
});
test("guest erasure removes all owned state and receipt recovers a lost response", async () => {
  const login = await guest();
  await write(login);
  const intent = await prepare(login);
  await grant(login.user.id, intent);
  const payload = {
    request_id: randomUUID(),
    receipt: hash(randomUUID()),
    confirmation: "DELETE",
    apple_authorization_code: null,
  };
  const deleted = await app.inject({
    method: "POST",
    url: "/v1/account/deletion",
    headers: headers(login),
    payload,
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).statusCode,
    401,
  );
  const recovered = await app.inject({
    method: "POST",
    url: "/v1/account/deletion/status",
    payload: { request_id: payload.request_id, receipt: payload.receipt },
  });
  assert.equal(recovered.json().auth_deleted, true);
  const wrong = await app.inject({
    method: "POST",
    url: "/v1/account/deletion/status",
    payload: { request_id: payload.request_id, receipt: hash("wrong") },
  });
  assert.equal(wrong.statusCode, 404);
  assert.equal(await grant(login.user.id, intent), "account_unavailable");
});
test("Masterland deletion deactivates the old owner and the same provider creates a fresh account", async () => {
  const device = { id: randomUUID(), os: "ios" as const };
  const identity = {
    provider: "apple" as const,
    subject: randomUUID(),
    email: `${randomUUID()}@example.test`,
    fullName: "Test Player",
  };
  const signIn = () =>
    db.begin((tx) => signInIdentity(tx, config, identity, null, false, device));
  const original = await signIn();
  owners.add(original.user.id);
  await write(original);
  const deletion = await app.inject({
    method: "POST",
    url: "/v1/account/deletion",
    headers: headers(original),
    payload: {
      request_id: randomUUID(),
      receipt: hash(randomUUID()),
      confirmation: "DELETE",
    },
  });
  assert.equal(deletion.statusCode, 200, deletion.body);
  const [tombstone] =
    await db`select deleted,email from users where id=${original.user.id}`;
  assert.equal(tombstone?.deleted, true);
  assert.equal(tombstone?.email, null);
  for (const table of [
    "game_saves",
    "user_devices",
    "sessions",
    "identities",
  ]) {
    assert.equal(
      (await db`select 1 from ${db(table)} where user_id=${original.user.id}`)
        .length,
      0,
    );
  }
  assert.equal(
    (await app.inject({ url: "/v1/auth/me", headers: headers(original) }))
      .statusCode,
    401,
  );
  const fresh = await signIn();
  owners.add(fresh.user.id);
  assert.notEqual(fresh.user.id, original.user.id);
  assert.equal(fresh.user.email, identity.email);
  const [record] =
    await db`select os from user_devices where user_id=${fresh.user.id} and device_id=${device.id}`;
  assert.equal(record?.os, "ios");
});

test("guest and existing sessions record devices for their authenticated owner", async () => {
  const deviceID = randomUUID();
  const deviceHeaders = {
    "x-masterland-device-id": deviceID,
    "x-masterland-device-os": "ios",
  };
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/guest",
    headers: deviceHeaders,
    payload: { request_id: randomUUID() },
  });
  assert.equal(response.statusCode, 200, response.body);
  const login = sessionSchema.parse(response.json());
  owners.add(login.user.id);
  assert.equal(login.user.is_anonymous, true);
  const secondID = randomUUID();
  const me = await app.inject({
    url: "/v1/auth/me",
    headers: {
      ...headers(login),
      ...deviceHeaders,
      "x-masterland-device-id": secondID,
    },
  });
  assert.equal(me.statusCode, 200, me.body);
  const records =
    await db`select device_id,os from user_devices where user_id=${login.user.id}`;
  assert.deepEqual(
    new Set(records.map((row) => row.device_id)),
    new Set([deviceID, secondID]),
  );
  assert(records.every((row) => row.os === "ios"));
});

test("session and device timestamps refresh only after their five-minute window", async () => {
  const login = await guest();
  const deviceID = randomUUID();
  const read = () =>
    app.inject({
      url: "/v1/auth/me",
      headers: {
        ...headers(login),
        "x-masterland-device-id": deviceID,
        "x-masterland-device-os": "ios",
      },
    });
  assert.equal((await read()).statusCode, 200);
  const stamps =
    () => db`select s.last_seen_at as session_time,d.last_seen_at as device_time
    from sessions s join user_devices d on d.user_id=s.user_id where s.user_id=${login.user.id}`;
  const [initial] = await stamps();
  assert.equal((await read()).statusCode, 200);
  assert.deepEqual((await stamps())[0], initial);
  await db`update sessions set last_seen_at=now()-interval '6 minutes' where user_id=${login.user.id}`;
  await db`update user_devices set last_seen_at=now()-interval '6 minutes' where user_id=${login.user.id}`;
  assert.equal((await read()).statusCode, 200);
  const [refreshed] = await stamps();
  assert(new Date(refreshed?.session_time) > new Date(initial?.session_time));
  assert(new Date(refreshed?.device_time) > new Date(initial?.device_time));
});

test("registered erasure replaces a failed attempt with one valid-session request", async () => {
  const login = await db.begin(async (tx) =>
    signInIdentity(
      tx,
      config,
      {
        provider: "google",
        subject: randomUUID(),
        email: null,
        fullName: null,
      },
      null,
      false,
    ),
  );
  owners.add(login.user.id);
  await db`update sessions set authenticated_at=now()-interval '1 hour' where user_id=${login.user.id}`;
  await db`insert into account_deletions (request_id,owner_id,receipt_hash,status)
    values (${randomUUID()},${login.user.id},${hash(randomUUID())},'failed')`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/account/deletion",
    headers: headers(login),
    payload: {
      request_id: randomUUID(),
      receipt: hash(randomUUID()),
      confirmation: "DELETE",
      apple_authorization_code: null,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().auth_deleted, true);
});

test("signed SSV HTTP callbacks remain gated, reject tampering and persist exactly one reward", async (t) => {
  const login = await guest();
  await write(login);
  const id = await prepare(login);
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    assert.equal(
      String(input),
      "https://www.gstatic.com/admob/reward/verifier-keys.json",
    );
    return Response.json({
      keys: [
        {
          keyId: 20261117,
          pem: publicKey.export({ type: "spki", format: "pem" }),
        },
      ],
    });
  });
  const query = new URLSearchParams({
    ad_network: "5450213213286189855",
    ad_unit: "2927598891",
    custom_data: id,
    reward_amount: "25",
    reward_item: "energy",
    timestamp: String(Date.now()),
    transaction_id: hash(randomUUID()),
    user_id: login.user.id,
  }).toString();
  const signature = sign("sha256", Buffer.from(query), privateKey).toString(
    "base64url",
  );
  const url = `/v1/admob/ssv?${query}&signature=${signature}&key_id=20261117`;
  const redeem = () =>
    app.inject({
      method: "POST",
      url: "/v1/rewards/redeem",
      headers: headers(login),
      payload: { intent_id: id, expected_revision: 1, save_payload: fixture() },
    });
  assert.equal((await redeem()).json().kind, "pending");
  const closed = await buildApp({ ...config, ADMOB_SSV_ENABLED: false }, db);
  try {
    assert.equal(
      (await closed.inject(url)).json().status,
      "verified_rewards_disabled",
    );
    assert.equal((await redeem()).json().kind, "pending");
  } finally {
    await closed.close();
  }
  assert.equal(
    (await app.inject(url.replace("reward_amount=25", "reward_amount=250")))
      .statusCode,
    422,
  );
  assert.equal((await redeem()).json().kind, "pending");
  const callbacks = await Promise.all([app.inject(url), app.inject(url)]);
  assert.deepEqual(callbacks.map((r) => r.json().status).sort(), [
    "duplicate",
    "granted",
  ]);
  const redemptions = await Promise.all([redeem(), redeem()]);
  assert.deepEqual(redemptions.map((r) => r.json().kind).sort(), [
    "already_redeemed",
    "redeemed",
  ]);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .payload.stamina,
    125,
  );
  assert.equal((await app.inject(url)).json().status, "duplicate");
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .payload.stamina,
    125,
  );
});

test("cancelled ads release reservations without paying or losing late signed rewards", async () => {
  const login = await guest();
  const other = await guest();
  await write(login);
  const ids = await Promise.all(
    Array.from({ length: 4 }, () => prepare(login)),
  );
  const cancel = (who: Login, id: string) =>
    app.inject({
      method: "POST",
      url: `/v1/rewards/${id}/cancel`,
      headers: headers(who),
    });
  assert.equal((await cancel(other, ids[0]!)).json().cancelled, false);
  assert.equal((await cancel(login, ids[0]!)).json().cancelled, true);
  assert.equal((await cancel(login, ids[0]!)).json().cancelled, true);
  const replacement = await prepare(login);
  assert.notEqual(replacement, ids[0]);
  assert.equal(
    (await app.inject({ url: "/v1/save", headers: headers(login) })).json()
      .payload.stamina,
    100,
  );
  assert.equal(await grant(login.user.id, ids[0]!, "energy"), "granted");
  assert.equal((await cancel(login, ids[0]!)).json().cancelled, false);
  const receipt = await app.inject({
    method: "POST",
    url: "/v1/rewards/redeem",
    headers: headers(login),
    payload: {
      intent_id: ids[0],
      expected_revision: 1,
      save_payload: fixture(),
    },
  });
  assert.equal(receipt.json().kind, "redeemed");
  assert.equal(receipt.json().payload.stamina, 125);
});
