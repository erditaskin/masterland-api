import { z } from "zod";
import content from "../content.json" with { type: "json" };

export const producerCities = new Map(
  Object.entries(content.producers).map(([id, p]) => [id, p.cityID]),
);
const itemCities = new Map(
  Object.values(content.producers).flatMap((p) =>
    p.items.map((id) => [id, p.cityID] as const),
  ),
);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const item = z.string().refine((id) => itemCities.has(id));
const producer = z.string().refine((id) => producerCities.has(id));
const tile = z.object({ id: z.string().min(1).max(256), item }).passthrough();
const city = z
  .object({
    board: z.array(tile.nullable()).min(54).max(63),
    storage: z.array(tile).max(10000),
    storageCapacity: natural.min(12),
    owned: z.array(producer),
    opened: z.array(item),
    batches: z.record(
      producer,
      z.object({
        remaining: natural.max(80),
        readyAt: z.number().finite().nonnegative(),
      }),
    ),
    powers: z.record(producer, z.number().int().min(1).max(4)).optional(),
    introIndex: natural,
    repeatIndex: natural,
  })
  .passthrough()
  .refine((c) => c.storage.length <= c.storageCapacity);
export const saveSchema = z
  .object({
    schema: z.literal(2),
    progressionVersion: z.literal(2).optional(),
    boardLayoutVersion: z.literal(2).optional(),
    testOnly: z.literal(false).optional(),
    xp: natural,
    gold: natural,
    gems: natural,
    stamina: natural,
    staminaCapacity: natural.min(100).optional(),
    claimedAchievements: z
      .array(z.string().refine((id) => content.achievements.includes(id)))
      .optional(),
    deliveryProgress: z
      .record(
        z.string(),
        z.object({
          ordersByProducerSet: z.record(z.string(), natural),
          items: z.record(item, natural),
        }),
      )
      .optional(),
    energyAt: z.number().finite(),
    discoveries: z.array(item),
    titles: z.array(z.string()),
    mastery: z.record(z.string(), natural),
    cityID: z.string(),
    cities: z.record(z.string(), city),
    sound: z.boolean(),
    reducedMotion: z.boolean(),
    serial: natural,
    rewardQueue: z
      .array(
        z
          .object({
            id: z.string(),
            kind: z.enum(["discovery", "level", "achievement", "purchase"]),
            title: z.string(),
            gold: natural,
            gems: natural,
            energy: natural,
            xp: natural,
            itemID: item.optional(),
          })
          .passthrough(),
      )
      .optional(),
    transactions: z.array(z.string()).max(100000).optional(),
  })
  .passthrough()
  .superRefine((save, ctx) => {
    if (
      Object.values(save.cities).some(
        (citySave) =>
          citySave.board.length !== 63 &&
          !(
            save.boardLayoutVersion === undefined &&
            citySave.board.length === 54
          ),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid board size" });
    const ids = Object.values(save.cities).flatMap((c) =>
      [...c.board.filter((t) => t !== null), ...c.storage].map((t) => t.id),
    );
    if (
      !save.cities[save.cityID] ||
      new Set(ids).size !== ids.length ||
      (save.transactions &&
        new Set(save.transactions).size !== save.transactions.length)
    )
      ctx.addIssue({ code: "custom", message: "Invalid save identities" });
    if (save.deliveryProgress)
      for (const [cityID, progress] of Object.entries(save.deliveryProgress)) {
        if (
          Object.keys(progress.items).some(
            (id) => itemCities.get(id) !== cityID,
          )
        )
          ctx.addIssue({ code: "custom", message: "Invalid delivery city" });
        for (const key of Object.keys(progress.ordersByProducerSet)) {
          try {
            const parsed: unknown = JSON.parse(key);
            if (
              !Array.isArray(parsed) ||
              !parsed.length ||
              !parsed.every(
                (id: unknown) =>
                  typeof id === "string" && producerCities.get(id) === cityID,
              ) ||
              JSON.stringify([...new Set(parsed)].sort()) !== key
            )
              throw Error("Invalid set");
          } catch {
            ctx.addIssue({
              code: "custom",
              message: "Invalid delivery producer set",
            });
          }
        }
      }
  });
export type Save = z.infer<typeof saveSchema>;
// JSONB key order is insignificant; canonicalize before fingerprinting immutable requests.
export const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
};
