# Stat-Weight Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node CLI that ranks the six primary stats by per-point combat value, by bumping each stat on the player's real scraped build and Monte-Carlo simming the bumped build against an unbumped mirror of itself.

**Architecture:** A pure, injectable core (`stat-weights-core.js`) holding the seeded PRNG, the marginal-stat deriver, the weight runner, and the reporter. A thin CLI (`stat-weights.js`) loads the existing extension modules (`arena-core.js`, `arena-sim.js`) into a `vm` context — exactly as `architecture.test.js` does — builds the baseline via the real `combatantFromCharacter`, and prints the table. Work happens on the `stat-weights-harness` branch.

**Tech Stack:** Node.js (`node:test`, `node:assert/strict`, `node:vm`, `node:fs`), no new dependencies. Tests run with `node --test`.

---

## Background the engineer needs

- The fight engine is `GladiatusArenaSim.simulateOddsPvP(attacker, defender, { iterations, random, maxRounds, firstAttacker })`, defined in `arena-sim.js`. It returns `{ winRate, lossRate, drawRate, ... }` and accepts an **injectable `random`** (a `() => number` in `[0,1)`), which makes runs reproducible.
- The baseline combatant is produced by `GladiatusArenaCore.combatantFromCharacter(character)` (in `arena-core.js`). It already returns `{ name, level, hp, maxHp, damageMin, damageMax, strength, dexterity, agility, constitution, charisma, intelligence, critChance, blockChance, critAvoidChance, armourAbsorbMin, armourAbsorbMax, ... }`.
- Confirmed Gladiatus formulas (fansite `useCharacterState.ts` + game guide):
  - Damage from strength: `floor(STR/10)` added to min and max (equals `floor(STR·0.1)`).
  - Block value from strength: `floor(STR/10)`; `blockChance = min((blockValue·52/(level−8))/6, 50)`, `0` if level ≤ 8.
  - Crit attack value from dexterity: `floor(DEX/10)`; `critChance = min((critValue·52/(level−8))/5, 50)`, `0` if level ≤ 8.
  - Resilience from agility: `floor(AGI/10)`; `critAvoidChance = min((resil·52/(level−8))/4, 25)`, `0` if level ≤ 8.
  - HP from constitution: `finalCON·25 − 50` (so each point = +25 HP).
  - Hit `DEX/(DEX+AGI)` and double-hit `CHA·DEX/(INT·AGI)` are computed *inside* `simulateBattle` from the combatant's raw stat fields, so bumping those fields is enough — no derived field to set.
- **Why the deriver is simple:** the chance formulas are linear in their value below the cap, and the *displayed* (capped) chance equals the uncapped chance whenever it is below the cap. So a marginal bump is just `newChance = min(currentChance + Δvalue · 52/(level−8) / divisor, cap)`. No item-component back-out or inversion needed.

## File Structure

- **Create `stat-weights-core.js`** — pure logic, `module.exports`. No I/O, no extension globals; the sim is passed in. Holds `mulberry32`, `STAT_KEYS`, `bumpCombatant`, `computeStatWeights`, `formatWeightsTable`.
- **Create `stat-weights-core.test.js`** — `node:test` unit tests for the four pure functions, using an inline combatant and a deterministic fake sim.
- **Create `stat-weights.js`** — CLI entry. Exports `loadArena(rootDir)`; runs `main()` only when invoked directly (`require.main === module`). Reads the exported self-profile JSON, builds the baseline, prints the table.
- **Create `fixtures/self-profile.sample.json`** — a realistic level-42 export (storage-record shape) for the integration test and for first-run demos.
- **Create `stat-weights.test.js`** — `node:test` integration test: vm-loads the real modules, runs the full pipeline against the fixture, asserts the mirror baseline ≈ 0.5 and that STR/CON weigh positive.

All six primary stats handled by one `STAT_KEYS = ["strength","dexterity","agility","constitution","charisma","intelligence"]`.

