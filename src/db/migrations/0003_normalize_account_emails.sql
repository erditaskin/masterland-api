UPDATE "users" SET "provider_email" = "email" WHERE "email" IS NOT NULL;
--> statement-breakpoint
WITH ranked AS (
  SELECT "id", row_number() OVER (
    PARTITION BY lower(btrim("email")) ORDER BY "created_at", "id"
  ) AS position
  FROM "users" WHERE "email" IS NOT NULL
)
UPDATE "users" AS u SET "email" = CASE
  WHEN ranked.position = 1 THEN nullif(lower(btrim(u."email")), '')
  ELSE NULL
END
FROM ranked WHERE ranked."id" = u."id";
