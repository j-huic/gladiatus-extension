// Integration test: load the real extension combat modules, build the baseline
// from the sample scrape, and run the full pipeline. Verifies the mirror is fair
// (~0.5) and that the obvious stats (HP from constitution) weigh positive.
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadArena } = require("./stat-weights");

test("real sim: mirror baseline ~0.5, constitution weighs positive", () => {
  const { arena, sim, weights } = loadArena();
  assert.ok(arena && sim && weights, "modules loaded in correct order");

  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/self-profile.sample.json"), "utf8"));
  const character = raw["glad-arena-self-profile-v1"].character;
  assert.ok(arena.combatantReadiness(character).ready, "fixture must be combat-ready");

  const baseline = arena.combatantFromCharacter(character);
  const result = weights.computeStatWeights({ sim, baseline, iterations: 4000, seed: 7 });

  // The name/maxRounds fixes must hold: a same-named mirror would spuriously read ~0.92.
  assert.ok(result.refScore > 0.45 && result.refScore < 0.55, `refScore ${result.refScore}`);
  assert.equal(result.rows.length, 6);
  for (const r of result.rows) assert.ok(Number.isFinite(r.se), `se finite for ${r.stat}`);

  const by = Object.fromEntries(result.rows.map((r) => [r.stat, r.deltaScore]));
  assert.ok(by.constitution > 0, `CON weight ${by.constitution}`);
});
