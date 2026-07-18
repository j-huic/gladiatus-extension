const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = __dirname;
const SETTINGS_KEY = "glad-helper-settings-v1";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function makeStorageArea(state, changeListeners) {
  return {
    async get(keys) {
      if (keys == null) return clone(state);
      if (typeof keys === "object" && !Array.isArray(keys)) {
        return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [
          key,
          Object.prototype.hasOwnProperty.call(state, key) ? clone(state[key]) : fallback
        ]));
      }
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list
        .filter((key) => Object.prototype.hasOwnProperty.call(state, key))
        .map((key) => [key, clone(state[key])]));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
        state[key] = clone(value);
      }
      for (const listener of changeListeners) listener(changes, "local");
    },
    async remove(keys) {
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
        changes[key] = { oldValue: clone(state[key]), newValue: undefined };
        delete state[key];
      }
      for (const listener of changeListeners) listener(changes, "local");
    },
    async clear() {
      const changes = {};
      for (const [key, value] of Object.entries(state)) {
        changes[key] = { oldValue: clone(value), newValue: undefined };
        delete state[key];
      }
      for (const listener of changeListeners) listener(changes, "local");
    }
  };
}

function makeBackground(seed = {}) {
  const localState = clone(seed);
  const sessionState = {};
  const storageChangeListeners = new Set();
  const messageListeners = [];
  const installedListeners = [];
  const executeCalls = [];
  let fetchCount = 0;

  const local = makeStorageArea(localState, storageChangeListeners);
  const session = makeStorageArea(sessionState, new Set());
  const context = {
    console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    Promise,
    structuredClone,
    setTimeout,
    clearTimeout,
    async fetch() {
      fetchCount += 1;
      throw new Error("Unexpected network request in background unit test.");
    },
    chrome: {
      runtime: {
        id: "test-extension",
        lastError: null,
        onInstalled: {
          addListener(listener) { installedListeners.push(listener); }
        },
        onMessage: {
          addListener(listener) { messageListeners.push(listener); }
        }
      },
      storage: {
        local,
        session,
        onChanged: {
          addListener(listener) { storageChangeListeners.add(listener); },
          removeListener(listener) { storageChangeListeners.delete(listener); }
        }
      },
      scripting: {
        async executeScript(options) {
          executeCalls.push({
            ...clone({ ...options, func: undefined }),
            hasFunction: typeof options.func === "function"
          });
          if (typeof options.func === "function") return [{ result: { ok: true, result: true } }];
          return [];
        }
      }
    }
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  context.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(rootDir, "background.js"), "utf8"), context, {
    filename: "background.js"
  });

  async function dispatch(message, sender = gameSender()) {
    assert.equal(messageListeners.length, 1, "background installs one message listener");
    return new Promise((resolve, reject) => {
      const asyncResponse = messageListeners[0](message, sender, resolve);
      if (asyncResponse !== true) reject(new Error("Expected an asynchronous background response."));
    });
  }

  return {
    context,
    localState,
    executeCalls,
    installedListeners,
    dispatch,
    get fetchCount() { return fetchCount; }
  };
}

function gameSender() {
  return {
    tab: {
      id: 17,
      url: "https://s17-en.gladiatus.gameforge.com/game/index.php?mod=auction"
    }
  };
}

function guildSender() {
  return {
    tab: {
      id: 19,
      url: "https://s17-en.gladiatus.gameforge.com/game/index.php?mod=guildMarket"
    }
  };
}

function auctionRequest(sourceUrl = gameSender().tab.url) {
  return {
    type: "GLAD_AUCTION_FORCE_SCAN",
    request: { sourceUrl, formFields: [], sharedFilters: {}, sources: [] }
  };
}

function arenaRequest(url = "https://s17-en.gladiatus.gameforge.com/game/index.php?mod=arena") {
  return {
    type: "GLAD_ARENA_FORCE_SCAN",
    url,
    entries: [],
    formula: null
  };
}

