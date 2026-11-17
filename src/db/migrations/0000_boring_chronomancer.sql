CREATE TABLE "ad_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"reward_kind" text NOT NULL,
	"city_id" text,
	"producer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ad_rewards" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reward_day" text NOT NULL,
	"amount" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone,
	"redeemed_revision" bigint,
	CONSTRAINT "ad_rewards_intent_id_unique" UNIQUE("intent_id")
);
--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"receipt_hash" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"apple_revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletions_owner_id_unique" UNIQUE("owner_id")
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"provider" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "identities_provider_subject_pk" PRIMARY KEY("provider","subject")
);
--> statement-breakpoint
CREATE TABLE "oauth_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"nonce" text NOT NULL,
	"provider_verifier" text NOT NULL,
	"owner_id" uuid,
	"session_id" uuid,
	"reauthenticate" integer DEFAULT 0 NOT NULL,
	"verified_identity" jsonb,
	"code_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "oauth_attempts_state_hash_unique" UNIQUE("state_hash"),
	CONSTRAINT "oauth_attempts_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "game_save_history" (
	"user_id" uuid NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_save_history_user_id_revision_pk" PRIMARY KEY("user_id","revision")
);
--> statement-breakpoint
CREATE TABLE "game_save_receipts" (
	"user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"revision" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_save_receipts_user_id_request_id_pk" PRIMARY KEY("user_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "game_saves" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "save_revision" CHECK ("game_saves"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"authenticated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'guest' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"email" text,
	"full_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_kind" CHECK ("users"."kind" in ('guest','registered')),
	CONSTRAINT "user_status" CHECK ("users"."status" in ('active','deleting'))
);
--> statement-breakpoint
ALTER TABLE "ad_intents" ADD CONSTRAINT "ad_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_intents" ADD CONSTRAINT "ad_intents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_rewards" ADD CONSTRAINT "ad_rewards_intent_id_ad_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."ad_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_rewards" ADD CONSTRAINT "ad_rewards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_attempts" ADD CONSTRAINT "oauth_attempts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_attempts" ADD CONSTRAINT "oauth_attempts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_save_history" ADD CONSTRAINT "game_save_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_save_receipts" ADD CONSTRAINT "game_save_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_saves" ADD CONSTRAINT "game_saves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_request" ON "ad_intents" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "ad_owner" ON "ad_intents" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "reward_owner_day" ON "ad_rewards" USING btree ("user_id","reward_day");--> statement-breakpoint
CREATE INDEX "identities_owner" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "oauth_expiry" ON "oauth_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_owner" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry" ON "sessions" USING btree ("expires_at");