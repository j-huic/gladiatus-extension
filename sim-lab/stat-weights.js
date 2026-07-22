// Stat-weight CLI (Node shell). Loads the extension's combat modules into a vm
// sandbox, builds the baseline combatant from a self-profile scrape, and prints
// the per-stat weight table.
//
// Usage:
//   node sim-lab/stat-weights.js [path-to-self-profile.json] [--iterations N] [--seed S] [--n N]
//     [--armour-n N] [--mode arena|expedition] [--monster preset-id]
//     [--training-costs path-to-costs.json]
//   (default profile: ./self-profile.json next to this script; default N=50000)
//
// Export your live scrape from the extension's service-worker DevTools console:
//   copy(JSON.stringify(await chrome.storage.local.get('glad-arena-self-profile-v1')))
// then paste into self-profile.json. (Or automate via the chrome-devtools MCP.)
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { getExpeditionMonster } = require("./expedition-monsters");

const EXTENSION_ROOT = path.join(__dirname, "..");

// Load score-model -> arena-core -> arena-sim (required order; arena-core.js:3
// hard-requires GladiatusScoreModel) plus the portable stat-weight core, into a
// single sandbox, and return the globals they attach.
function loadArena(extensionRoot = EXTENSION_ROOT) {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);

  const files = [
    path.join(extensionRoot, "src/shared/score-model.js"),
    path.join(extensionRoot, "src/features/arena/arena-core.js"),
    path.join(extensionRoot, "src/features/arena/arena-sim.js"),
    path.join(__dirname, "stat-weights-core.js"),
  ];
  for (const file of files) {
    vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: path.basename(file) });
  }

  return {
    arena: context.GladiatusArenaCore,
    sim: context.GladiatusArenaSim,
    weights: context.GladiatusStatWeights,
  };
}

function parseArgs(argv) {
  const out = {
    profilePath: null,
    iterations: undefined,
    seed: undefined,
    n: undefined,
    armourN: undefined,
    mode: "arena",
    monster: null,
    trainingCostsPath: null,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--iterations" || arg === "-N") out.iterations = Number(rest[(i += 1)]);
    else if (arg === "--seed") out.seed = Number(rest[(i += 1)]);
    else if (arg === "--n") out.n = Number(rest[(i += 1)]);
    else if (arg === "--armour-n") out.armourN = Number(rest[(i += 1)]);
    else if (arg === "--mode") out.mode = String(rest[(i += 1)] || "arena").toLowerCase();
    else if (arg === "--monster") out.monster = rest[(i += 1)];
    else if (arg === "--training-costs") out.trainingCostsPath = rest[(i += 1)];
    else if (!arg.startsWith("-")) out.profilePath = arg;
  }
  return out;
}

function main(argv = process.argv) {
  const args = parseArgs(argv);
  const profilePath = args.profilePath || path.join(__dirname, "self-profile.json");
  if (!fs.existsSync(profilePath)) {
    console.error(`No self-profile file at ${profilePath}. See the export one-liner at the top of stat-weights.js.`);
    process.exit(1);
  }

  const { arena, sim, weights } = loadArena();
  if (!arena || !sim || !weights) {
    console.error("Failed to load combat modules (check load order / file paths).");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  const record = raw[arena.selfProfileStorageKey] || raw; // full storage dump or bare record
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
  const opts = { sim, baseline };
  if (args.iterations) opts.iterations = args.iterations;
  if (args.seed != null) opts.seed = args.seed;
  if (args.n) opts.n = args.n;
  if (args.armourN) opts.bumpBy = { armour: args.armourN };
  opts.mode = args.mode;
  if (args.mode === "expedition") {
    opts.opponent = getExpeditionMonster(args.monster);
    if (!opts.opponent) {
      console.error(`Unknown expedition monster preset: ${args.monster || "(missing)"}.`);
      process.exit(1);
    }
  }

  const result = weights.computeStatWeights(opts);
  console.log(weights.formatWeightsTable(result, { name: baseline.name, level: baseline.level }));

  if (args.trainingCostsPath) {
    const costsRaw = JSON.parse(fs.readFileSync(args.trainingCostsPath, "utf8"));
    const costs = costsRaw.trainingCosts || costsRaw;
    const efficiency = weights.trainingEfficiencyFromWeights(result, costs);
    console.log(`\n${weights.formatTrainingEfficiencyTable(efficiency)}`);
  }
}

if (require.main === module) main();

module.exports = { loadArena, parseArgs, main };