async function settle(turns = 8) {
  for (let index = 0; index < turns; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, message) {
  for (let index = 0; index < 40; index += 1) {
    if (predicate()) return;
    await settle(1);
  }
  assert.fail(message);
}

async function run() {
  {
    const app = makeBackground();
    await settle();

    const auctionDisabled = await app.dispatch(auctionRequest());
    assert.deepEqual(clone(auctionDisabled), {
      ok: false,
      code: "FEATURE_DISABLED",
      error: "Auction fullScan capability is disabled."
    });
    assert.equal(app.fetchCount, 0);

    const arenaDisabled = await app.dispatch(arenaRequest());
    assert.equal(arenaDisabled.ok, false);
    assert.equal(arenaDisabled.code, "FEATURE_DISABLED");
    assert.equal(app.fetchCount, 0);

    const repairDisabled = await app.dispatch({ type: "GLAD_FEATURE_REPAIR", feature: "guildMarket" });
    assert.equal(repairDisabled.ok, false);
    assert.equal(repairDisabled.code, "FEATURE_DISABLED");
    assert.equal(app.executeCalls.length, 0);

    const guildStartDisabled = await app.dispatch({
      type: "GLAD_GUILD_MARKET_CONTROL",
      action: "start",
      settings: { enabled: true }
    }, guildSender());
    assert.equal(guildStartDisabled.code, "FEATURE_DISABLED");

    const guildStopDisabled = await app.dispatch({
      type: "GLAD_GUILD_MARKET_CONTROL",
      action: "stop"
    }, guildSender());
    assert.equal(guildStopDisabled.ok, true, "disabled guild feature can still tear down its MAIN-world wrapper");
    assert.equal(app.executeCalls.at(-1).world, "MAIN");

    const invalidSender = await app.dispatch(auctionRequest(), { tab: { id: 17, url: "https://example.com/" } });
    assert.equal(invalidSender.code, "INVALID_SENDER");
    assert.equal(app.fetchCount, 0);
  }

  {
    const app = makeBackground();
    await settle();
    await app.context.GladiatusFeatureSettings.updateFeature("auction", { enabled: true, fullScan: true });
    await settle();

    const invalidUrl = await app.dispatch(auctionRequest("https://example.com/game/index.php?mod=auction"));
    assert.equal(invalidUrl.ok, false);
    assert.equal(invalidUrl.code, "INVALID_URL");
    assert.equal(app.fetchCount, 0);

    let resolveScan;
    let scanStarted = false;
    app.context.GladiatusAuctionBackgroundScanner = {
      forceScan() {
        scanStarted = true;
        return new Promise((resolve) => { resolveScan = resolve; });
      }
    };
    const pending = app.dispatch(auctionRequest());
    await waitFor(() => scanStarted, "auction scan did not start");
    await app.context.GladiatusFeatureSettings.updateFeature("auction", { enabled: false });
    resolveScan({ scannedAt: new Date().toISOString(), items: [] });
    const late = await pending;
    assert.equal(late.ok, false);
    assert.equal(late.code, "FEATURE_DISABLED", "late results are discarded after disable");
  }

  {
    const app = makeBackground();
    await settle();
    await app.context.GladiatusFeatureSettings.updateFeature("arena", { enabled: true, manualScan: true });
    await settle();

    const invalidUrl = await app.dispatch(arenaRequest("https://example.com/game/index.php?mod=arena"));
    assert.equal(invalidUrl.code, "INVALID_URL");
    assert.equal(app.fetchCount, 0);

    let resolveScan;
    let scanStarted = false;
    app.context.GladiatusArenaBackgroundScanner = {
      forceScan() {
        scanStarted = true;
        return new Promise((resolve) => { resolveScan = resolve; });
      },
      cancelScheduledPassiveChecks() {}
    };
    const pending = app.dispatch(arenaRequest());
    await waitFor(() => scanStarted, "arena scan did not start");
    await app.context.GladiatusFeatureSettings.updateFeature("arena", { enabled: false });
    resolveScan({ scannedAt: new Date().toISOString(), opponents: [] });
    const late = await pending;
    assert.equal(late.code, "FEATURE_DISABLED", "late arena results are discarded after disable");
  }

  {
    const app = makeBackground();
    await settle();
    await app.context.GladiatusFeatureSettings.updateFeature("guildMarket", { enabled: true });
    await settle();
    const repaired = await app.dispatch({ type: "GLAD_FEATURE_REPAIR", feature: "guildMarket" });
    assert.equal(repaired.ok, true);
    assert.deepEqual(app.executeCalls[0].files, [
      "helper-security.js",
      "helper-settings.js",
      "guild-market-content.js",
      "feature-runtime.js"
    ]);
  }

  {
    const updated = makeBackground();
    assert.equal(updated.installedListeners.length, 1);
    updated.installedListeners[0]({ reason: "update" });
    await waitFor(
      () => updated.localState[SETTINGS_KEY]?.onboarding?.completed === true,
      "legacy update migration did not complete"
    );
    assert.deepEqual(
      Object.values(updated.localState[SETTINGS_KEY].features).map((feature) => feature.enabled),
      [true, true, true],
      "pre-settings installations retain discoverability"
    );

    const installed = makeBackground();
    installed.installedListeners[0]({ reason: "install" });
    await waitFor(
      () => installed.localState[SETTINGS_KEY]?.onboarding?.completed === false,
      "fresh installation settings did not initialize"
    );
    assert.deepEqual(
      Object.values(installed.localState[SETTINGS_KEY].features).map((feature) => feature.enabled),
      [false, false, false]
    );
  }

  console.log("background feature-gate tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
