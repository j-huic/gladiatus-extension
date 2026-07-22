const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

function load(files, overrides = {}) {
  const context = { console, URL, Promise, ...overrides };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
  }
  return context;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function fakeStorage(seed = {}) {
  const state = { ...seed };
  return {
    state,
    async get(keys) {
      if (keys == null) return { ...state };
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => Object.prototype.hasOwnProperty.call(state, key)).map((key) => [key, state[key]]));
    },
    async set(values) {
      Object.assign(state, values || {});
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
}

function fakeChangeEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(changes, areaName = "local") {
      for (const listener of listeners) listener(changes, areaName);
    },
    get size() { return listeners.size; }
  };
}

async function testSettings() {
  const context = load(["helper-settings.js"]);
  const settings = context.GladiatusFeatureSettings;
  assert.equal(context.GladiatusHelperSettings, settings, "legacy API name aliases the canonical API");
  assert.equal(settings.storageKey, "glad-helper-settings-v1");

  const fresh = plain(settings.freshDefaults());
  assert.equal(fresh.onboarding.completed, false);
  assert.deepEqual(Object.values(fresh.features).map((feature) => feature.enabled), [false, false, false, false]);
  assert.equal(fresh.features.arena.quickFight, true);
  assert.equal(fresh.features.guildMarket.mode, "automatic");
  assert.deepEqual(fresh.features.guildMarket.rules, [
    { id: "mini-pumpkin", itemName: "Mini-Pumpkin", pricePerUnit: 100000, enabled: true }
  ]);

  const legacy = plain(settings.legacyDefaults());
  assert.equal(legacy.onboarding.completed, true);
  assert.deepEqual(Object.values(legacy.features).map((feature) => feature.enabled), [true, true, false, true]);
  assert.equal(legacy.features.auction.applyRankingToPage, false);
  assert.equal(legacy.features.arena.passiveRefresh, false);
  assert.equal(legacy.features.arena.quickFight, true);

  const normalized = plain(settings.normalize({
    version: 99,
    onboarding: { completed: "yes" },
    features: {
      auction: { enabled: true, pageSorter: "yes" },
      guildMarket: {
        enabled: true,
        rules: [
          { id: "a", itemName: "  Mini   Pumpkin ", pricePerUnit: "250", enabled: false },
          { id: "b", itemName: "mini pumpkin", pricePerUnit: 300 },
          { itemName: "Broken", pricePerUnit: -1 }
        ]
      }
    },
    diagnostics: null
  }));
  assert.equal(normalized.version, 1);
  assert.equal(normalized.onboarding.completed, false, "malformed booleans fall back safely");
  assert.equal(normalized.features.auction.enabled, true);
  assert.equal(normalized.features.auction.pageSorter, true);
  assert.equal(normalized.features.arena.quickFight, true, "missing quick-fight settings migrate on");
  assert.equal(normalized.features.guildMarket.mode, "automatic", "legacy suggest mode migrates to automatic filling");
  assert.deepEqual(normalized.features.guildMarket.rules, [
    { id: "a", itemName: "Mini Pumpkin", pricePerUnit: 250, enabled: false }
  ], "invalid and duplicate normalized rules are rejected");


  const freshArea = fakeStorage();
  const initializedFresh = await settings.get({ storageArea: freshArea });
  assert.equal(initializedFresh.onboarding.completed, false);
  assert.ok(freshArea.state[settings.storageKey], "fresh settings are persisted");

  const legacyArea = fakeStorage({ "glad-ah-sorter-state-v1": { field: "score" } });
  const initializedLegacy = await settings.get({ storageArea: legacyArea });
  assert.equal(initializedLegacy.onboarding.completed, true);
  assert.equal(initializedLegacy.features.arena.enabled, true);

  const explicitInstallArea = fakeStorage({ "glad-ah-sorter-state-v1": { field: "score" } });
  const explicitInstall = await settings.initializeForInstall("install", { storageArea: explicitInstallArea });
  assert.equal(explicitInstall.onboarding.completed, false, "install reason wins over residue detection");
  const explicitUpdate = await settings.initializeForInstall("update", { storageArea: fakeStorage() });
  assert.equal(explicitUpdate.onboarding.completed, true);

  const updateArea = fakeStorage({ [settings.storageKey]: fresh });
  const updated = await settings.updateFeature("auction", { enabled: true, fullScan: false }, { storageArea: updateArea });
  assert.equal(updated.features.auction.enabled, true);
  assert.equal(updated.features.auction.fullScan, false);
  assert.equal(updated.features.auction.pageSorter, true, "unmentioned child values are retained");
  assert.equal(settings.isCapabilityEnabled(updated, "auction", "pageSorter"), true);
  assert.equal(settings.isCapabilityEnabled(updated, "auction", "fullScan"), false);
  assert.equal(settings.isCapabilityEnabled(updated, "arena", "manualScan"), false, "parent switch overrides child");
  await assert.rejects(
    () => settings.updateFeature("missing", { enabled: true }, { storageArea: updateArea }),
    /Unknown feature/
  );

  for (let mask = 0; mask < 16; mask += 1) {
    const matrix = settings.freshDefaults();
    settings.featureIds.forEach((id, index) => {
      matrix.features[id].enabled = Boolean(mask & (1 << index));
    });
    settings.featureIds.forEach((id, index) => {
      assert.equal(settings.isCapabilityEnabled(matrix, id), Boolean(mask & (1 << index)));
    });
  }

  const event = fakeChangeEvent();
  let notification = null;
  const unsubscribe = settings.subscribe((next, meta) => { notification = { next, meta }; }, { onChanged: event });
  event.emit({ [settings.storageKey]: { oldValue: fresh, newValue: updated } });
  assert.equal(notification.next.features.auction.enabled, true);
  assert.equal(notification.meta.previous.features.auction.enabled, false);
  unsubscribe();
  assert.equal(event.size, 0);

  const clearArea = fakeStorage({
    "glad-ah-last-scan-v1": { x: 1 },
    "glad-ah-scan-archive-v1": [{ x: 1 }],
    "glad-ah-custom-definitions-v1": [{ id: "keep" }]
  });
  await settings.clearFeatureCache("auction", { storageArea: clearArea });
  assert.equal(clearArea.state["glad-ah-last-scan-v1"], undefined);
  assert.ok(clearArea.state["glad-ah-custom-definitions-v1"], "cache clearing preserves user definitions");
}

