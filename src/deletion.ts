import { z } from "zod";
import type { App } from "./http.js";
import { ApiError, errors, hash, ownerLock } from "./core.js";
import { requireSession } from "./sessions.js";
import { revokeApple } from "./auth/providers.js";

const receiptSchema = z.object({
  request_id: z.uuid(),
  status: z.enum(["requested", "processing", "failed", "completed"]),
  auth_deleted: z.boolean(),
});
const capability = z.object({
  request_id: z.uuid(),
  receipt: z.string().regex(/^[0-9a-f]{64}$/),
});
export const registerDeletion = (app: App) => {
  // Capability receipt remains usable after session/account erasure and a lost HTTP response.
  app.post(
    "/v1/account/deletion/status",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        body: capability.strict(),
        response: { 200: receiptSchema, ...errors },
      },
    },
    async (request) => {
      const [row] =
        await app.db`select status from account_deletions where request_id=${request.body.request_id} and receipt_hash=${hash(request.body.receipt)}`;
      if (!row) throw new ApiError("not_found");
      return receiptSchema.parse({
        request_id: request.body.request_id,
        status: row.status,
        auth_deleted: row.status === "completed",
      });
    },
  );
  app.post(
    "/v1/account/deletion",
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: capability
          .extend({
            confirmation: z.literal("DELETE"),
            apple_authorization_code: z.string().max(8192).nullable(),
          })
          .strict(),
        response: { 200: receiptSchema, ...errors },
      },
    },
    async (request) => {
      if (!app.config.ACCOUNT_DELETION_ENABLED) throw new ApiError("disabled");
      const session = await requireSession(app, request);
      // Guests possess no external identity to reauthenticate; the current opaque session and
      // explicit, unique durable receipt authorize only that guest's own erasure.
      if (
        session.kind === "registered" &&
        Date.now() - session.authenticatedAt.getTime() > 240000
      )
        throw new ApiError("reauthentication_required");
      const body = request.body;
      await app.db.begin(async (tx) => {
        await ownerLock(tx, session.userID);
        const [prior] =
          await tx`select request_id,receipt_hash from account_deletions where owner_id=${session.userID} or request_id=${body.request_id}`;
        if (
          prior &&
          (prior.request_id !== body.request_id ||
            prior.receipt_hash !== hash(body.receipt))
        )
          throw new ApiError("conflict");
        if (!prior)
          await tx`insert into account_deletions (request_id,owner_id,receipt_hash) values (${body.request_id},${session.userID},${hash(body.receipt)})`;
      });
      try {
        await app.db.begin(async (tx) => {
          await ownerLock(tx, session.userID);
          const [receipt] =
            await tx`select * from account_deletions where request_id=${body.request_id} and receipt_hash=${hash(body.receipt)} for update`;
          if (!receipt || receipt.owner_id !== session.userID)
            throw new ApiError("forbidden");
          const [apple] =
            await tx`select subject from identities where user_id=${session.userID} and provider='apple'`;
          if (apple && !receipt.apple_revoked_at) {
            if (!body.apple_authorization_code)
              throw new ApiError("reauthentication_required");
            await revokeApple(
              app.config,
              body.apple_authorization_code,
              String(apple.subject),
            );
            await tx`update account_deletions set apple_revoked_at=now() where request_id=${body.request_id}`;
          }
          await tx`update users set status='deleting' where id=${session.userID}`;
          await tx`delete from users where id=${session.userID}`;
          await tx`update account_deletions set status='completed' where request_id=${body.request_id}`;
        });
      } catch (error) {
        await app.db`update account_deletions set status='failed' where request_id=${body.request_id} and status<>'completed'`;
        throw error;
      }
      return {
        request_id: body.request_id,
        status: "completed" as const,
        auth_deleted: true,
      };
    },
  );
};
