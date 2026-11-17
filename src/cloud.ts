import { z } from "zod";
import type { App } from "./http.js";
import { ApiError, errors, hash, ownerLock, type Executor } from "./core.js";
import { canonical, saveSchema, type Save } from "./game/save.js";
import { requireSession } from "./sessions.js";

export const writeResult = z.object({
  kind: z.enum(["saved", "conflict"]),
  revision: z.number().int().nonnegative(),
});
export const cloudRow = z.object({
  user_id: z.uuid(),
  schema_version: z.literal(1),
  revision: z.number().int().positive(),
  payload: saveSchema,
  updated_at: z.iso.datetime(),
});
export const writeSave = async (
  tx: Executor,
  owner: string,
  expected: number,
  requestID: string,
  save: Save,
) => {
  const fingerprint = hash(canonical({ expected, save }));
  const [receipt] =
    await tx`select revision, fingerprint from game_save_receipts where user_id=${owner} and request_id=${requestID}`;
  if (receipt) {
    if (receipt.fingerprint !== fingerprint)
      throw new ApiError("idempotency_mismatch");
    return { kind: "saved" as const, revision: Number(receipt.revision) };
  }
  const [current] =
    await tx`select revision from game_saves where user_id=${owner}`;
  const revision = Number(current?.revision ?? 0);
  if (revision !== expected) return { kind: "conflict" as const, revision };
  await tx`insert into game_save_history (user_id, revision, payload) select user_id, revision, payload from game_saves where user_id=${owner}`;
  await tx`insert into game_saves (user_id,revision,payload) values (${owner},${revision + 1},${tx.json(z.json().parse(save))})
    on conflict (user_id) do update set revision=excluded.revision,payload=excluded.payload,updated_at=now()`;
  await tx`insert into game_save_receipts (user_id,request_id,fingerprint,revision) values (${owner},${requestID},${fingerprint},${revision + 1})`;
  await tx`delete from game_save_history where user_id=${owner} and revision < ${revision + 1 - 10}`;
  return { kind: "saved" as const, revision: revision + 1 };
};
export const registerCloud = (app: App) => {
  app.get(
    "/v1/save",
    { schema: { response: { 200: cloudRow.nullable(), ...errors } } },
    async (request) => {
      const session = await requireSession(app, request);
      const [row] =
        await app.db`select user_id, 1 as schema_version, revision::float8 as revision, payload, updated_at from game_saves where user_id=${session.userID}`;
      return row
        ? cloudRow.parse({ ...row, updated_at: row.updated_at.toISOString() })
        : null;
    },
  );
  app.put(
    "/v1/save",
    {
      schema: {
        body: z
          .object({
            expected_revision: z
              .number()
              .int()
              .nonnegative()
              .max(Number.MAX_SAFE_INTEGER - 1),
            request_id: z.uuid(),
            save_payload: saveSchema,
          })
          .strict(),
        response: { 200: writeResult, ...errors },
      },
    },
    async (request) => {
      const session = await requireSession(app, request);
      return app.db.begin(async (tx) => {
        await ownerLock(tx, session.userID);
        return writeSave(
          tx,
          session.userID,
          request.body.expected_revision,
          request.body.request_id,
          request.body.save_payload,
        );
      });
    },
  );
};