---

### Task 1: Seeded PRNG

**Files:**
- Create: `stat-weights-core.js`
- Test: `stat-weights-core.test.js`

- [ ] **Step 1: Write the failing test**

```js
// stat-weights-core.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mulberry32 } = require("./stat-weights-core");

test("mulberry32 is deterministic per seed and ranges in [0,1)", () => {
  const a = mulberry32(12345);
  const b = mulberry32(12345);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);                       // same seed -> same stream
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  const c = mulberry32(99999);
  assert.notEqual(c(), seqA[0]);                      // different seed -> different stream
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test stat-weights-core.test.js`
Expected: FAIL — `Cannot find module './stat-weights-core'`.

- [ ] **Step 3: Write minimal implementation**

```js
// stat-weights-core.js
"use strict";

const STAT_KEYS = ["strength", "dexterity", "agility", "constitution", "charisma", "intelligence"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { STAT_KEYS, mulberry32 };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test stat-weights-core.test.js`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add stat-weights-core.js stat-weights-core.test.js
git commit -m "$(cat <<'EOF'
feat: seeded PRNG for stat-weight harness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Marginal-stat deriver (`bumpCombatant`)

**Files:**
- Modify: `stat-weights-core.js`
- Test: `stat-weights-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `stat-weights-core.test.js`:

```js
const { bumpCombatant } = require("./stat-weights-core");

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

const SCALE_L42 = 52 / (42 - 8); // 1.5294117647...
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

test("STR bump: +damage and +blockChance, leaves original untouched", () => {
  const base = baseCombatant();
  const c = bumpCombatant(base, "strength", 10); // 100 -> 110, floor(110/10)-floor(100/10)=1
  assert.equal(c.strength, 110);
  assert.equal(c.damageMin, 201);
  assert.equal(c.damageMax, 301);
  approx(c.blockChance, 8 + (1 * SCALE_L42) / 6);
  assert.equal(c.critChance, 10);                  // unchanged
  assert.equal(base.strength, 100);                // immutability
  assert.equal(base.damageMax, 300);
});

test("DEX bump: +critChance only", () => {
  const c = bumpCombatant(baseCombatant(), "dexterity", 10); // 80->90, delta floor = 1
  assert.equal(c.dexterity, 90);
  approx(c.critChance, 10 + (1 * SCALE_L42) / 5);
  assert.equal(c.damageMax, 300);
});

test("AGI bump: +critAvoidChance only", () => {
  const c = bumpCombatant(baseCombatant(), "agility", 10); // 60->70, delta floor = 1
  assert.equal(c.agility, 70);
  approx(c.critAvoidChance, 5 + (1 * SCALE_L42) / 4);
});

test("CON bump: +25 HP per point, hp tracks maxHp", () => {
  const c = bumpCombatant(baseCombatant(), "constitution", 10);
  assert.equal(c.constitution, 130);
  assert.equal(c.maxHp, 3250);
  assert.equal(c.hp, 3250);
});

test("CHA/INT bump: only the raw field changes", () => {
  const cha = bumpCombatant(baseCombatant(), "charisma", 10);
  assert.equal(cha.charisma, 50);
  assert.equal(cha.damageMax, 300);
  assert.equal(cha.critChance, 10);
  const int = bumpCombatant(baseCombatant(), "intelligence", 10);
  assert.equal(int.intelligence, 60);
  assert.equal(int.maxHp, 3000);
});

