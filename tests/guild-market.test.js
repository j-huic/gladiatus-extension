const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

class FakeCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.id = "";
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.classList = {
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
      }
    };
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index < 0 ? null : this.parentNode.children[index + 1] || null;
  }

  append(...children) {
    for (const child of children) {
      if (child.parentNode) child.remove();
      child.parentNode = this;
      this.children.push(child);
    }
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.remove();
    const index = reference ? this.children.indexOf(reference) : -1;
    child.parentNode = this;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    if (name === "data-tooltip") return this.dataset.tooltip || null;
    return this.attributes[name] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return true;
  }

  click() {
    this.dispatchEvent({ type: "click" });
  }

  querySelector(selector) {
    if (selector === "[data-tooltip]") return findElement(this, (element) => Boolean(element.dataset.tooltip));
    if (selector.startsWith(".")) {
      const className = selector.slice(1);
      return findElement(this, (element) => element.className.split(/\s+/).includes(className));
    }
    return null;
  }
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

class FakeDocument {
  constructor(url) {
    this.location = { href: url };
    this.listeners = new Map();
    this.documentElement = new FakeElement("html", this);
    this.head = new FakeElement("head", this);
    this.body = new FakeElement("body", this);
    this.documentElement.append(this.head, this.body);

    this.sellForm = new FakeElement("form", this);
    this.sellForm.id = "sellForm";
    this.price = new FakeElement("input", this);
    this.price.id = "preis";
    this.sellId = new FakeElement("input", this);
    this.sellId.attributes.name = "sellid";
    this.sellForm.append(this.price, this.sellId);
    this.body.append(this.sellForm);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }

  getElementById(id) {
    return findElement(this.documentElement, (element) => element.id === id);
  }

