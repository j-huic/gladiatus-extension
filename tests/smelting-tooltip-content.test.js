const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

function itemElement(rawTooltip) {
  const attributes = new Map([["data-tooltip", rawTooltip]]);
  return {
    isConnected: true,
    matches(selector) { return selector === "[data-tooltip][class*='item-i-']"; },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    querySelectorAll() { return []; }
  };
}

const originalTooltip = JSON.stringify([[["Antonius Short dagger of Faith", "#FF6A00"], ["Level 93", "#808080"]]]);
const originalCache = JSON.parse(originalTooltip);
const item = itemElement(originalTooltip);
const jqueryData = new WeakMap([[item, { tooltip: originalCache }]]);

function jQuery(element) {
  const values = jqueryData.get(element) || {};
  jqueryData.set(element, values);
  return {
    data(key, value) {
      if (arguments.length === 1) return values[key];
      values[key] = value;
      return value;
    },
    removeData(key) { delete values[key]; }
  };
}

class MutationObserver {
  constructor(callback) { this.callback = callback; }
  observe() {}
  disconnect() {}
}

const listeners = new Map();
const document = {
  documentElement: {},
  querySelectorAll() { return [item]; }
};
const context = { console, document, jQuery, MutationObserver };
context.Event = class Event { constructor(type) { this.type = type; } };
context.addEventListener = (type, listener) => {
  const group = listeners.get(type) || [];
  group.push(listener);
  listeners.set(type, group);
};
context.dispatchEvent = (event) => {
  for (const listener of listeners.get(event.type) || []) listener(event);
  return true;
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
for (const file of [
  "src/features/smelting/smelting-material-data.js",
  "src/features/smelting/smelting-tooltip-model.js",
  "src/features/smelting/smelting-tooltip-page-bridge.js",
  "src/features/smelting/smelting-tooltip-content.js"
]) {
  vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
}

(async () => {
  const controller = context.GladiatusSmeltingTooltipFeature;
  const bridge = context.GladiatusSmeltingTooltipPageBridge;
  await controller.start();

  const enrichedAttribute = JSON.parse(item.getAttribute("data-tooltip"));
  const enrichedCache = jQuery(item).data("tooltip");
  assert.ok(enrichedAttribute[0].some((row) => row[0] === "Antonius (92)"));
  assert.ok(enrichedAttribute[0].some((row) => row[0] === "of Faith (70)"));
  assert.ok(enrichedCache[0].some((row) => row[0] === "- 4 × Dragon Scale"));
  assert.equal(item.getAttribute("data-glad-smelting-tooltip-version"), "smelting-tooltip-page-bridge-v3");
  assert.deepEqual(JSON.parse(JSON.stringify(controller.getStatus())), { active: true });
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getStatus())), { active: true, enrichedItems: 1 });

  await controller.stop();
  assert.equal(item.getAttribute("data-tooltip"), originalTooltip);
  assert.deepEqual(JSON.parse(JSON.stringify(jQuery(item).data("tooltip"))), originalCache);
  assert.equal(item.getAttribute("data-glad-smelting-tooltip-version"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.getStatus())), { active: false, enrichedItems: 0 });

  console.log("smelting tooltip content tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
