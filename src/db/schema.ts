import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  primaryKey,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

const date = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().default("guest"),
    status: text("status").notNull().default("active"),
    email: text("email"),
    fullName: text("full_name"),
    createdAt: date("created_at"),
  },
  (t) => [
    check("user_kind", sql`${t.kind} in ('guest','registered')`),
    check("user_status", sql`${t.status} in ('active','deleting')`),
  ],
);
export const identities = pgTable(
  "identities",
  {
    provider: text("provider").notNull(),
    subject: text("subject").notNull(),
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.subject] }),
    index("identities_owner").on(t.userID),
  ],
);
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    authenticatedAt: date("authenticated_at"),
    lastSeenAt: date("last_seen_at"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("sessions_owner").on(t.userID),
    index("sessions_expiry").on(t.expiresAt),
  ],
);
export const oauthAttempts = pgTable(
  "oauth_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    stateHash: text("state_hash").notNull().unique(),
    challenge: text("challenge").notNull(),
    nonce: text("nonce").notNull(),
    providerVerifier: text("provider_verifier").notNull(),
    ownerID: uuid("owner_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    sessionID: uuid("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    reauthenticate: integer("reauthenticate").notNull().default(0),
    verifiedIdentity: jsonb("verified_identity"),
    codeHash: text("code_hash").unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("oauth_expiry").on(t.expiresAt)],
);
export const saves = pgTable(
  "game_saves",
  {
    userID: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    updatedAt: date("updated_at"),
  },
  (t) => [check("save_revision", sql`${t.revision} > 0`)],
);
export const saveReceipts = pgTable(
  "game_save_receipts",
  {
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    requestID: uuid("request_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    revision: bigint("revision", { mode: "number" }).notNull(),
    createdAt: date("created_at"),
  },
  (t) => [primaryKey({ columns: [t.userID, t.requestID] })],
);
export const saveHistory = pgTable(
  "game_save_history",
  {
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    payload: jsonb("payload").notNull(),
    archivedAt: date("archived_at"),
  },
  (t) => [primaryKey({ columns: [t.userID, t.revision] })],
);
export const adIntents = pgTable(
  "ad_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionID: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    requestID: uuid("request_id").notNull(),
    rewardKind: text("reward_kind").notNull(),
    cityID: text("city_id"),
    producerID: text("producer_id"),
    createdAt: date("created_at"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ad_request").on(t.userID, t.requestID),
    index("ad_owner").on(t.userID, t.expiresAt),
  ],
);
export const adRewards = pgTable(
  "ad_rewards",
  {
    transactionID: text("transaction_id").primaryKey(),
    intentID: uuid("intent_id")
      .notNull()
      .unique()
      .references(() => adIntents.id, { onDelete: "cascade" }),
    userID: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rewardDay: text("reward_day").notNull(),
    amount: integer("amount").notNull(),
    grantedAt: date("granted_at"),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedRevision: bigint("redeemed_revision", { mode: "number" }),
  },
  (t) => [index("reward_owner_day").on(t.userID, t.rewardDay)],
);
// Receipt capabilities survive account erasure; they contain no provider identity or save data.
export const deletions = pgTable("account_deletions", {
  requestID: uuid("request_id").primaryKey(),
  ownerID: uuid("owner_id").notNull().unique(),
  receiptHash: text("receipt_hash").notNull(),
  status: text("status").notNull().default("requested"),
  appleRevokedAt: timestamp("apple_revoked_at", { withTimezone: true }),
  createdAt: date("created_at"),
});
