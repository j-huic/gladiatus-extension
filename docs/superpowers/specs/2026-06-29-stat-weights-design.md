# Stat-Weight Harness — Design

- **Date:** 2026-06-29
- **Status:** Draft for review
- **Topic:** Use the existing arena fight simulator to compute per-stat combat weights for the player's own build.

## Goal

Rank the six primary stats — Strength, Dexterity, Agility, Constitution, Charisma,
Intelligence — by how much each invested point improves the player's combat
strength. Produce a sorted **stat-weight table** the player can use to decide
where to spend points.

Method: take the player's *real* build, bump one stat by N points, re-derive the
combat primitives that stat affects, and Monte-Carlo sim the bumped build against
an unbumped mirror of itself. The win-rate lift above even is that stat's weight.

## Background: what exists vs. the gap

The repo is a Chrome extension for Gladiatus. Two relevant pieces already exist:

- **Fight engine — ready.** [`arena-sim.js`](../../../arena-sim.js) exposes
  `GladiatusArenaSim.simulateOddsPvP(attacker, defender, { iterations, random, maxRounds, firstAttacker })`.
  It runs a Monte-Carlo of `simulateBattle` and returns `{ winRate, lossRate, drawRate, ... }`.
  It models hit chance, crit, block, double-hit, armour absorption, and two-sided
  initiative, and accepts an **injectable `random`** — so runs are seedable/reproducible.
  It is a faithful port of the fansite's `simulateBattle.ts`.

- **Stat→combat derivation — missing locally, exists upstream.** The combat loop
  consumes *already-derived* values (`damageMin/Max`, `critChance`, `blockChance`,
  `critAvoidChance`, `maxHp`, `armourAbsorbMin/Max`). The extension obtains these by
  **scraping the game character sheet** ([`arena-core.js:614`](../../../src/features/arena/arena-core.js)),
  not by computing them. Raw `strength`/`constitution` are carried on the combatant
  but unused by the loop (only dex/agi/cha/int feed hit & double-hit). So there is
  **no code path today that turns "+10 STR" into new combat primitives.**

  The fansite repo (`github.com/Djongov/gladiatus-fansite`) encodes the full
  derivation in `calculateCharacterStats` (`useCharacterState.ts`) and
  `chanceFormulas.ts`. We port the *marginal* slice of it (see below).

### Confirmed formulas (fansite source + game guide)

All per-point effects use integer `floor`. Stats are **capped** at
`base + floor(base/2) + level`; chances are **level-scaled and hard-capped**.

| Raw stat | Effect(s) |
|---|---|
| **Strength** | damage `+= floor(STR · 0.1)` **and** block value `floor(STR/10)` → blockChance |
| **Dexterity** | hit% `DEX/(DEX+AGI)` **and** crit value `floor(DEX/10)` → critChance **and** double-hit numerator |
| **Agility** | hit% denominator **and** resilience `floor(AGI/10)` → crit-avoid **and** double-hit denominator |
| **Constitution** | HP `= level·25 + (finalCON·25 − 50) + items` |
| **Charisma** | double-hit numerator (`+ threat`) |
| **Intelligence** | double-hit avoidance (denominator) |

Level-scaled chances (cap in parens): `critChance = min((critVal·52/(level−8))/5, 50)`,
`blockChance = min((blockVal·52/(level−8))/6, 50)`, `critAvoid = min((resil·52/(level−8))/4, 25)`;
all `0` below level 9.

Sources:
- https://gladiatus.gamerz-bg.com/game-guide/formulas
- fansite `src/components/CharacterPlanner/useCharacterState.ts` (`calculateCharacterStats`)
- fansite `src/services/combat/chanceFormulas.ts`

## Decisions (locked)

1. **Synthetic** stat bumps (no in-game respec).
2. **Marginal-delta on the real scrape:** start from the player's actual scraped
   combatant; recompute only the primitives the bumped stat touches, holding gear
   contributions fixed. Weights reflect the player's current build.
3. **Mirror match:** measure bumped build vs. an unbumped copy of itself. Symmetric,
   opponent-independent, exercises offense and defense equally → intrinsic weight.
4. **Common Random Numbers + high iterations** for low-noise deltas.
5. **Baseline = live self-profile scrape**, ingested via an exported JSON of the
   extension's stored record (Node can't read `chrome.storage` directly).

## Architecture

A single standalone Node script, `stat-weights.js`, run with `node stat-weights.js`.
No new dependencies; reuses existing modules unchanged.

```
exported self-profile JSON (glad-arena-self-profile-v1)
        │  ARENA.combatantFromCharacter(record.character)   ← real code path
        ▼
  baseline combatant ───────────────────────────┐
        │                                        │ mirror (unbumped copy)
   for each stat S in [STR,DEX,AGI,CON,CHA,INT]: │
     bump +N → marginal-delta re-derive          │
        ▼                                        ▼
   bumped combatant ─► simulateOddsPvP(bumped, baseline,
                          { random: seeded(seed), iterations }) ─► score(S)
                                                                      │
        weight(S) = score(S) − 0.5  ◄─────────────────────────────────┘
```

### Components

1. **Module loader.** Reuse the test pattern at
   [`architecture.test.js:80`](../../../architecture.test.js): create a `vm`
   context, `runInContext` `arena-core.js` then `arena-sim.js`, read
   `context.GladiatusArenaCore` (`ARENA`) and `context.GladiatusArenaSim` (`SIM`).