test("chances saturate at cap; below level 9 chance stays put", () => {
  const capped = bumpCombatant({ ...baseCombatant(), critChance: 49.9 }, "dexterity", 100);
  assert.equal(capped.critChance, 50);             // min(..., 50)
  const lowLevel = bumpCombatant({ ...baseCombatant(), level: 8 }, "strength", 10);
  assert.equal(lowLevel.blockChance, 8);           // scale 0 below level 9
  assert.equal(lowLevel.damageMax, 301);           // damage still applies
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test stat-weights-core.test.js`
Expected: FAIL — `bumpCombatant is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `stat-weights-core.js` (and extend `module.exports`):

```js
function levelScale(level) {
  return level > 8 ? 52 / (level - 8) : 0; // crit/block/avoid inactive below level 9
}

// Returns a NEW combatant with only the primitives the bumped stat affects re-derived.
// Item/weapon contributions are held fixed (we add marginal deltas onto current values).
function bumpCombatant(combatant, stat, n) {
  const c = { ...combatant };
  const level = Number(c.level) || 0;
  const scale = levelScale(level);
  const before = Number(c[stat]) || 0;
  const after = before + n;
  c[stat] = after;
  const tenStep = Math.floor(after / 10) - Math.floor(before / 10); // shared floor(stat/10) delta

  if (stat === "strength") {
    c.damageMin = (Number(c.damageMin) || 0) + tenStep;
    c.damageMax = (Number(c.damageMax) || 0) + tenStep;
    c.blockChance = Math.min((Number(c.blockChance) || 0) + (tenStep * scale) / 6, 50);
  } else if (stat === "dexterity") {
    c.critChance = Math.min((Number(c.critChance) || 0) + (tenStep * scale) / 5, 50);
  } else if (stat === "agility") {
    c.critAvoidChance = Math.min((Number(c.critAvoidChance) || 0) + (tenStep * scale) / 4, 25);
  } else if (stat === "constitution") {
    c.maxHp = (Number(c.maxHp) || 0) + n * 25;
    c.hp = c.maxHp;
  }
  // charisma / intelligence: only the raw field changes; simulateBattle recomputes
  // hit and double-hit from the combatant's raw dex/agi/cha/int fields.
  return c;
}
```

Update the export line:

```js
module.exports = { STAT_KEYS, mulberry32, bumpCombatant };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test stat-weights-core.test.js`
Expected: PASS (all bump tests + Task 1).

- [ ] **Step 5: Commit**

```bash
git add stat-weights-core.js stat-weights-core.test.js
git commit -m "$(cat <<'EOF'
feat: marginal-stat deriver for stat-weight harness

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Weight runner (`computeStatWeights`)

**Files:**
- Modify: `stat-weights-core.js`
- Test: `stat-weights-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `stat-weights-core.test.js`:

```js
const { computeStatWeights } = require("./stat-weights-core");

// Deterministic fake sim: win rate rises with attacker's damageMax and maxHp lead.
// Ignores `random`/`iterations` so results are exact and reproducible.
const fakeSim = {
  simulateOddsPvP(attacker, defender) {
    const adv = (attacker.damageMax - defender.damageMax) + (attacker.maxHp - defender.maxHp) / 100;
    const winRate = Math.max(0, Math.min(1, 0.5 + adv * 0.01));
    return { winRate, lossRate: 1 - winRate, drawRate: 0 };
  },
};

test("computeStatWeights ranks stats and normalizes to the top", () => {
  const result = computeStatWeights({ sim: fakeSim, baseline: baseCombatant(), n: 10, iterations: 100, seed: 5 });
  assert.equal(result.refScore, 0.5);                       // mirror of equals
  assert.equal(result.n, 10);
  assert.equal(result.iterations, 100);
  assert.equal(result.seed, 5);
  assert.equal(result.rows.length, 6);

  const by = Object.fromEntries(result.rows.map((r) => [r.stat, r]));
  // STR +10 -> damageMax 301 (adv 1) -> winRate 0.51 -> delta 0.01
  approx(by.strength.deltaScore, 0.01);
  approx(by.strength.perPoint, 0.001);
  // CON +10 -> maxHp +250 (adv 2.5) -> winRate 0.525 -> delta 0.025
  approx(by.constitution.deltaScore, 0.025);
  approx(by.intelligence.deltaScore, 0);                    // no damage/HP effect in fake sim

  assert.equal(result.rows[0].stat, "constitution");        // sorted descending by delta
  approx(by.constitution.normalized, 1);                    // top normalized to 1
  approx(by.strength.normalized, 0.4);                      // 0.01 / 0.025
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test stat-weights-core.test.js`
Expected: FAIL — `computeStatWeights is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `stat-weights-core.js` (and extend `module.exports`):

```js
// Mirror-match weights with common random numbers: every cell (and the reference
// mirror) reuses the same seed, so cross-config differences are noise-free.
function computeStatWeights({ sim, baseline, n = 10, iterations = 10000, seed = 12345, stats = STAT_KEYS }) {
  const scoreOf = (res) => (Number(res.winRate) || 0) + 0.5 * (Number(res.drawRate) || 0);

  const refScore = scoreOf(sim.simulateOddsPvP(baseline, baseline, { iterations, random: mulberry32(seed) }));

  const rows = stats.map((stat) => {
    const bumped = bumpCombatant(baseline, stat, n);
    const score = scoreOf(sim.simulateOddsPvP(bumped, baseline, { iterations, random: mulberry32(seed) }));
    const deltaScore = score - refScore;
    return { stat, deltaScore, perPoint: deltaScore / n, normalized: 0 };
  });

  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.deltaScore)), 1e-9);
  for (const r of rows) r.normalized = r.deltaScore / maxAbs;
  rows.sort((a, b) => b.deltaScore - a.deltaScore);

  return { refScore, n, iterations, seed, rows };
}
```

Update the export line:

```js
module.exports = { STAT_KEYS, mulberry32, bumpCombatant, computeStatWeights };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test stat-weights-core.test.js`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add stat-weights-core.js stat-weights-core.test.js
git commit -m "$(cat <<'EOF'
feat: mirror-match weight runner with common random numbers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Reporter (`formatWeightsTable`)

**Files:**
- Modify: `stat-weights-core.js`
- Test: `stat-weights-core.test.js`

- [ ] **Step 1: Write the failing test**

Append to `stat-weights-core.test.js`:

```js
const { formatWeightsTable } = require("./stat-weights-core");

