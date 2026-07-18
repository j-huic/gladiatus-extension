// Unit tests for the portable stat-weight core. The core is a globalThis IIFE
// (browser style), so we vm-load it like the extension modules and inject a
// deterministic fake sim — no dependency on arena-sim here.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const assert = require("node:assert/strict");

function loadCore() {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "stat-weights-core.js"), "utf8"), ctx, {
    filename: "stat-weights-core.js",
  });
  return ctx.GladiatusStatWeights;
}

const W = loadCore();
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

function baseCombatant() {
  return {
    name: "Test", level: 42,
    strength: 100, dexterity: 80, agility: 60,
    constitution: 120, charisma: 40, intelligence: 50,
    damageMin: 200, damageMax: 300, maxHp: 3000, hp: 3000,
    critChance: 10, blockChance: 8, critAvoidChance: 5,
    armourAbsorbMin: 10, armourAbsorbMax: 20,
  };
}

const SCALE_L42 = 52 / (42 - 8);

test("mulberry32 is deterministic per seed and ranges in [0,1)", () => {
  const a = W.mulberry32(12345);
  const b = W.mulberry32(12345);
  const seqA = [a(), a(), a()];
  assert.deepEqual(seqA, [b(), b(), b()]);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  assert.notEqual(W.mulberry32(99999)(), seqA[0]);
});

test("STR bump: +1 damage and +blockChance per 10 points; original untouched", () => {
  const base = baseCombatant();
  const c = W.bumpCombatant(base, "strength", 10); // floor(110/10)-floor(100/10) = 1
  assert.equal(c.strength, 110);
  assert.equal(c.damageMin, 201);
  assert.equal(c.damageMax, 301);
  approx(c.blockChance, 8 + (1 * SCALE_L42) / 6);
  assert.equal(c.critChance, 10);
  assert.equal(base.strength, 100); // immutability
  assert.equal(base.damageMax, 300);
});

test("DEX bump: +critChance only", () => {
  const c = W.bumpCombatant(baseCombatant(), "dexterity", 10);
  assert.equal(c.dexterity, 90);
  approx(c.critChance, 10 + (1 * SCALE_L42) / 5);
  assert.equal(c.damageMax, 300);
});

test("AGI bump: +critAvoidChance only", () => {
  const c = W.bumpCombatant(baseCombatant(), "agility", 10);
  assert.equal(c.agility, 70);
  approx(c.critAvoidChance, 5 + (1 * SCALE_L42) / 4);
});

test("CON bump: +25 HP per point, hp tracks maxHp", () => {
  const c = W.bumpCombatant(baseCombatant(), "constitution", 10);
  assert.equal(c.constitution, 130);
  assert.equal(c.maxHp, 3250);
  assert.equal(c.hp, 3250);
});

test("CHA/INT bump: only the raw field changes", () => {
  const cha = W.bumpCombatant(baseCombatant(), "charisma", 10);
  assert.equal(cha.charisma, 50);
  assert.equal(cha.damageMax, 300);
  const int = W.bumpCombatant(baseCombatant(), "intelligence", 10);
  assert.equal(int.intelligence, 60);
  assert.equal(int.maxHp, 3000);
});

test("chances saturate at cap; below level 9 chance stays put", () => {
  const capped = W.bumpCombatant({ ...baseCombatant(), critChance: 49.9 }, "dexterity", 100);
  assert.equal(capped.critChance, 50);
  const lowLevel = W.bumpCombatant({ ...baseCombatant(), level: 8 }, "strength", 10);
  assert.equal(lowLevel.blockChance, 8); // scale 0 below level 9
  assert.equal(lowLevel.damageMax, 301); // damage still applies
});

// Deterministic fake sim: draws exactly one random() per battle (so the per-battle
// CRN pairing is exact) and wins with probability rising in the attacker's
// damageMax + maxHp lead. STR (+1 dmg) and CON (+250 hp) move it; others don't.
const fakeSim = {
  simulateBattle(attacker, defender, opts) {
    const roll = opts.random();
    const adv = (attacker.damageMax - defender.damageMax) + (attacker.maxHp - defender.maxHp) / 100;
    const pWin = Math.max(0, Math.min(1, 0.5 + adv * 0.01));
    return { outcome: roll < pWin ? "attacker_wins" : "defender_wins" };
  },
};

test("computeStatWeights: CRN pairing, ranking, error bars, normalization", () => {
  const result = W.computeStatWeights({ sim: fakeSim, baseline: baseCombatant(), n: 10, iterations: 20000, seed: 7 });
  const by = Object.fromEntries(result.rows.map((r) => [r.stat, r]));

  assert.ok(result.refScore > 0.49 && result.refScore < 0.51, `refScore ${result.refScore}`);
  assert.equal(result.rows.length, 6);

  // STR: +1 damageMax -> adv 1 -> pWin 0.51 -> delta ~0.01
  assert.ok(by.strength.deltaScore > 0.006 && by.strength.deltaScore < 0.016, `STR ${by.strength.deltaScore}`);
  // CON: +250 maxHp -> adv 2.5 -> pWin 0.525 -> delta ~0.025
  assert.ok(by.constitution.deltaScore > 0.018 && by.constitution.deltaScore < 0.032, `CON ${by.constitution.deltaScore}`);
  // Stats the fake sim ignores are perfectly paired -> exactly zero, zero SE.
  assert.equal(by.dexterity.deltaScore, 0);
  assert.equal(by.dexterity.se, 0);
  assert.equal(by.dexterity.flipRate, 0);
  assert.equal(by.intelligence.deltaScore, 0);

  assert.equal(result.rows[0].stat, "constitution"); // sorted descending
  assert.ok(result.rows.findIndex((r) => r.stat === "constitution") < result.rows.findIndex((r) => r.stat === "strength"));
  approx(by.constitution.normalized, 1);
  assert.ok(by.strength.se > 0, "STR has real sampling error");
});

test("formatWeightsTable renders header meta and one line per stat", () => {
  const result = W.computeStatWeights({ sim: fakeSim, baseline: baseCombatant(), n: 10, iterations: 2000, seed: 5 });
  const text = W.formatWeightsTable(result, { name: "Testus", level: 42 });
  assert.match(text, /Testus/);
  assert.match(text, /level 42/);
  assert.match(text, /mirror baseline 0\.5/);
  for (const stat of W.STAT_KEYS) assert.match(text, new RegExp(stat));
});
