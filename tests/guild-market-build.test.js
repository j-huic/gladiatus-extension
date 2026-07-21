const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const buildTool = require("../scripts/build-guild-market.js");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function recursiveFiles(directory, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...recursiveFiles(directory, relative));
    else files.push(relative);
  }
  return files.sort();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function makeStorage(initial = {}) {
  const state = clone(initial);
  const listeners = new Set();
  const getCalls = [];
  const local = {
    async get(keys) {
      getCalls.push(clone(keys));
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, clone(state[key])]).filter((entry) => entry[1] !== undefined));
      }
      if (typeof keys === "string") return state[keys] === undefined ? {} : { [keys]: clone(state[keys]) };
      if (keys && typeof keys === "object") {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, clone(state[key] ?? fallback)]));
      }
      return clone(state);
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
        state[key] = clone(value);
      }
      for (const listener of [...listeners]) listener(changes, "local");
    },
    async remove(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of requested) {
        if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
        changes[key] = { oldValue: clone(state[key]), newValue: undefined };
        delete state[key];
      }
      for (const listener of [...listeners]) listener(changes, "local");
    }
  };
  return {
    state,
    getCalls,
    local,
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    },
    listenerCount() { return listeners.size; }
  };
}

function loadSettings(file, initial = {}) {
  const storage = makeStorage(initial);
  const context = {
    console,
    structuredClone,
    chrome: { storage: { local: storage.local, onChanged: storage.onChanged } }
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { settings: context.GladiatusGuildMarketSettings, storage, context };
}

function makeBackgroundContext(packageDir, initial = {}, options = {}) {
  const storage = makeStorage(initial);
  const installedListeners = [];
  const messageListeners = [];
  const executeCalls = [];
  let context;
  const chrome = {
    storage: { local: storage.local, onChanged: storage.onChanged },
    runtime: {
      onInstalled: { addListener(listener) { installedListeners.push(listener); } },
      onMessage: { addListener(listener) { messageListeners.push(listener); } }
    },
    scripting: {
      async executeScript(details) {
        executeCalls.push(details);
        await options.onExecute?.(details, storage);
        if (options.executeResult) return clone(options.executeResult);
        return [{ result: { ok: true, result: { method: details.args[0] } } }];
      }
    }
  };
  context = {
    console,
    URL,
    structuredClone,
    chrome,
    importScripts(...names) {
      for (const name of names) {
        vm.runInContext(fs.readFileSync(path.join(packageDir, name), "utf8"), context, { filename: name });
      }
    }
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(packageDir, "background.js"), "utf8"), context, { filename: "background.js" });
  return { context, storage, installedListeners, messageListeners, executeCalls };
}

function guildSender(url = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket&sh=secret") {
  return { tab: { id: 47, url } };
}

function makePopupElement(options = {}) {
  const listeners = new Map();
  const classes = new Set(options.classes || []);
  return {
    disabled: options.disabled === true,
    value: options.value || "",
    textContent: "",
    attributes: {},
    validityMessage: "",
    reportValidityCalls: 0,
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); }
    },
    querySelector() { return null; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    setCustomValidity(message) { this.validityMessage = String(message); },
    reportValidity() { this.reportValidityCalls += 1; return !this.validityMessage; },
    async dispatch(type, extra = {}) {
      const event = { type, preventDefault() {}, ...extra };
      await Promise.all((listeners.get(type) || []).map((listener) => listener.call(this, event)));
    }
  };
}

