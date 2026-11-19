import { z } from "zod";
import type { App } from "./http.js";
import { ApiError, errors, hash, ownerLock } from "./core.js";
import { requireSession } from "./sessions.js";

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
            apple_authorization_code: z
              .string()
              .max(8192)
              .nullable()
              .optional(),
          })
          .strict(),
        response: { 200: receiptSchema, ...errors },
      },
    },
    async (request) => {
      if (!app.config.ACCOUNT_DELETION_ENABLED) throw new ApiError("disabled");
      const session = await requireSession(app, request);
      const body = request.body;
      await app.db.begin(async (tx) => {
        await ownerLock(tx, session.userID);
        const [receipt] =
          await tx`insert into account_deletions (request_id,owner_id,receipt_hash,status)
          values (${body.request_id},${session.userID},${hash(body.receipt)},'completed')
          on conflict (owner_id) do update set request_id=excluded.request_id,receipt_hash=excluded.receipt_hash,status='completed'
          where account_deletions.status<>'completed' returning request_id`;
        if (!receipt) throw new ApiError("conflict");
        await tx`delete from identities where user_id=${session.userID}`;
        await tx`delete from user_devices where user_id=${session.userID}`;
        await tx`delete from oauth_attempts where owner_id=${session.userID}`;
        await tx`delete from sessions where user_id=${session.userID}`;
        await tx`delete from game_save_receipts where user_id=${session.userID}`;
        await tx`delete from game_save_history where user_id=${session.userID}`;
        await tx`delete from game_saves where user_id=${session.userID}`;
        await tx`update users set deleted=true,status='deleting',email=null,provider_email=null,full_name=null where id=${session.userID}`;
      });
      return {
        request_id: body.request_id,
        status: "completed" as const,
        auth_deleted: true,
      };
    },
  );
};
