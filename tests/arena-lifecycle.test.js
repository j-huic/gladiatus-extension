const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    count(type) {
      return listeners.get(type)?.size || 0;
    },
    total() {
      return Array.from(listeners.values()).reduce((total, entries) => total + entries.size, 0);
    }
  };
}

function makeHarness(url) {
  const rootEvents = eventTarget();
  const documentEvents = eventTarget();
  const runtimeListeners = new Set();
  const storageListeners = new Set();
  const timers = new Map();
  const elements = new Map();
  const observers = [];
  const storage = {};
  const storageWrites = [];
  const messages = [];
  let timerSequence = 0;

  function makeElement(tagName = "div") {
    const element = {
      tagName: tagName.toUpperCase(),
      className: "",
      textContent: "",
      parentElement: null,
      children: [],
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      before(child) { register(child); },
      after(child) { register(child); },
      prepend(child) { register(child); },
      remove() { if (this.id) elements.delete(this.id); },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; }
    };
    return element;
  }

  function register(element) {
    if (element?.id) elements.set(element.id, element);
  }

  const document = {
    ...documentEvents,
    readyState: "complete",
    visibilityState: "visible",
    location: { href: url },
    documentElement: makeElement("html"),
    body: makeElement("body"),
    createElement: makeElement,
    getElementById(id) { return elements.get(id) || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return true; }
  };
  document.body.prepend = register;

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe() { this.observing = true; }
    disconnect() { this.observing = false; }
  }

  const context = {
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    URL,
    Date,
    Math,
    JSON,
    Promise,
    structuredClone,
    document,
    location: { href: url },
    MutationObserver,
    addEventListener: rootEvents.addEventListener,
    removeEventListener: rootEvents.removeEventListener,
    setTimeout(callback) {
      timerSequence += 1;
      timers.set(timerSequence, callback);
      return timerSequence;
    },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      runtime: {
        lastError: null,
        onMessage: {
          addListener(listener) { runtimeListeners.add(listener); },
          removeListener(listener) { runtimeListeners.delete(listener); }
        },
        sendMessage(message, callback) {
          messages.push(message);
          callback?.({ ok: true, results: [] });
        }
      },
      storage: {
        local: {
          async get(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(list.filter((key) => key && Object.hasOwn(storage, key)).map((key) => [key, storage[key]]));
          },
          async set(values) {
            storageWrites.push(values);
            Object.assign(storage, values || {});
          }
        },
        onChanged: {
          addListener(listener) { storageListeners.add(listener); },
          removeListener(listener) { storageListeners.delete(listener); }
        }
      }
    }
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);

  function load(...files) {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
    }
  }

  async function runTimers() {
    const pending = Array.from(timers.entries());
    timers.clear();
    for (const [, callback] of pending) callback();
    await settle();
  }

  return {
    context,
    load,
    runTimers,
    rootEvents,
    documentEvents,
    runtimeListeners,
    storageListeners,
    timers,
    elements,
    observers,
    storageWrites,
    messages
  };
}

async function settle(turns = 5) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function testArenaMainController() {
  const harness = makeHarness("https://s1-en.gladiatus.gameforge.com/game/index.php?mod=arena");
  harness.load("score-model.js", "arena-core.js", "arena-sim.js", "arena-scan.js", "arena-content.js");
  const controller = harness.context.GladiatusArenaFeature;
  assert.ok(controller?.ready);
  assert.equal(harness.runtimeListeners.size, 0, "loading is inert");
  assert.equal(harness.rootEvents.total(), 0);
  assert.equal(harness.observers.some((observer) => observer.observing), false);

  await controller.start({ enabled: false, annotations: true, manualScan: true });
  await controller.start({ enabled: true, annotations: false, manualScan: false });
  assert.equal(harness.runtimeListeners.size, 0, "disabled child capabilities allocate no main controller resources");

  const enabled = { enabled: true, annotations: true, manualScan: true, simulations: true, passiveRefresh: false };
  await controller.start(enabled);
  assert.equal(harness.runtimeListeners.size, 1);
  assert.equal(harness.rootEvents.count("pageshow"), 1);
  assert.equal(harness.rootEvents.count("popstate"), 1);
  assert.equal(harness.rootEvents.count("hashchange"), 1);
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);
  await harness.runTimers();

  await controller.start(enabled);
  await controller.update(enabled);
  assert.equal(harness.runtimeListeners.size, 1, "repeated start/update do not duplicate listeners");
  assert.equal(harness.rootEvents.count("pageshow"), 1);
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);

  await controller.stop();
  await controller.stop();
  assert.equal(harness.runtimeListeners.size, 0);
  assert.equal(harness.storageListeners.size, 0);
  assert.equal(harness.rootEvents.total(), 0);
  assert.equal(harness.documentEvents.total(), 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers.some((observer) => observer.observing), false);
  assert.equal(harness.messages.length, 0);
}