  querySelector(selector) {
    if (selector === "#sellForm") return this.sellForm;
    if (selector === "#sellForm [name=\"sellid\"]") return this.sellId;
    const descendant = selector.match(/^#([^ ]+) \.([^ ]+)$/);
    if (descendant) {
      return this.getElementById(descendant[1])?.querySelector(`.${descendant[2]}`) || null;
    }
    if (selector.startsWith("#")) return this.getElementById(selector.slice(1));
    return null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event) {
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener.call(this, event);
    return true;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }
}

function loadScript(file, context) {
  vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
}

function makeContext(document, extra = {}) {
  let timerSequence = 0;
  const timers = new Map();
  const windowListeners = new Map();
  const postedMessages = [];
  let context;
  function dispatchWindowMessage(data) {
    context.__testWindowMessageData = data;
    const event = vm.runInContext(
      "({ type: 'message', source: globalThis, data: __testWindowMessageData })",
      context
    );
    delete context.__testWindowMessageData;
    for (const listener of windowListeners.get("message") || []) {
      listener.call(context.window, event);
    }
  }
  context = {
    console,
    URL,
    Intl,
    CustomEvent: FakeCustomEvent,
    document,
    location: document.location,
    setInterval(callback) {
      timerSequence += 1;
      timers.set(timerSequence, callback);
      return timerSequence;
    },
    clearInterval(timer) {
      timers.delete(timer);
    },
    setTimeout(callback) {
      timerSequence += 1;
      timers.set(timerSequence, callback);
      return timerSequence;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || new Set();
      listeners.add(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      windowListeners.get(type)?.delete(listener);
    },
    postMessage(data) {
      postedMessages.push(data);
      dispatchWindowMessage(data);
    },
    ...extra
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return {
    context,
    timers,
    postedMessages,
    dispatchWindowMessage,
    windowListenerCount(type) { return windowListeners.get(type)?.size || 0; }
  };
}

{
  const doc = new FakeDocument("https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket&sh=secret");
  let originalCalls = 0;
  let calcDuesCalls = 0;
  const originalMarketDrop = function marketDrop() {
    originalCalls += 1;
    doc.sellId.value = "ITEM-1";
    doc.price.value = "6466";
  };
  const { context, postedMessages, timers, windowListenerCount } = makeContext(doc, {
    marketDrop: originalMarketDrop,
    calcDues() {
      calcDuesCalls += 1;
    }
  });

  loadScript("guild-market-core.js", context);
  const core = context.GladiatusGuildMarket;
  assert.equal(core.version, "guild-market-core-v7");
  assert.equal(context.marketDrop, originalMarketDrop, "loading the MAIN core must be inert");
  assert.equal(doc.listenerCount("glad-helper:guild-market:control"), 0, "disabled MAIN core installs no control listener");
  assert.equal(windowListenerCount("message"), 0, "disabled MAIN core installs no window listener");
  assert.deepEqual(JSON.parse(JSON.stringify(core.getStatus())), {
    started: false,
    installed: false,
    waitingForMarketDrop: false,
    hasStagedItem: false
  });
  assert.equal(core.isGuildMarketUrl(doc.location.href), true);
  assert.equal(core.isGuildMarketUrl("http://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket"), false);

  assert.equal(core.start({ enabled: true }), true);
  const wrapper = context.marketDrop;
  assert.notEqual(wrapper, originalMarketDrop);
  assert.equal(wrapper.__gladiatusGuildMarketBridge, true);
  core.start({ enabled: true });
  assert.equal(context.marketDrop, wrapper, "start must be idempotent");

  const miniPumpkin = new FakeElement("div", doc);
  miniPumpkin.dataset.tooltip = '[["Mini-Pumpkin"]]';
  context.marketDrop(miniPumpkin, 20);
  assert.equal(originalCalls, 1);
  assert.equal(doc.price.value, "6466", "staging must preserve the game price");
  assert.equal(calcDuesCalls, 0);
  const staged = postedMessages
    .filter((message) => message.source === core.events.source && message.type === core.events.staged)
    .map((message) => message.detail);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].itemName, "Mini-Pumpkin");
  assert.equal(staged[0].quantity, 20);

  const request = {
    stageId: staged[0].stageId,
    itemName: " mini-pumpkin ",
    quantity: 20,
    unitPrice: 100000,
    price: 2000000
  };
  assert.equal(core.fillPriceField({ ...request, price: 1 }).code, "INVALID_PRICE");
  assert.equal(doc.price.value, "6466");
  assert.equal(core.fillPriceField(request).ok, true);
  assert.equal(doc.price.value, "2000000");
  assert.equal(calcDuesCalls, 1);

  doc.price.value = "6466";
  for (const callback of [...timers.values()]) callback();
  assert.equal(doc.price.value, "2000000", "a delayed competing write is restored during the bounded guard");
  assert.equal(calcDuesCalls, 2);

  doc.price.remove();
  doc.price = new FakeElement("input", doc);
  doc.price.id = "preis";
  doc.sellForm.insertBefore(doc.price, doc.sellId);
  doc.price.value = "6466";
  for (const callback of [...timers.values()]) callback();
  assert.equal(doc.price.value, "2000000", "the guard follows a replacement price field");

  doc.price.value = "12345";
  doc.activeElement = doc.price;
  for (const callback of [...timers.values()]) callback();
  assert.equal(doc.price.value, "12345", "the guard never fights a user editing the field");
  doc.activeElement = null;
  for (const callback of [...timers.values()]) callback();
  assert.equal(doc.price.value, "2000000", "the guard resumes after focus leaves the field");

  context.marketDrop(miniPumpkin, 20);
  for (const callback of [...timers.values()]) callback();
  assert.equal(doc.price.value, "2000000", "a repeated same-item staging call does not cancel the guard");

  doc.sellId.value = "ITEM-2";
  assert.equal(core.fillPriceField(request).code, "STALE_ITEM");
  core.stop();
  assert.equal(context.marketDrop, originalMarketDrop);
  assert.equal(core.getStatus().started, false);
  assert.equal(core.fillPriceField(request).code, "FEATURE_DISABLED");
  assert.equal(core.stop(), true, "stop must be idempotent");

  core.start({ enabled: true });
  const ownedWrapper = context.marketDrop;
  const thirdPartyWrapper = function thirdPartyWrapper() {
    return ownedWrapper.apply(this, arguments);
  };
  context.marketDrop = thirdPartyWrapper;
  core.stop();
  assert.equal(context.marketDrop, thirdPartyWrapper, "stop must not replace a wrapper it no longer owns");
  thirdPartyWrapper(miniPumpkin, 1);
  assert.equal(staged.length, 1, "an orphaned owned wrapper stays inert after stop");
}

async function testIntegratedController() {
  const doc = new FakeDocument("https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket");
  let calcDuesCalls = 0;
  let forwardMainMessage = () => {};
  const originalMarketDrop = function marketDrop(to) {
    doc.sellId.value = to.sellId || "ITEM-1";
    doc.price.value = "7000";
  };
  const mainHarness = makeContext(doc, {
    marketDrop: originalMarketDrop,
    calcDues() {
      calcDuesCalls += 1;
    },
    postMessage(data) {
      forwardMainMessage(data);
    }
  });
  const main = mainHarness.context;
  const isolatedHarness = makeContext(doc, {
    chrome: {
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          Promise.resolve().then(() => {
            if (message.type === "GLAD_GUILD_MARKET_CONTROL") {
              const result = message.action === "stop"
                ? main.GladiatusGuildMarket.stop()
                : main.GladiatusGuildMarket[message.action](message.settings || {});
              callback({ ok: true, result });
              return;
            }
            if (message.type === "GLAD_GUILD_MARKET_FILL") {
              callback({ ok: true, result: main.GladiatusGuildMarket.fillPriceField(message.request) });
              return;
            }
            callback({ ok: false, error: "Unknown message" });
          }).catch((error) => callback({ ok: false, error: error.message }));
        }
      }
    }
  });
  const isolated = isolatedHarness.context;
  forwardMainMessage = (data) => isolatedHarness.dispatchWindowMessage(data);
  loadScript("guild-market-core.js", main);
  loadScript("guild-market-content.js", isolated);

  const controller = isolated.GladiatusGuildMarketController;
  const validation = controller.validateRules([
    { id: "one", itemName: " Mini-Pumpkin ", pricePerUnit: 100000, enabled: true },
    { id: "two", itemName: "mini-pumpkin", pricePerUnit: 200000, enabled: true },
    { id: "bad", itemName: "Apple", pricePerUnit: 1.5, enabled: true }
  ]);
  assert.equal(validation.valid, false);
  assert.equal(validation.rules.length, 1);
  assert.deepEqual(Array.from(validation.errors, (error) => error.code), ["DUPLICATE_ITEM", "INVALID_UNIT_PRICE"]);
  assert.equal(controller.matchRule("MINI- PUMPKIN", validation.rules), null);
  assert.equal(controller.matchRule("mini-pumpkin", validation.rules).id, "one");
  assert.equal(
    controller.matchRule("Antonius Meat Haunch of domination", [
      { id: "test-meat-haunch", itemName: "Meat Haunch", pricePerUnit: 100000, enabled: true }
    ]).id,
    "test-meat-haunch",
    "matching rules use the configured item-name substring"
  );
  assert.equal(controller.calculateSuggestion({ quantity: Number.MAX_SAFE_INTEGER }, { pricePerUnit: 2 }), null);

  const settings = {
    enabled: true,
    mode: "automatic",
    rules: [{ id: "mini", itemName: "Mini-Pumpkin", pricePerUnit: 100000, enabled: true }]
  };
  assert.equal(await controller.start(settings), true);
  assert.equal(await controller.start(settings), true);
  assert.equal(await controller.update(settings), true);
  assert.equal(isolatedHarness.windowListenerCount("message"), 1, "start/update are idempotent");
  assert.equal(main.GladiatusGuildMarket.getStatus().installed, true);

  const miniPumpkin = new FakeElement("div", doc);
  miniPumpkin.dataset.tooltip = '[["Mini-Pumpkin"]]';
  miniPumpkin.sellId = "ITEM-1";
  main.marketDrop(miniPumpkin, 20);
  assert.equal(doc.price.value, "7000", "the game stages its native price before the isolated bridge responds");
  await settle();
  assert.equal(doc.price.value, "2000000", "a matching rule must fill automatically");
  assert.equal(calcDuesCalls, 1);
  assert.equal(doc.getElementById("glad-guild-market-suggestion"), null, "automatic pricing injects no page panel");
  assert.equal(doc.getElementById("glad-guild-market-style"), null, "automatic pricing injects no page styles");

  const meatHaunch = new FakeElement("div", doc);
  meatHaunch.dataset.tooltip = '[["Antonius Meat Haunch of domination"]]';
  meatHaunch.sellId = "ITEM-2";
  main.marketDrop(meatHaunch, 3);
  await settle();
  assert.equal(doc.price.value, "300000", "Meat Haunch variants use the matching substring rule");

  doc.price.value = "12345";
  await settle();
  assert.equal(doc.price.value, "12345", "manual edits are not reasserted");

  main.marketDrop(miniPumpkin, 2);
  doc.sellId.value = "DIFFERENT-ITEM";
  await settle();
  assert.equal(doc.price.value, "7000", "a stale automatic calculation must not overwrite the field");

  await controller.stop();
  await controller.stop();
  assert.equal(main.marketDrop, originalMarketDrop);
  assert.equal(doc.getElementById("glad-guild-market-suggestion"), null);
  assert.equal(doc.getElementById("glad-guild-market-style"), null);
  assert.equal(isolatedHarness.windowListenerCount("message"), 0, "the isolated staged-item listener is removed");
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

testIntegratedController()
  .then(() => console.log("guild market tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
