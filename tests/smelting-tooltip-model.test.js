const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

const context = { console };
context.globalThis = context;
vm.createContext(context);
for (const file of [
  "src/features/smelting/smelting-material-data.js",
  "src/features/smelting/smelting-tooltip-model.js"
]) {
  vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
}

const data = context.GladiatusSmeltingMaterialData;
const model = context.GladiatusSmeltingTooltipModel;

assert.deepEqual(
  JSON.parse(JSON.stringify(data.affixesForTitle("Antonius Short dagger of Faith"))),
  {
    title: "Antonius Short dagger of Faith",
    prefix: "Antonius",
    suffix: "of Faith",
    baseName: "Short dagger",
    materials: {
      "Dragon Scale": 4,
      Amethyst: 18,
      Crystal: 30,
      "Gold Ore": 3,
      "Waters of Oblivion": 27,
      Cuprit: 6,
      Jasper: 8
    }
  }
);

const comparison = [["Gaius Short dagger of Stars", "#FF6A00"], ["Level 101", "#808080"]];
const original = [
  [["Antonius Short dagger of Faith", "#FF6A00"], ["Level 93", "#808080"]],
  comparison
];
const enriched = model.appendMaterials(original);

assert.equal(enriched.changed, true);
assert.deepEqual(JSON.parse(JSON.stringify(original)), [
  [["Antonius Short dagger of Faith", "#FF6A00"], ["Level 93", "#808080"]],
  comparison
], "the model does not mutate the game payload");
assert.deepEqual(
  JSON.parse(JSON.stringify(enriched.payload[0].slice(-8))),
  [
    ["Smelting materials", "#BA9700"],
    ["4 × Dragon Scale", "#DDD"],
    ["18 × Amethyst", "#DDD"],
    ["30 × Crystal", "#DDD"],
    ["3 × Gold Ore", "#DDD"],
    ["27 × Waters of Oblivion", "#DDD"],
    ["6 × Cuprit", "#DDD"],
    ["8 × Jasper", "#DDD"]
  ]
);
assert.deepEqual(JSON.parse(JSON.stringify(enriched.payload[1])), comparison, "comparison columns remain untouched");
assert.equal(model.appendMaterials(enriched.payload).changed, false, "enrichment is idempotent");
assert.equal(model.appendMaterials([[["Plain Short dagger", "white"]]]).changed, false);

console.log("smelting tooltip model tests passed");
