// Stat-weight core: portable, dependency-injected logic shared by the Node CLI
// (sim-lab/stat-weights.js) and, if ported later, the extension itself.
//
// Browser-IIFE style matching the rest of the repo: attaches
// globalThis.GladiatusStatWeights. No I/O, no DOM, no chrome; the fight sim is
// passed IN (so this file runs unchanged under Node's vm and in the extension).
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.GladiatusStatWeights) return;

  const STAT_KEYS = ["strength", "dexterity", "agility", "constitution", "charisma", "intelligence"];
  const WEIGHT_KEYS = [...STAT_KEYS, "armour"];
  const DEFAULT_ARMOUR_BUMP = 500;

  // Arena fights end after 15 rounds when neither side is knocked out. Extending
  // the fight toward a knockout dramatically overvalues HP/constitution.
  const DEFAULT_MAX_ROUNDS = 15;

  // Deterministic, seedable PRNG. Returns a function producing values in [0,1).
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

  // Per-battle seed: mixes the base seed with the battle index so battle i uses
  // the same randomness for the bumped run and the reference run (true CRN).
  function deriveSeed(baseSeed, index) {
    let h = ((baseSeed >>> 0) ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    return h >>> 0;
  }

  function levelScale(level) {
    return level > 8 ? 52 / (level - 8) : 0; // crit/block/avoid inactive below level 9
  }

  function armourAbsorption(armour) {
    const value = Math.max(0, Number(armour) || 0);
    return {
      min: Math.max(0, Math.ceil(value / 74 - (value / 74) / 660 + 1)),
      max: Math.max(0, Math.floor(value / 66 + value / 660)),
    };
  }

  // Returns a NEW combatant with only the primitives the bumped stat affects
  // re-derived. Item/weapon contributions are held fixed by adding marginal
  // deltas onto the current (scraped) values. Linear-below-cap chance formulas
  // mean a bump is just an additive delta on the current chance.
  function bumpCombatant(combatant, stat, n) {
    const c = { ...combatant };
    const level = Number(c.level) || 0;
    const scale = levelScale(level);
    const before = Number(c[stat]) || 0;
    const after = before + n;
    c[stat] = after;
    const tenStep = Math.floor(after / 10) - Math.floor(before / 10); // floor(stat/10) delta

    if (stat === "strength") {
      c.damageMin = (Number(c.damageMin) || 0) + tenStep; // damage from strength = floor(STR/10)
      c.damageMax = (Number(c.damageMax) || 0) + tenStep;
      c.blockChance = Math.min((Number(c.blockChance) || 0) + (tenStep * scale) / 6, 50);
    } else if (stat === "dexterity") {
      c.critChance = Math.min((Number(c.critChance) || 0) + (tenStep * scale) / 5, 50);
    } else if (stat === "agility") {
      c.critAvoidChance = Math.min((Number(c.critAvoidChance) || 0) + (tenStep * scale) / 4, 25);
    } else if (stat === "constitution") {
      c.maxHp = (Number(c.maxHp) || 0) + n * 25; // +25 HP per constitution point
      c.hp = c.maxHp;
    } else if (stat === "armour") {
      const beforeAbsorption = armourAbsorption(before);
      const afterAbsorption = armourAbsorption(after);
      c.armourAbsorbMin = (Number(c.armourAbsorbMin) || 0) + afterAbsorption.min - beforeAbsorption.min;
      c.armourAbsorbMax = (Number(c.armourAbsorbMax) || 0) + afterAbsorption.max - beforeAbsorption.max;
    }
    // charisma / intelligence: only the raw field changes; the sim recomputes
    // hit and double-hit from the combatant's raw dex/agi/cha/int fields.
    return c;
  }

  function outcomeScore(outcome) {
    if (outcome === "attacker_wins") return 1;
    if (outcome === "draw") return 0.5;
    return 0;
  }

  // Mirror-match weights with per-battle common random numbers.
  // For each battle i, the reference (mirror) fight and every bumped fight use a
  // PRNG seeded identically, so the paired difference d_i isolates the stat's
  // effect. The reference battles are computed once and reused across stats.
  // Returns empirical error bars (standard error + 95% CI) per stat.
  function computeStatWeights(options) {
    const sim = options.sim;
    const baseline = options.baseline;
    const n = options.n != null ? options.n : 10;
    const iterations = options.iterations != null ? options.iterations : 50000;
    const seed = options.seed != null ? options.seed : 12345;
    const stats = options.stats || WEIGHT_KEYS;
    const bumpBy = { armour: DEFAULT_ARMOUR_BUMP, ...(options.bumpBy || {}) };
    const requestedMode = String(options.mode || "arena").toLowerCase();
    const mode = requestedMode === "expedition" ? "expedition" : "arena";
    const resolvedRules = typeof sim.resolveBattleRules === "function"
      ? sim.resolveBattleRules({ mode, maxRounds: options.maxRounds, firstAttacker: options.firstAttacker })
      : {
          mode,
          maxRounds: options.maxRounds != null ? options.maxRounds : DEFAULT_MAX_ROUNDS,
          firstAttacker: options.firstAttacker || (mode === "expedition" ? "defender" : "coinflip"),
        };
    const maxRounds = resolvedRules.maxRounds;
    const firstAttacker = resolvedRules.firstAttacker;

    // Arena defaults to a fixed mirror. Expedition requires an explicit target
    // and applies the monster-only combat derivation once before paired battles.
    const mirror = { ...baseline, name: `${baseline.name || "self"} ◇mirror` };
    const suppliedOpponent = options.opponent || null;
    if (mode === "expedition" && !suppliedOpponent) {
      throw new Error("Expedition stat weights require a fixed opponent");
    }
    const opponent = mode === "expedition" && typeof sim.expeditionMonsterFromStats === "function"
      ? sim.expeditionMonsterFromStats(suppliedOpponent)
      : suppliedOpponent || mirror;
    const opponentName = String(opponent.name || "Opponent");

    const battleOpts = (i) => ({ mode, random: mulberry32(deriveSeed(seed, i)), maxRounds, firstAttacker });

    const refScores = new Array(iterations);
    let refSum = 0;
    for (let i = 0; i < iterations; i += 1) {
      const s = outcomeScore(sim.simulateBattle(baseline, opponent, battleOpts(i)).outcome);
      refScores[i] = s;
      refSum += s;
    }
    const refScore = refSum / iterations;

    const rows = stats.map((stat) => {
      const bump = Number(bumpBy[stat]) > 0 ? Number(bumpBy[stat]) : n;
      const bumped = bumpCombatant(baseline, stat, bump);
      let sumD = 0;
      let sumD2 = 0;
      let flips = 0;
      for (let i = 0; i < iterations; i += 1) {
        const b = outcomeScore(sim.simulateBattle(bumped, opponent, battleOpts(i)).outcome);
        const d = b - refScores[i];
        if (d !== 0) flips += 1;
        sumD += d;
        sumD2 += d * d;
      }
      const mean = sumD / iterations;
      const variance = Math.max(0, sumD2 / iterations - mean * mean);
      const se = Math.sqrt(variance / iterations);
      return {
        stat,
        bump,
        deltaScore: mean,
        perPoint: mean / bump,
        se,
        ci95: 1.96 * se,
        flipRate: flips / iterations,
        normalized: 0,
      };
    });

    const maxAbs = Math.max(...rows.map((r) => Math.abs(r.deltaScore)), 1e-12);
    for (const r of rows) r.normalized = r.deltaScore / maxAbs;
    rows.sort((a, b) => b.deltaScore - a.deltaScore);

    return { refScore, n, bumpBy, iterations, seed, mode, maxRounds, firstAttacker, opponentName, rows };
  }

  // Keep gold economics separate from combat simulation. `statValues` is a
  // stat-keyed record of marginal score gained per trained point, while
  // `trainingCosts` contains the current gold price of the next point.
  function calculateTrainingEfficiency(statValues = {}, trainingCosts = {}) {
    const rows = STAT_KEYS.map((stat) => {
      const valuePerPoint = Number(statValues[stat]) || 0;
      const costPerPoint = Number(trainingCosts[stat]);
      const hasValidCost = Number.isFinite(costPerPoint) && costPerPoint > 0;
      const valuePerGold = hasValidCost ? valuePerPoint / costPerPoint : null;
      return {
        stat,
        valuePerPoint,
        costPerPoint: hasValidCost ? costPerPoint : null,
        valuePerGold,
        valuePerMillionGold: valuePerGold == null ? null : valuePerGold * 1_000_000,
        normalized: 0,
      };
    });

    const best = Math.max(...rows.map((row) => row.valuePerGold || 0), 0);
    for (const row of rows) {
      row.normalized = best > 0 && row.valuePerGold != null ? row.valuePerGold / best : 0;
    }
    rows.sort((a, b) => (b.valuePerGold ?? -Infinity) - (a.valuePerGold ?? -Infinity));

    return {
      bestStat: best > 0 ? rows.find((row) => row.valuePerGold === best)?.stat || null : null,
      rows,
    };
  }

  function trainingEfficiencyFromWeights(result, trainingCosts = {}) {
    const statValues = Object.fromEntries((result?.rows || []).map((row) => [row.stat, row.perPoint]));
    return calculateTrainingEfficiency(statValues, trainingCosts);
  }

  function formatWeightsTable(result, meta = {}) {
    const name = meta.name || "Character";
    const level = Number(meta.level) || 0;
    const signed = (v) => (v >= 0 ? "+" : "") + v.toFixed(4);
    const header =
      `Stat weights — ${name} level ${level}, ${result.iterations} iters, ` +
      `seed ${result.seed}, primary N=${result.n}, armour N=${result.bumpBy?.armour || DEFAULT_ARMOUR_BUMP}, ` +
      `${result.mode || "arena"} ` +
      `${result.maxRounds || DEFAULT_MAX_ROUNDS} rounds/${result.firstAttacker || "coinflip"}, ` +
      `${result.mode === "expedition" ? `vs ${result.opponentName}` : "mirror"} baseline ${result.refScore.toFixed(3)}`;
    const cols =
      `  ${"stat".padEnd(14)}${"bump".padEnd(8)}${"Δscore".padEnd(13)}${"±95% CI".padEnd(11)}` +
      `${"per-point".padEnd(12)}${"flip%".padEnd(9)}normalized`;
    const lines = result.rows.map(
      (r) =>
        `  ${r.stat.padEnd(14)}${(`+${r.bump || result.n}`).padEnd(8)}${signed(r.deltaScore).padEnd(13)}` +
        `${("±" + r.ci95.toFixed(4)).padEnd(11)}${r.perPoint.toFixed(5).padEnd(12)}` +
        `${(100 * r.flipRate).toFixed(2).padEnd(9)}${r.normalized.toFixed(2)}`
    );
    return [header, "", cols, ...lines].join("\n");
  }

  function formatTrainingEfficiencyTable(result) {
    const cols =
      `  ${"stat".padEnd(14)}${"cost/+1".padEnd(13)}${"score/1M gold".padEnd(17)}normalized`;
    const lines = result.rows.map((row) => {
      const cost = row.costPerPoint == null ? "missing" : Math.round(row.costPerPoint).toLocaleString("en-US");
      const perMillion = row.valuePerMillionGold == null ? "—" : row.valuePerMillionGold.toFixed(5);
      return `  ${row.stat.padEnd(14)}${cost.padEnd(13)}${perMillion.padEnd(17)}${row.normalized.toFixed(2)}`;
    });
    return ["Training efficiency — marginal simulated score per current gold cost", "", cols, ...lines].join("\n");
  }

  root.GladiatusStatWeights = {
    STAT_KEYS,
    WEIGHT_KEYS,
    mulberry32,
    deriveSeed,
    armourAbsorption,
    bumpCombatant,
    computeStatWeights,
    calculateTrainingEfficiency,
    trainingEfficiencyFromWeights,
    formatWeightsTable,
    formatTrainingEfficiencyTable,
  };
})();