test("formatWeightsTable renders header meta and one line per stat", () => {
  const result = computeStatWeights({ sim: fakeSim, baseline: baseCombatant(), n: 10, iterations: 100, seed: 5 });
  const text = formatWeightsTable(result, { name: "Testus", level: 42 });
  assert.match(text, /Testus/);
  assert.match(text, /level 42/);
  assert.match(text, /mirror baseline 0\.500/);
  for (const stat of ["strength", "dexterity", "agility", "constitution", "charisma", "intelligence"]) {
    assert.match(text, new RegExp(stat));
  }
  // constitution (top) appears before strength in the sorted body
  assert.ok(text.indexOf("constitution") < text.indexOf("strength"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test stat-weights-core.test.js`
Expected: FAIL — `formatWeightsTable is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `stat-weights-core.js` (and extend `module.exports`):

```js
function formatWeightsTable(result, meta = {}) {
  const name = meta.name || "Character";
  const level = Number(meta.level) || 0;
  const signed = (v) => (v >= 0 ? "+" : "") + v.toFixed(4);
  const header =
    `Stat weights — ${name} level ${level}, ${result.iterations} iters, ` +
    `seed ${result.seed}, N=${result.n}, mirror baseline ${result.refScore.toFixed(3)}`;
  const cols = `  ${"stat".padEnd(14)}${`Δscore/+${result.n}`.padEnd(14)}${"per-point".padEnd(12)}normalized`;
  const lines = result.rows.map(
    (r) =>
      `  ${r.stat.padEnd(14)}${signed(r.deltaScore).padEnd(14)}` +
      `${r.perPoint.toFixed(5).padEnd(12)}${r.normalized.toFixed(2)}`
  );
  return [header, "", cols, ...lines].join("\n");
}
```

Update the export line:

```js
module.exports = { STAT_KEYS, mulberry32, bumpCombatant, computeStatWeights, formatWeightsTable };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test stat-weights-core.test.js`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add stat-weights-core.js stat-weights-core.test.js
git commit -m "$(cat <<'EOF'
feat: stat-weight table reporter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: CLI entry + fixture + real-sim integration test

**Files:**
- Create: `stat-weights.js`
- Create: `fixtures/self-profile.sample.json`
- Test: `stat-weights.test.js`

- [ ] **Step 1: Write the failing test**

```js
// stat-weights.test.js
const path = require("node:path");
const fs = require("node:fs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadArena } = require("./stat-weights");
const { computeStatWeights } = require("./stat-weights-core");

test("real sim: mirror baseline ~0.5, STR and CON weigh positive", () => {
  const { arena, sim } = loadArena(__dirname);
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/self-profile.sample.json"), "utf8"));
  const character = raw["glad-arena-self-profile-v1"].character;

  assert.ok(arena.combatantReadiness(character).ready, "fixture must be combat-ready");
  const baseline = arena.combatantFromCharacter(character);

  const result = computeStatWeights({ sim, baseline, iterations: 4000, seed: 7 });
  assert.ok(result.refScore > 0.45 && result.refScore < 0.55, `refScore ${result.refScore}`);
  assert.equal(result.rows.length, 6);

  const by = Object.fromEntries(result.rows.map((r) => [r.stat, r.deltaScore]));
  assert.ok(by.strength > 0, `STR weight ${by.strength}`);
  assert.ok(by.constitution > 0, `CON weight ${by.constitution}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test stat-weights.test.js`
Expected: FAIL — `Cannot find module './stat-weights'`.

- [ ] **Step 3: Write the fixture**

```json
// fixtures/self-profile.sample.json
{
  "glad-arena-self-profile-v1": {
    "scannedAt": "2026-06-29T12:00:00.000Z",
    "profileUrl": "",
    "character": {
      "name": "Testus Maximus",
      "level": 42,
      "stats": {
        "level": 42,
        "strength": 100,
        "dexterity": 80,
        "agility": 60,
        "constitution": 120,
        "charisma": 40,
        "intelligence": 50,
        "armour": 150,
        "armourAbsorbMin": 10,
        "armourAbsorbMax": 20,
        "lifeMax": 3000,
        "damageMin": 200,
        "damageMax": 300,
        "blockChance": 8,
        "critChance": 10,
        "critAvoidChance": 5
      }
    }
  }
}
```

- [ ] **Step 4: Write the CLI**

```js
// stat-weights.js
//
// Rank primary stats by per-point combat value using the arena fight sim.
// Usage: node stat-weights.js [path-to-self-profile.json]   (default ./self-profile.json)
//
// Export your live scrape from the extension's service-worker DevTools console:
//   copy(JSON.stringify((await chrome.storage.local.get('glad-arena-self-profile-v1'))))
// then paste into self-profile.json. (Or automate via the chrome-devtools MCP.)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { computeStatWeights, formatWeightsTable } = require("./stat-weights-core");

// Load the extension's browser-IIFE modules into a sandbox (same pattern as
// architecture.test.js) and return the globals they attach.
function loadArena(rootDir) {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["arena-core.js", "arena-sim.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }
  return { arena: context.GladiatusArenaCore, sim: context.GladiatusArenaSim };
}

function main(argv = process.argv) {
  const rootDir = __dirname;
  const profilePath = argv[2] || path.join(rootDir, "self-profile.json");
  if (!fs.existsSync(profilePath)) {
    console.error(`No self-profile file at ${profilePath}. See the export one-liner at the top of stat-weights.js.`);
    process.exit(1);
  }

  const { arena, sim } = loadArena(rootDir);
  const raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  // Accept either a full storage dump ({ "glad-arena-...": record }) or a bare record.
  const record = raw[arena.selfProfileStorageKey] || raw;
  const character = record && record.character;
  if (!character) {
    console.error(`No character found in ${profilePath}.`);
    process.exit(1);
  }

  const readiness = arena.combatantReadiness(character);
  if (readiness.warnings.length) console.error(`Warnings: ${readiness.warnings.join(", ")}`);
  if (!readiness.ready) {
    console.error(`Self profile is not combat-ready (missing: ${readiness.missing.join(", ")}).`);
    process.exit(1);
  }

  const baseline = arena.combatantFromCharacter(character);
  const result = computeStatWeights({ sim, baseline });
  console.log(formatWeightsTable(result, { name: baseline.name, level: baseline.level }));
}

if (require.main === module) main();

module.exports = { loadArena, main };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test stat-weights.test.js`
Expected: PASS (1 test). The real sim runs 4000 iterations per cell.

- [ ] **Step 6: Smoke-run the CLI against the fixture**

Run: `node stat-weights.js fixtures/self-profile.sample.json`
Expected: a printed table with a header line containing `Testus Maximus level 42` and six stat rows. Confirm `mirror baseline` is ≈ 0.50.

- [ ] **Step 7: Commit**

```bash
git add stat-weights.js fixtures/self-profile.sample.json stat-weights.test.js
git commit -m "$(cat <<'EOF'
feat: stat-weights CLI with real-sim integration test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `node --test`
Expected: PASS — the new `stat-weights-core.test.js` and `stat-weights.test.js` pass, and the existing `architecture.test.js` / `log.test.js` still pass (the new files are Node-only and not in the manifest, so `architecture.test.js`'s fixed file lists are unaffected).

- [ ] **Step 2: If anything fails, stop and debug**

Use superpowers:systematic-debugging. Do not paper over a failure by editing assertions.

- [ ] **Step 3: Final commit (only if any cleanup was needed)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: stat-weight harness suite green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Notes for the player (post-implementation)

- Run with your real build: export `glad-arena-self-profile-v1` to `self-profile.json` (one-liner in the CLI header) and run `node stat-weights.js`.
- The weights are intrinsic to your current build/level and shift as gear changes.
- Documented v1 simplifications (from the spec): assumes bumped stats are under their `base+floor(base/2)+level` cap; ignores the `blessing_jupiter` HP multiplier; the ported sim uses *final* (not capped) agility/int in the hit & double-hit denominators. Promote any of these to exact handling later if a build sits near a cap.

## Self-review

- **Spec coverage:** synthetic bump ✓ (Task 2), marginal-delta on real scrape ✓ (Task 2 + Task 5 baseline), mirror match ✓ (Task 3), CRN + high iterations ✓ (Task 3), draw-aware metric `wins+0.5·draws` ✓ (Task 3), live-scrape ingestion via exported JSON ✓ (Task 5), output table ✓ (Task 4), module loader via `vm` ✓ (Task 5), testing approach (deriver unit tests, mirror≈0.5, monotonic positive STR/CON) ✓ (Tasks 2/3/5). The spec's `score − 0.5` is implemented as `score − refScore` with `refScore` the measured mirror (≈0.5) — a strictly better paired-CRN comparison, noted in output.
- **Placeholder scan:** none — every code/step is complete and runnable.
- **Type consistency:** `bumpCombatant(combatant, stat, n)`, `computeStatWeights({ sim, baseline, n, iterations, seed, stats })` returning `{ refScore, n, iterations, seed, rows:[{stat,deltaScore,perPoint,normalized}] }`, and `formatWeightsTable(result, meta)` are used identically across Tasks 2–5 and both test files. `loadArena(rootDir) -> { arena, sim }` matches between `stat-weights.js` and `stat-weights.test.js`.
