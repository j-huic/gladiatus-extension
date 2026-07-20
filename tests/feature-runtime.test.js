const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

function fakeStorage(seed = {}) {
  const state = { ...seed };
  const listeners = new Set();
  return {
    state,
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values || {})) {
          changes[key] = { oldValue: state[key], newValue: value };
          state[key] = value;
        }
        for (const listener of listeners) listener(changes, "local");
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
      }
    },
    onChanged: {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); }
    }
  };
}

function controller() {
  return {
    active: false,
    calls: [],
    async start(settings) {
      this.active = true;
      this.calls.push(["start", JSON.parse(JSON.stringify(settings))]);
    },
    async update(settings) {
      this.active = true;
      this.calls.push(["update", JSON.parse(JSON.stringify(settings))]);
    },
    async stop() {
      this.active = false;
      this.calls.push(["stop"]);
    },
    getStatus() { return { active: this.active }; }
  };
}

async function settle(runtime) {
  await Promise.resolve();
  await Promise.resolve();
  await runtime.refresh();
  await Promise.resolve();
}

async function run() {
  const storage = fakeStorage();
  const auction = controller();
  const arena = controller();
  const passive = controller();
  const status = controller();
  const guild = controller();
  const context = {
    console,
    Promise,
    JSON,
    structuredClone,
    chrome: { storage },
    GladiatusAuctionFeature: auction,
    GladiatusArenaFeature: arena,
    GladiatusArenaPassiveFeature: passive,
    GladiatusArenaStatusFeature: status,
    GladiatusGuildMarketController: guild
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["helper-settings.js", "feature-runtime.js"]) {
    vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
  }

  await settle(context.GladiatusFeatureRuntime);
  assert.equal(auction.active, false);
  assert.equal(arena.active, false);
  assert.equal(guild.active, false);

  const settingsApi = context.GladiatusFeatureSettings;
  for (let mask = 0; mask < 8; mask += 1) {
    const next = settingsApi.freshDefaults();
    settingsApi.featureIds.forEach((id, index) => {
      next.features[id].enabled = Boolean(mask & (1 << index));
    });
    await settingsApi.set(next);
    await settle(context.GladiatusFeatureRuntime);
    assert.equal(auction.active, next.features.auction.enabled, `auction state for mask ${mask}`);
    assert.equal(arena.active, next.features.arena.enabled, `arena state for mask ${mask}`);
    assert.equal(guild.active, next.features.guildMarket.enabled, `guild state for mask ${mask}`);
  }

  const before = auction.calls.length;
  await context.GladiatusFeatureRuntime.refresh();
  assert.equal(auction.calls.length, before, "unchanged settings do not restart a controller");

  await context.GladiatusFeatureRuntime.stopAll();
  assert.equal(auction.active, false);
  assert.equal(arena.active, false);
  assert.equal(passive.active, false);
  assert.equal(status.active, false);
  assert.equal(guild.active, false);
  console.log("feature runtime tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
