import { test } from "node:test";
import assert from "node:assert/strict";
import { saveSchema } from "../src/game/save.js";

const fixture = (cells: number) => ({
  schema: 2,
  boardLayoutVersion: 2,
  progressionVersion: 2,
  xp: 0,
  gold: 0,
  gems: 0,
  stamina: 100,
  serial: 0,
  energyAt: 1,
  discoveries: [],
  titles: [],
  mastery: {},
  cityID: "city1",
  sound: true,
  reducedMotion: false,
  cities: {
    city1: {
      board: Array(cells).fill(null),
      storage: [],
      storageCapacity: 12,
      owned: ["producer1"],
      opened: ["item1", "item2"],
      batches: {},
      introIndex: 0,
      repeatIndex: 0,
    },
  },
});

test("the clean-start save contract accepts exactly 63 cells", () => {
  assert.equal(saveSchema.parse(fixture(63)).cities.city1!.board.length, 63);
  for (const count of [49, 54, 56, 62, 64, 70])
    assert.equal(saveSchema.safeParse(fixture(count)).success, false);
});

test("unversioned legacy cloud saves can still be read and written", () => {
  const { boardLayoutVersion, ...save } = fixture(54);
  assert.equal(boardLayoutVersion, 2);
  assert.equal(saveSchema.parse(save).cities.city1!.board.length, 54);
});

test("Badınca saves accept the candy producer and all seven tiers", () => {
  const save = fixture(63);
  const items = Array.from({ length: 7 }, (_, index) => "item" + (160 + index));
  const badinca = {
    ...fixture(63).cities.city1,
    owned: ["producer14"],
    opened: items,
    board: [
      ...items.map((item, index) => ({ id: "candy-" + index, item })),
      ...Array(56).fill(null),
    ],
  };
  const result = saveSchema.safeParse({
    ...save,
    cityID: "city2",
    cities: { ...save.cities, city2: badinca },
    discoveries: items,
  });
  assert.equal(result.success, true);
});

test("cloud saves accept progress across the newer three cities", () => {
  const save = fixture(63);
  const cities = {
    ...save.cities,
    city3: {
      ...fixture(63).cities.city1,
      owned: ["producer17"],
      opened: ["item217"],
      storage: [{ id: "harbor", item: "item217" }],
    },
    city4: {
      ...fixture(63).cities.city1,
      owned: ["producer22"],
      opened: ["item248"],
      storage: [{ id: "forge", item: "item248" }],
    },
    city5: {
      ...fixture(63).cities.city1,
      owned: ["producer27"],
      opened: ["item282"],
      storage: [{ id: "bazaar", item: "item282" }],
    },
  };
  const result = saveSchema.safeParse({
    ...save,
    cities,
    cityID: "city5",
    discoveries: ["item217", "item248", "item282"],
    claimedAchievements: ["city3-delivery-rank6", "city5-delivery-rank6"],
  });
  assert.equal(result.success, true);
});