async function testSecurity() {
  const context = load(["helper-security.js"]);
  const security = context.GladiatusHelperSecurity;

  const safeUrl = security.sanitizeUrl(
    "https://s1-en.gladiatus.gameforge.com/game/index.php?mod=arena&SH=one&CsRf_ToKeN=two&token=three#private"
  );
  assert.equal(safeUrl, "https://s1-en.gladiatus.gameforge.com/game/index.php?mod=arena");
  assert.equal(security.sanitizeUrl("/game/index.php?mod=player&session=secret#tab"), "/game/index.php?mod=player");

  const nested = {
    sourceUrl: "https://s1-en.gladiatus.gameforge.com/game/?mod=auction&sh=SECRET#private",
    entries: [{ profileUrl: "https://s2-en.gladiatus.gameforge.com/game/?p=1&AUTH=HIDDEN" }],
    csrfToken: "RAW",
    deeper: { access_token: "RAW2", text: "fetch https://s3-en.gladiatus.gameforge.com/game/?session=RAW3 now" }
  };
  const sanitized = plain(security.sanitizeForStorage(nested));
  assert.equal(sanitized.sourceUrl, "https://s1-en.gladiatus.gameforge.com/game/?mod=auction");
  assert.equal(sanitized.entries[0].profileUrl, "https://s2-en.gladiatus.gameforge.com/game/?p=1");
  assert.equal("csrfToken" in sanitized, false);
  assert.equal("access_token" in sanitized.deeper, false);
  assert.ok(!JSON.stringify(sanitized).includes("RAW3"));

  let deep = {
    url: "https://s9-en.gladiatus.gameforge.com/game/?mod=player&CsRf-ToKeN=DEEP&AUTH_TOKEN=HIDDEN#private"
  };
  for (let index = 0; index < 12; index += 1) deep = { child: deep };
  const deepSanitized = plain(security.sanitizeForStorage(deep));
  assert.ok(!JSON.stringify(deepSanitized).includes("DEEP"));
  assert.ok(!JSON.stringify(deepSanitized).includes("HIDDEN"));
  assert.ok(!JSON.stringify(deepSanitized).includes("#private"));

  const logSafe = plain(security.sanitizeForLog({ auth: "SECRET", nested: { sessionId: "OTHER" } }));
  assert.deepEqual(logSafe, { auth: "[redacted]", nested: { sessionId: "[redacted]" } });
  assert.equal(security.sanitizeValue({ child: { secret: true } }, { maximumDepth: 0 }).child, "[max-depth]");

  const storage = fakeStorage({
    "glad-ah-last-scan-v1": nested,
    "unrelated-key": { url: "https://x/?sh=DO_NOT_TOUCH" }
  });
  const first = await security.sanitizeKnownStorage({ storageArea: storage });
  assert.deepEqual(plain(first.changedKeys), ["glad-ah-last-scan-v1"]);
  assert.ok(!JSON.stringify(storage.state["glad-ah-last-scan-v1"]).includes("SECRET"));
  assert.ok(JSON.stringify(storage.state["unrelated-key"]).includes("DO_NOT_TOUCH"));
  const second = await security.runStorageSanitizationMigration({ storageArea: storage });
  assert.deepEqual(plain(second.changedKeys), [], "storage migration is idempotent");

  assert.equal(
    security.isAllowedGameforgeUrl("https://s42-en.gladiatus.gameforge.com/game/index.php?mod=arena"),
    true
  );
  assert.equal(security.isAllowedGameforgeUrl("http://s42-en.gladiatus.gameforge.com/game/"), false);
  assert.equal(security.isAllowedGameforgeUrl("https://gladiatus.gameforge.com/game/"), false);
  assert.equal(security.isAllowedGameforgeUrl("https://gladiatus.gameforge.com.evil.test/game/"), false);
  assert.throws(() => security.parseAllowedGameforgeUrl("https://example.com/"), /Gladiatus Gameforge/);
}

Promise.resolve()
  .then(testSettings)
  .then(testSecurity)
  .then(() => console.log("helper settings/security tests passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
