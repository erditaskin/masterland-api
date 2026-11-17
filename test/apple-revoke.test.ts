import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeyPair,
  exportPKCS8,
  exportJWK,
  SignJWT,
  jwtVerify,
} from "jose";
import { parseConfig } from "../src/config.js";
import { ApiError } from "../src/core.js";
import { revokeApple } from "../src/auth/providers.js";

const directory = await mkdtemp(join(tmpdir(), "masterland-apple-contract-"));
await chmod(directory, 0o700);
const client = await generateKeyPair("ES256", { extractable: true });
const apple = await generateKeyPair("RS256", { extractable: true });
const privatePath = join(directory, "synthetic-client.p8");
await writeFile(privatePath, await exportPKCS8(client.privateKey), {
  mode: 0o600,
});
const config = parseConfig({
  NODE_ENV: "test",
  DATABASE_URL:
    "postgres://test:test@127.0.0.1:5442/masterland_test_provider_contract",
  APPLE_KEY_ID: "TESTAPPLEKEY",
  APPLE_TEAM_ID: "TESTTEAM",
  APPLE_PRIVATE_KEY_PATH: privatePath,
});
after(async () => rm(directory, { recursive: true, force: true }));

const provider = async (
  t: TestContext,
  subject = "apple-test-user",
  revokeStatus = 200,
) => {
  const idToken = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-apple-key" })
    .setIssuer("https://appleid.apple.com")
    .setAudience(config.APPLE_CLIENT_ID)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(apple.privateKey);
  const calls = { exchanges: 0, revocations: 0, secretTTL: 0 };
  const fetchProvider: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === "https://appleid.apple.com/auth/keys")
      return Response.json({
        keys: [
          {
            ...(await exportJWK(apple.publicKey)),
            kid: "synthetic-apple-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    const form = new URLSearchParams(String(init?.body ?? ""));
    assert.equal(form.get("client_id"), config.APPLE_CLIENT_ID);
    const verified = await jwtVerify(
      form.get("client_secret") ?? "",
      client.publicKey,
      {
        issuer: config.APPLE_TEAM_ID,
        audience: "https://appleid.apple.com",
        algorithms: ["ES256"],
      },
    );
    assert.equal(verified.protectedHeader.kid, config.APPLE_KEY_ID);
    assert.equal(verified.payload.sub, config.APPLE_CLIENT_ID);
    calls.secretTTL =
      Number(verified.payload.exp) - Number(verified.payload.iat);
    assert(calls.secretTTL > 0 && calls.secretTTL <= 300);
    if (url === "https://appleid.apple.com/auth/token") {
      calls.exchanges++;
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "synthetic-code");
      return Response.json({
        id_token: idToken,
        refresh_token: "synthetic-refresh",
      });
    }
    assert.equal(url, "https://appleid.apple.com/auth/revoke");
    calls.revocations++;
    assert.equal(form.get("token"), "synthetic-refresh");
    assert.equal(form.get("token_type_hint"), "refresh_token");
    return new Response(null, { status: revokeStatus });
  };
  t.mock.method(globalThis, "fetch", fetchProvider);
  return calls;
};

test("Apple revocation exchanges a fresh code and uses a verified short-lived client secret", async (t) => {
  const calls = await provider(t);
  await revokeApple(config, "synthetic-code", "apple-test-user");
  assert.equal(calls.exchanges, 1);
  assert.equal(calls.revocations, 1);
  assert(calls.secretTTL <= 300);
});
test("Apple identity mismatch never revokes the other identity", async (t) => {
  const calls = await provider(t, "different-apple-user");
  await assert.rejects(
    () => revokeApple(config, "synthetic-code", "apple-test-user"),
    (error: unknown) =>
      error instanceof ApiError && error.code === "unauthenticated",
  );
  assert.equal(calls.revocations, 0);
});
test("Apple provider failure cannot be reported as successful revocation", async (t) => {
  const calls = await provider(t, "apple-test-user", 503);
  await assert.rejects(
    () => revokeApple(config, "synthetic-code", "apple-test-user"),
    (error: unknown) =>
      error instanceof ApiError && error.code === "provider_unavailable",
  );
  assert.equal(calls.revocations, 1);
});