2. **Self-profile loader.** Read `self-profile.json` (the exported storage record),
   take `record.character`, and build the baseline via
   `ARENA.combatantFromCharacter(character)`. Validate with
   `ARENA.combatantReadiness(character)` and surface `missing`/`warnings`.
   The script also keeps the scraped **breakdown fields** from `character.stats`
   (`damageFromStrength`, `blockingFromStrength`/`blockingFromItems`,
   `criticalAttackFromItems`, `resilienceFromItems`, `healthFromConstitution`/items, …)
   needed to hold gear fixed during re-derivation.

3. **Marginal-delta deriver.** `bump(baseline, stat, n) → combatant`. Given the
   baseline combatant + scraped breakdowns + level, recompute only the affected
   primitives using the formulas table, holding the item/weapon contributions
   constant. Raw stat fields on the combatant are also updated so the loop's
   internal hit/double-hit recompute correctly.

4. **Runner.** Seeded PRNG (mulberry32). For each stat: reset the seed, run
   `simulateOddsPvP(bumped, baseline, { random, iterations })`. Compute
   `score = winRate + 0.5 · drawRate`. Also compute the mirror reference
   (no bump) with the same seed to confirm it sits at ≈ 0.5.

5. **Reporter.** Print a table sorted by weight:
   `stat | Δscore per +N | per-point | normalized (top = 1.0)`, plus run metadata
   (level, iterations, seed, N, baseline mirror score, any readiness warnings).

## Method details

- **Metric (draw-aware):** `score = wins + 0.5·draws` over iterations. A true mirror
  sits at exactly 0.5 in expectation, so `weight = score − 0.5` is the lift above even.
- **CRN:** a single fixed seed is reused across every cell (each stat *and* the
  reference mirror), so differences across configurations are not contaminated by
  RNG noise.
- **Initiative:** `firstAttacker: "coinflip"` (the sim default) keeps the mirror fair.
- **Defaults:** `N = 10` (reported per-point too), `iterations = 10_000`,
  `maxRounds = 15` (sim default). All parameterizable via CLI flags or constants.

## Self-profile ingestion

The extension persists the self-profile in `chrome.storage.local` under
`glad-arena-self-profile-v1` ([`arena-core.js:15`](../../../src/features/arena/arena-core.js)) with shape
`{ character: { stats, combat, name, level }, scannedAt, profileUrl }`.

To hand it to the Node harness, export the record to `self-profile.json`:

- **Manual:** in the extension's service-worker DevTools console, run
  `copy(JSON.stringify((await chrome.storage.local.get('glad-arena-self-profile-v1'))['glad-arena-self-profile-v1']))`
  and paste into `self-profile.json`.
- **Automated:** drive the same `chrome.storage.local.get` via the chrome-devtools
  MCP `evaluate_script` against the extension context and write the result to file.
  (Per project notes, chrome-devtools MCP is the confirmed working browser path.)

The harness validates `scannedAt` freshness using `ARENA.selfProfileMaxAgeMs` and
warns if the scrape is stale.

## Output (illustrative)

```
Stat weights — level 42, 10000 iters, seed 12345, N=10, mirror baseline 0.501

  stat          Δscore/+10   per-point   normalized
  strength        +0.084      0.0084        1.00
  dexterity       +0.071      0.0071        0.85
  constitution    +0.052      0.0052        0.62
  agility         +0.030      0.0030        0.36
  charisma        +0.011      0.0011        0.13
  intelligence    +0.006      0.0006        0.07
```

## Assumptions & caveats

- **Cap:** v1 treats +N points as +N to the *final* stat (assumes the stat is below
  its `base + floor(base/2) + level` cap and ignores item stat-percent interplay).
  Cap-aware bumping is a documented future refinement.
- **Hit/double-hit divergence:** the ported `simulateBattle` uses *final* agility/int
  in the hit & double-hit denominators, whereas the fansite uses the stat *cap*
  (`maxAgility`/`maxIntelligence`). v1 leaves the sim as-is so the harness matches the
  live extension; aligning to fansite-exact is a one-line change if desired later.
- **Mirror semantics:** weights are intrinsic to the current build/level and will
  shift as gear changes. They answer "what's the most combat-efficient point right
  now," not "what beats a specific opponent."
- **Win-rate nonlinearity** is sidestepped by the mirror (baseline pinned at ~0.5,
  where marginal points have the most measurable signal).

## Out of scope (v1)

- Cap-aware / item-percent-aware bumping.
- Real-opponent-panel weights (was offered; mirror chosen).
- Feeding results into `score-model.js` opponent scoring.
- Any extension UI; this is a CLI analysis harness.

## Testing approach

- Unit-test the marginal-delta deriver against hand-computed expectations for each
  stat (e.g. a known STR → Δdamage and Δblock value at a fixed level).
- Assert the no-bump mirror reference scores ≈ 0.5 within tolerance at high iterations
  (sanity check on symmetry + CRN).
- Assert monotonicity where unambiguous (more points in a stat never lowers its own
  bumped score vs. baseline under CRN).

## Open questions

None blocking. CLI ergonomics (flags vs. constants) and exact PRNG choice are
implementation details for the plan.
