const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

const context = { console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(repoFile("src/features/smelting/smelting-material-data.js"), "utf8"),
  context,
  { filename: "smelting-material-data.js" }
);

const data = context.GladiatusSmeltingMaterialData;
assert.equal(data.version, "smelting-material-data-v2");
assert.deepEqual(
  { ...data.materialsFor("prefix", "Antonius") },
  { "Dragon Scale": 4, Amethyst: 18, Crystal: 30, "Gold Ore": 3 }
);
assert.deepEqual(
  { ...data.materialsFor("suffix", "of Faith") },
  { "Waters of Oblivion": 27, Cuprit: 6, Jasper: 8 }
);
assert.deepEqual(
  { ...data.materialsForItem("antonius", "OF FAITH") },
  {
    "Dragon Scale": 4,
    Amethyst: 18,
    Crystal: 30,
    "Gold Ore": 3,
    "Waters of Oblivion": 27,
    Cuprit: 6,
    Jasper: 8
  }
);
assert.deepEqual({ ...data.materialsFor("prefix", "Unknown affix") }, {});
assert.equal(data.levelFor("prefix", "antonius"), 92);
assert.equal(data.levelFor("suffix", "OF FAITH"), 70);
assert.equal(data.levelFor("prefix", "Unknown affix"), null);
assert.ok(data.materialNames.includes("Dragon Scale"));
assert.ok(data.materialNames.includes("Waters of Oblivion"));
assert.equal(new Set(data.materialNames).size, data.materialNames.length, "material names are unique");

console.log("smelting material data tests passed");
