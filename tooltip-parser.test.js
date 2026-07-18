const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = __dirname;

function run(file, context) {
  vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
}

{
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  run("tooltip-parser.js", context);

  const parser = context.GladiatusTooltipParser;
  assert.equal(parser.version, "tooltip-parser-v1");
  assert.equal(parser.parseLinesFromValue, parser.parseTooltipLinesFromValue);
  assert.deepEqual(Array.from(parser.parseTooltipLinesFromValue("")), []);
  assert.deepEqual(Array.from(parser.parseTooltipLinesFromValue("not json")), []);
  assert.deepEqual(Array.from(parser.parseTooltipLinesFromValue(JSON.stringify({ invalid: true }))), []);

  const raw = JSON.stringify([["<b>Mini-Pumpkin</b>", ["Damage&nbsp;+5"], "", "Using:<br>Heals 10"]]);
  assert.deepEqual(Array.from(parser.parseTooltipLinesFromValue(raw)), [
    "Mini-Pumpkin",
    "Damage&nbsp;+5",
    "Using: Heals 10"
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(parser.parseItemTooltipFromValue(raw))), [
    "<b>Mini-Pumpkin</b>",
    ["Damage&nbsp;+5"],
    "",
    "Using:<br>Heals 10"
  ]);
}

{
  const document = {
    createElement() {
      let text = "";
      return {
        set innerHTML(value) {
          text = String(value || "")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&");
        },
        get textContent() {
          return text;
        }
      };
    }
  };
  const context = { console, document };
  context.globalThis = context;
  vm.createContext(context);
  run("tooltip-parser.js", context);

  const raw = JSON.stringify([["<span>Mini&nbsp;&amp;&nbsp;Pumpkin</span>"]]);
  assert.deepEqual(Array.from(context.GladiatusTooltipParser.parseTooltipLinesFromValue(raw)), ["Mini & Pumpkin"]);
}

{
  const calls = [];
  const context = {
    console,
    URL,
    chrome: { runtime: { id: "test-extension" } },
    GladiatusTooltipParser: {
      parseTooltipLinesFromValue(raw, doc) {
        calls.push(["lines", raw, doc]);
        return ["delegated lines"];
      },
      parseItemTooltipFromValue(raw) {
        calls.push(["item", raw]);
        return ["delegated item"];
      }
    }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  run("auction-schema.js", context);
  run("auction-core.js", context);

  const doc = { id: "test-document" };
  assert.deepEqual(Array.from(context.GladiatusAuctionCore.parseTooltipLinesFromValue("raw", doc)), ["delegated lines"]);
  assert.deepEqual(Array.from(context.GladiatusAuctionCore.parseItemTooltipFromValue("raw")), ["delegated item"]);
  assert.equal(calls[0][0], "lines");
  assert.equal(calls[0][1], "raw");
  assert.equal(calls[0][2], doc);
  assert.deepEqual(calls[1], ["item", "raw"]);
}

console.log("tooltip parser tests passed");