async function testArenaPassiveController() {
  const harness = makeHarness("https://s1-en.gladiatus.gameforge.com/game/index.php?mod=overview");
  harness.context.GladiatusArenaCore = {
    isArenaPageUrl() { return false; },
    arenaKindFromUrl() { return ""; },
    parseFightArgs() { return {}; },
    parseInteger(value) { return Number.parseInt(value, 10) || 0; },
    readArenaOpponentEntries() { return []; }
  };
  harness.load("arena-passive-content.js");
  const controller = harness.context.GladiatusArenaPassiveFeature;
  assert.ok(controller);
  assert.equal(harness.rootEvents.total(), 0, "loading is inert");

  await controller.start({ enabled: false, passiveRefresh: true });
  await controller.start({ enabled: true, passiveRefresh: false });
  assert.equal(harness.rootEvents.total(), 0);
  assert.equal(harness.documentEvents.total(), 0);

  const enabled = { enabled: true, passiveRefresh: true };
  await controller.start(enabled);
  await controller.start(enabled);
  await controller.update(enabled);
  assert.equal(harness.rootEvents.count("focus"), 1);
  assert.equal(harness.rootEvents.count("pageshow"), 1);
  assert.equal(harness.documentEvents.count("visibilitychange"), 1);
  assert.equal(harness.documentEvents.count("click"), 1);
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);

  await controller.stop();
  await controller.stop();
  assert.equal(harness.rootEvents.total(), 0);
  assert.equal(harness.documentEvents.total(), 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers.some((observer) => observer.observing), false);
  assert.equal(harness.messages.length, 0);
}

async function testArenaStatusController() {
  const harness = makeHarness("https://s1-en.gladiatus.gameforge.com/game/index.php?mod=overview");
  harness.context.GladiatusArenaCore = {
    scanStatusStorageKey: "arena-status",
    passiveScansStorageKey: "arena-passive",
    parseInteger(value) { return Number.parseInt(value, 10) || 0; }
  };
  harness.load("arena-status-content.js");
  const controller = harness.context.GladiatusArenaStatusFeature;
  assert.ok(controller);
  assert.equal(harness.storageListeners.size, 0, "loading is inert");

  await controller.start({ enabled: false, statusWidget: true });
  await controller.start({ enabled: true, statusWidget: false });
  assert.equal(harness.timers.size, 0);

  const enabled = { enabled: true, statusWidget: true };
  await controller.start(enabled);
  await harness.runTimers();
  assert.equal(harness.storageListeners.size, 1);
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);
  assert.ok(harness.elements.has("glad-arena-passive-status"));

  await controller.start(enabled);
  await controller.update(enabled);
  assert.equal(harness.storageListeners.size, 1, "repeated start/update do not duplicate storage listeners");
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);

  await controller.stop();
  await controller.stop();
  assert.equal(harness.storageListeners.size, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.observers.some((observer) => observer.observing), false);
  assert.equal(harness.elements.has("glad-arena-passive-status"), false);
}

Promise.resolve()
  .then(testArenaMainController)
  .then(testArenaPassiveController)
  .then(testArenaStatusController)
  .then(() => console.log("arena lifecycle tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
