CREATE TABLE "user_devices" (
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"os" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_user_id_device_id_pk" PRIMARY KEY("user_id","device_id"),
	CONSTRAINT "device_os" CHECK ("user_devices"."os" in ('ios','android'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "provider_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;