async function testSettings(settingsFile) {
  {
    const { settings, storage } = loadSettings(settingsFile);
    assert.deepEqual(clone(await settings.get()), { version: 1, enabled: false, pricePerUnit: 100000 });
    assert.deepEqual(storage.getCalls, [settings.storageKey, settings.legacySettingsKey]);
    assert.deepEqual(storage.state[settings.storageKey], { version: 1, enabled: false, pricePerUnit: 100000 });
    storage.getCalls.length = 0;
    await settings.get();
    assert.deepEqual(storage.getCalls, [settings.storageKey], "normal reads must not touch the full-build settings record");
    assert.deepEqual(clone(settings.toFeatureSettings({ enabled: true, pricePerUnit: 123456 })), {
      enabled: true,
      mode: "automatic",
      rules: [{
        id: "mini-pumpkin",
        itemName: "Mini-Pumpkin",
        pricePerUnit: 123456,
        enabled: true
      }]
    });
    assert.deepEqual(clone(await settings.update({ enabled: true, pricePerUnit: 250000 })), {
      version: 1,
      enabled: true,
      pricePerUnit: 250000
    });
    assert.equal((await settings.update({ pricePerUnit: -1 })).pricePerUnit, 250000);
    assert.deepEqual(clone(await settings.update((draft) => {
      draft.pricePerUnit = 260000;
    })), { version: 1, enabled: true, pricePerUnit: 260000 });

    let observed = null;
    const unsubscribe = settings.subscribe((next) => { observed = clone(next); });
    assert.equal(storage.listenerCount(), 1);
    await storage.local.remove(settings.storageKey);
    assert.deepEqual(observed, { version: 1, enabled: false, pricePerUnit: 100000 });
    unsubscribe();
    assert.equal(storage.listenerCount(), 0);
  }

  {
    const legacy = {
      version: 1,
      features: {
        guildMarket: {
          enabled: true,
          rules: [
            { id: "other", itemName: "Other Item", pricePerUnit: 5, enabled: true },
            { id: "pumpkin", itemName: "  mini-pumpkin  ", pricePerUnit: 175000, enabled: true }
          ]
        }
      }
    };
    const before = clone(legacy);
    const { settings, storage } = loadSettings(settingsFile, { "glad-helper-settings-v1": legacy });
    assert.deepEqual(clone(await settings.get()), { version: 1, enabled: true, pricePerUnit: 175000 });
    assert.deepEqual(storage.state["glad-helper-settings-v1"], before, "migration must not rewrite the full-build record");
    storage.state["glad-helper-settings-v1"].features.guildMarket.rules[1].pricePerUnit = 999999;
    storage.getCalls.length = 0;
    assert.equal((await settings.get()).pricePerUnit, 175000, "migration must be idempotent once the dedicated key exists");
    assert.deepEqual(storage.getCalls, [settings.storageKey]);
  }

  {
    const { settings } = loadSettings(settingsFile, {
      "glad-helper-settings-v1": {
        features: { guildMarket: { enabled: true, rules: [] } }
      }
    });
    assert.deepEqual(clone(await settings.get()), { version: 1, enabled: false, pricePerUnit: 100000 });
  }

  {
    const { settings, storage } = loadSettings(settingsFile, {
      "glad-guild-market-settings-v1": { version: "bad", enabled: "yes", pricePerUnit: -500 }
    });
    assert.deepEqual(clone(await settings.get()), { version: 1, enabled: false, pricePerUnit: 100000 });
    assert.deepEqual(storage.state[settings.storageKey], { version: 1, enabled: false, pricePerUnit: 100000 });
  }
}

async function testBackground(packageDir) {
  const env = makeBackgroundContext(packageDir);
  const settings = env.context.GladiatusGuildMarketSettings;
  const background = env.context.GladiatusGuildMarketBackground;
  await settings.get();
  assert.equal(env.messageListeners.length, 1);
  assert.equal(env.installedListeners.length, 1);
  assert.equal(background.isKnownMessage({ type: "GLAD_GUILD_MARKET_CONTROL" }), true);
  assert.equal(background.isKnownMessage({ type: "UNRELATED_MESSAGE" }), false);

  await assert.rejects(
    background.handleMessage({ type: "GLAD_GUILD_MARKET_CONTROL", action: "start" }, guildSender()),
    (error) => error.code === "FEATURE_DISABLED"
  );
  assert.equal(env.executeCalls.length, 0, "disabled start must not enter the MAIN world");

  await background.handleMessage({ type: "GLAD_GUILD_MARKET_CONTROL", action: "stop" }, guildSender());
  assert.equal(env.executeCalls.at(-1).args[0], "stop", "stop remains available for cleanup while disabled");

  await assert.rejects(
    background.handleMessage(
      { type: "GLAD_GUILD_MARKET_CONTROL", action: "stop" },
      guildSender("https://s47-en.gladiatus.gameforge.com/game/index.php?mod=somewhereElse")
    ),
    (error) => error.code === "INVALID_SENDER"
  );
  for (const invalidSender of [
    guildSender("http://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket"),
    guildSender("https://gladiatus.gameforge.com.evil.example/game/index.php?mod=guildMarket"),
    { tab: { url: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket" } }
  ]) {
    await assert.rejects(
      background.handleMessage({ type: "GLAD_GUILD_MARKET_CONTROL", action: "stop" }, invalidSender),
      (error) => error.code === "INVALID_SENDER"
    );
  }

  await assert.rejects(
    background.handleMessage({ type: "GLAD_GUILD_MARKET_CONTROL", action: "restart" }, guildSender()),
    (error) => error.code === "INVALID_REQUEST"
  );

  await settings.update({ enabled: true });
  await background.handleMessage({ type: "GLAD_GUILD_MARKET_CONTROL", action: "start" }, guildSender());
  assert.equal(env.executeCalls.at(-1).args[0], "start");
  assert.deepEqual(clone(env.executeCalls.at(-1).args[1]), [{ enabled: true }]);

  await background.handleMessage({
    type: "GLAD_GUILD_MARKET_FILL",
    request: {
      requestId: "request-1",
      stageId: "stage-1",
      itemName: " Mini-Pumpkin ",
      quantity: "20",
      unitPrice: "100000",
      price: "2000000",
      ruleId: "mini-pumpkin",
      unrelatedSecret: "must-not-cross-world"
    }
  }, guildSender());
  const fillCall = env.executeCalls.at(-1);
  assert.equal(fillCall.args[0], "fillPriceField");
  assert.deepEqual(clone(fillCall.args[1]), [{
    requestId: "request-1",
    stageId: "stage-1",
    itemName: "Mini-Pumpkin",
    quantity: 20,
    unitPrice: 100000,
    price: 2000000,
    ruleId: "mini-pumpkin"
  }]);

  for (const [requestPatch, code] of [
    [{ itemName: "Other Item" }, "INVALID_ITEM"],
    [{ ruleId: "other-rule" }, "INVALID_ITEM"],
    [{ unitPrice: 99999, price: 1999980 }, "INVALID_PRICE"],
    [{ quantity: Number.MAX_SAFE_INTEGER, price: Number.MAX_SAFE_INTEGER }, "INVALID_PRICE"]
  ]) {
    const baseline = {
      requestId: "request-invalid",
      stageId: "stage-1",
      itemName: "Mini-Pumpkin",
      quantity: 20,
      unitPrice: 100000,
      price: 2000000,
      ruleId: "mini-pumpkin"
    };
    const callsBefore = env.executeCalls.length;
    await assert.rejects(
      background.handleMessage({
        type: "GLAD_GUILD_MARKET_FILL",
        request: { ...baseline, ...requestPatch }
      }, guildSender()),
      (error) => error.code === code
    );
    assert.equal(env.executeCalls.length, callsBefore, "invalid pumpkin requests must not enter the MAIN world");
  }

  env.storage.state[settings.storageKey] = { version: 1, enabled: false, pricePerUnit: 100000 };
  await assert.rejects(
    background.handleMessage({ type: "GLAD_GUILD_MARKET_FILL", request: {} }, guildSender()),
    (error) => error.code === "FEATURE_DISABLED",
    "each mutating request must re-read the persisted switch instead of trusting a stale worker cache"
  );

  const lateDisable = makeBackgroundContext(packageDir, {
    "glad-guild-market-settings-v1": { version: 1, enabled: true, pricePerUnit: 100000 }
  }, {
    onExecute(details, storage) {
      if (details.args[0] === "fillPriceField") {
        storage.state["glad-guild-market-settings-v1"].enabled = false;
      }
    }
  });
  await assert.rejects(
    lateDisable.context.GladiatusGuildMarketBackground.handleMessage({
      type: "GLAD_GUILD_MARKET_FILL",
      request: {
        requestId: "request-late-disable",
        stageId: "stage-1",
        itemName: "Mini-Pumpkin",
        quantity: 20,
        unitPrice: 100000,
        price: 2000000,
        ruleId: "mini-pumpkin"
      }
    }, guildSender()),
    (error) => error.code === "FEATURE_DISABLED"
  );
  assert.deepEqual(lateDisable.executeCalls.map((call) => call.args[0]), ["fillPriceField", "stop"]);

  const latePriceChange = makeBackgroundContext(packageDir, {
    "glad-guild-market-settings-v1": { version: 1, enabled: true, pricePerUnit: 100000 }
  }, {
    onExecute(details, storage) {
      if (details.args[0] === "fillPriceField") {
        storage.state["glad-guild-market-settings-v1"].pricePerUnit = 125000;
      }
    }
  });
  await assert.rejects(
    latePriceChange.context.GladiatusGuildMarketBackground.handleMessage({
      type: "GLAD_GUILD_MARKET_FILL",
      request: {
        requestId: "request-late-price",
        stageId: "stage-1",
        itemName: "Mini-Pumpkin",
        quantity: 20,
        unitPrice: 100000,
        price: 2000000,
        ruleId: "mini-pumpkin"
      }
    }, guildSender()),
    (error) => error.code === "STALE_SETTING"
  );
  assert.deepEqual(
    latePriceChange.executeCalls.map((call) => call.args[0]),
    ["fillPriceField"],
    "a unit-price change must reject a stale fill without stopping an otherwise enabled bridge"
  );

  const bridgeFailure = makeBackgroundContext(packageDir, {
    "glad-guild-market-settings-v1": { version: 1, enabled: true, pricePerUnit: 100000 }
  }, {
    executeResult: [{ result: { ok: false, code: "BRIDGE_UNAVAILABLE", error: "missing bridge" } }]
  });
  await assert.rejects(
    bridgeFailure.context.GladiatusGuildMarketBackground.handleMessage(
      { type: "GLAD_GUILD_MARKET_CONTROL", action: "start" },
      guildSender()
    ),
    (error) => error.code === "BRIDGE_UNAVAILABLE"
  );
}

async function testRuntime(runtimeFile) {
  {
    let getCalls = 0;
    let subscribeCalls = 0;
    const context = {
      console,
      location: { href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=somewhereElse" },
      GladiatusGuildMarketSettings: {
        get() { getCalls += 1; },
        subscribe() { subscribeCalls += 1; },
        toFeatureSettings(value) { return value; }
      },
      GladiatusGuildMarketController: {
        isGuildMarketUrl() { return false; },
        getStatus() { return { started: false }; }
      }
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(runtimeFile, "utf8"), context, { filename: runtimeFile });
    assert.equal(await context.GladiatusGuildMarketRuntimeReady, false);
    assert.equal(getCalls, 0, "irrelevant pages must not read extension settings");
    assert.equal(subscribeCalls, 0, "irrelevant pages must not add a settings listener");
  }

  {
    let listener = null;
    const calls = [];
    const context = {
      console,
      location: { href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket" },
      GladiatusGuildMarketSettings: {
        async get() { return { enabled: false, pricePerUnit: 100000 }; },
        subscribe(next) { listener = next; return () => { listener = null; }; },
        toFeatureSettings(value) {
          return { enabled: value.enabled === true, mode: "automatic", rules: [{ pricePerUnit: value.pricePerUnit }] };
        }
      },
      GladiatusGuildMarketController: {
        isGuildMarketUrl() { return true; },
        async start(settings) { calls.push(["start", settings]); return true; },
        async update(settings) { calls.push(["update", settings]); return true; },
        async stop() { calls.push(["stop"]); return true; },
        getStatus() { return { started: calls.some((call) => call[0] === "start") }; }
      }
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(runtimeFile, "utf8"), context, { filename: runtimeFile });
    await context.GladiatusGuildMarketRuntimeReady;
    assert.deepEqual(clone(calls), [["stop"]]);
    listener({ enabled: true, pricePerUnit: 100000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1)[0], "start");
    listener({ enabled: true, pricePerUnit: 120000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1)[0], "update");
    listener({ enabled: false, pricePerUnit: 120000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.at(-1)[0], "stop");
    const listenerBeforeSecondStart = listener;
    await context.GladiatusGuildMarketRuntime.start();
    assert.equal(listener, listenerBeforeSecondStart, "runtime start must be idempotent");
    await context.GladiatusGuildMarketRuntime.stop();
    assert.equal(listener, null);
  }

  {
    let listener = null;
    let resolveInitialRead;
    const calls = [];
    const initialRead = new Promise((resolve) => { resolveInitialRead = resolve; });
    const context = {
      console,
      location: { href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket" },
      GladiatusGuildMarketSettings: {
        get() { return initialRead; },
        subscribe(next) { listener = next; return () => {}; },
        toFeatureSettings(value) { return { enabled: value.enabled, rules: [{ pricePerUnit: value.pricePerUnit }] }; }
      },
      GladiatusGuildMarketController: {
        isGuildMarketUrl() { return true; },
        async start() { calls.push("start"); return true; },
        async update() { calls.push("update"); return true; },
        async stop() { calls.push("stop"); return true; },
        getStatus() { return {}; }
      }
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(runtimeFile, "utf8"), context, { filename: runtimeFile });
    listener({ enabled: true, pricePerUnit: 100000 });
    await new Promise((resolve) => setImmediate(resolve));
    resolveInitialRead({ enabled: false, pricePerUnit: 100000 });
    await context.GladiatusGuildMarketRuntimeReady;
    assert.deepEqual(calls, ["start"], "a stale initial read must not overwrite a newer storage event");
  }
}

async function testPopup(packageDir) {
  const storage = makeStorage();
  const enabledSwitch = makePopupElement({ disabled: true });
  const switchLabel = makePopupElement();
  const priceForm = makePopupElement();
  const unitPrice = makePopupElement({ disabled: true });
  const savePrice = makePopupElement({ disabled: true });
  const status = makePopupElement();
  enabledSwitch.querySelector = (selector) => selector === ".switch-label" ? switchLabel : null;
  const elements = {
    "enabled-switch": enabledSwitch,
    "price-form": priceForm,
    "unit-price": unitPrice,
    "save-price": savePrice,
    status
  };
  const context = {
    console,
    Intl,
    structuredClone,
    chrome: { storage: { local: storage.local, onChanged: storage.onChanged } },
    document: { getElementById(id) { return elements[id] || null; } }
  };
  context.self = context;
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["settings.js", "popup.js"]) {
    vm.runInContext(fs.readFileSync(path.join(packageDir, file), "utf8"), context, { filename: file });
  }
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enabledSwitch.disabled, false);
  assert.equal(enabledSwitch.attributes["aria-checked"], "false");
  assert.equal(switchLabel.textContent, "Off");
  assert.equal(unitPrice.value, "100000");
  assert.equal(unitPrice.disabled, true);

  await enabledSwitch.dispatch("click");
  assert.equal(enabledSwitch.attributes["aria-checked"], "true");
  assert.equal(switchLabel.textContent, "On");
  assert.equal(unitPrice.disabled, false);
  assert.equal(storage.state[context.GladiatusGuildMarketSettings.storageKey].enabled, true);

  unitPrice.value = "0";
  await priceForm.dispatch("submit");
  assert.equal(unitPrice.reportValidityCalls, 1);
  assert.ok(unitPrice.validityMessage);
  assert.equal(status.classList.contains("error"), true);

  unitPrice.value = "135000";
  await unitPrice.dispatch("input");
  assert.equal(unitPrice.validityMessage, "");
  assert.equal(status.textContent, "");
  assert.equal(status.classList.contains("error"), false);
  await priceForm.dispatch("submit");
  assert.equal(storage.state[context.GladiatusGuildMarketSettings.storageKey].pricePerUnit, 135000);
  assert.match(status.textContent, /Saved 135,000 gold/);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gladiatus-guild-build-"));
  try {
    const packageA = path.join(tempRoot, "package-a");
    const packageB = path.join(tempRoot, "package-b");
    const zipA = path.join(tempRoot, "package-a.zip");
    const zipB = path.join(tempRoot, "package-b.zip");
    buildTool.build({ outputDir: packageA, zipPath: zipA });
    buildTool.build({ outputDir: packageB, zipPath: zipB });

    const expectedFiles = buildTool.files.map((entry) => entry[1]).sort();
    assert.deepEqual(recursiveFiles(packageA), expectedFiles, "release directory must use the exact allowlist");
    assert.deepEqual(recursiveFiles(packageB), expectedFiles);
    for (const file of expectedFiles) {
      assert.equal(sha256(path.join(packageA, file)), sha256(path.join(packageB, file)), `${file} must build reproducibly`);
    }
    assert.equal(sha256(zipA), sha256(zipB), "release ZIP must be reproducible");
    const firstZipHash = sha256(zipA);
    buildTool.build({ outputDir: packageA, zipPath: zipA });
    assert.equal(sha256(zipA), firstZipHash, "an owned target must rebuild safely and reproducibly");

    assert.throws(
      () => buildTool.copyReleaseFiles(path.join(rootDir, "targets", "guild-market")),
      /unsafe output directory/,
      "the build must never accept a source directory as its output"
    );
    assert.equal(fs.existsSync(path.join(rootDir, "targets", "guild-market", "manifest.json")), true);
    const unownedDirectory = path.join(tempRoot, "unowned-directory");
    fs.mkdirSync(unownedDirectory);
    fs.writeFileSync(path.join(unownedDirectory, "keep.txt"), "keep", "utf8");
    assert.throws(() => buildTool.copyReleaseFiles(unownedDirectory), /not owned by this build/);
    assert.equal(fs.readFileSync(path.join(unownedDirectory, "keep.txt"), "utf8"), "keep");
    const unownedZip = path.join(tempRoot, "unowned.zip");
    fs.writeFileSync(unownedZip, "keep", "utf8");
    assert.throws(() => buildTool.createReleaseZip(packageA, unownedZip), /not owned by this build/);
    assert.equal(fs.readFileSync(unownedZip, "utf8"), "keep");

    const manifest = JSON.parse(fs.readFileSync(path.join(packageA, "manifest.json"), "utf8"));
    assert.equal(manifest.name, "Gladiatus Guild Market Helper (Unofficial)");
    assert.deepEqual(manifest.permissions, ["storage", "scripting"]);
    assert.ok(manifest.description.length <= 132);
    assert.deepEqual(manifest.host_permissions, ["https://*.gladiatus.gameforge.com/game/index.php*"]);
    assert.deepEqual(manifest.icons, { "128": "icon128.png" });
    assert.deepEqual(manifest.action.default_icon, { "128": "icon128.png" });
    const icon = fs.readFileSync(path.join(packageA, "icon128.png"));
    assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(icon.readUInt32BE(16), 128);
    assert.equal(icon.readUInt32BE(20), 128);
    assert.deepEqual(manifest.background, { service_worker: "background.js" });
    assert.equal(manifest.web_accessible_resources, undefined);
    assert.deepEqual(manifest.content_scripts.map((entry) => entry.js), [
      ["guild-market-core.js"],
      ["settings.js", "guild-market-content.js", "runtime.js"]
    ]);
    assert.deepEqual(manifest.content_scripts.map((entry) => entry.include_globs), [
      ["*://*.gladiatus.gameforge.com/game/index.php*mod=guildMarket*"],
      ["*://*.gladiatus.gameforge.com/game/index.php*mod=guildMarket*"]
    ]);
    assert.deepEqual(manifest.content_scripts.map((entry) => entry.world || "ISOLATED"), ["MAIN", "ISOLATED"]);
    assert.equal(manifest.content_scripts.some((entry) => entry.css), false);

    const popupHtml = fs.readFileSync(path.join(packageA, "popup.html"), "utf8");
    assert.match(popupHtml, /role="switch"[^>]+aria-checked="false"/);
    assert.match(popupHtml, /aria-live="polite"/);
    for (const reference of ["popup.css", "settings.js", "popup.js"]) {
      assert.equal(fs.existsSync(path.join(packageA, reference)), true, `${reference} must be packaged`);
      assert.match(popupHtml, new RegExp(reference.replace(".", "\\.")));
    }

    const packageText = expectedFiles
      .filter((file) => /\.(?:js|json|html|css)$/.test(file))
      .map((file) => fs.readFileSync(path.join(packageA, file), "utf8"))
      .join("\n");
    assert.doesNotMatch(packageText, /Apply suggested price|glad-guild-market-apply|GLAD_GUILD_MARKET_APPLY/);
    for (const [label, pattern] of [
      ["unrelated feature name", /\b(?:auction|arena)\b/i],
      ["unrelated message route", /GLAD_(?:AUCTION|ARENA|FEATURE_REPAIR)/],
      ["unrelated feature global", /Gladiatus(?:Auction|Arena)/],
      ["unrelated storage key", /glad-(?:ah|arena)-/i],
      ["network fetch", /\bfetch\s*\(/],
      ["XHR", /XMLHttpRequest/],
      ["WebSocket", /\bWebSocket\b/],
      ["alarms", /chrome\.alarms/],
      ["dynamic code", /\beval\s*\(|\bnew\s+Function\b/],
      ["form submission", /\.submit\s*\(|\brequestSubmit\s*\(/],
      ["downloads", /chrome\.downloads/],
      ["tab inspection", /chrome\.tabs/],
      ["combat or listing endpoint", /mod=(?:fight|arena|auction)|guildMarket[^\n]*(?:POST|submit)/i]
    ]) {
      assert.doesNotMatch(packageText, pattern, `package must not contain ${label}`);
    }

    for (const file of expectedFiles.filter((name) => name.endsWith(".js"))) {
      childProcess.execFileSync(process.execPath, ["--check", path.join(packageA, file)], { stdio: "pipe" });
    }

    await testSettings(path.join(packageA, "settings.js"));
    await testBackground(packageA);
    await testRuntime(path.join(packageA, "runtime.js"));
    await testPopup(packageA);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  console.log("guild-market build tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
