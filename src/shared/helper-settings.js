// Versioned, feature-neutral settings for the extension. This module is safe
// to load in the service worker, isolated content scripts, and the popup.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusFeatureSettings) {
    root.GladiatusHelperSettings = root.GladiatusFeatureSettings;
    return;
  }

  const STORAGE_KEY = "glad-helper-settings-v1";
  const VERSION = 1;
  const ONBOARDING_VERSION = 1;
  const FEATURE_IDS = ["auction", "arena", "smelting", "guildMarket"];

  const LEGACY_STORAGE_KEYS = [
    "glad-ah-custom-definitions-v1",
    "glad-ah-filter-values-v1",
    "glad-ah-popup-state-v1",
    "glad-ah-scan-archive-v1",
    "glad-ah-last-scan-v1",
    "glad-ah-sorter-state-v1",
    "glad-arena-formulas-v1",
    "glad-arena-last-scan-v1",
    "glad-arena-passive-scans-v1",
    "glad-arena-scan-status-v1",
    "glad-arena-self-profile-v1"
  ];

  const FEATURE_CACHE_KEYS = Object.freeze({
    auction: Object.freeze([
      "glad-ah-scan-archive-v1",
      "glad-ah-last-scan-v1"
    ]),
    arena: Object.freeze([
      "glad-arena-last-scan-v1",
      "glad-arena-passive-scans-v1",
      "glad-arena-scan-status-v1",
      "glad-arena-self-profile-v1"
    ]),
    smelting: Object.freeze([]),
    guildMarket: Object.freeze([])
  });

  const FEATURE_DATA_KEYS = Object.freeze({
    auction: Object.freeze([
      "glad-ah-custom-definitions-v1",
      "glad-ah-filter-values-v1",
      "glad-ah-scan-archive-v1",
      "glad-ah-last-scan-v1",
      "glad-ah-sorter-state-v1"
    ]),
    arena: Object.freeze([
      "glad-arena-formulas-v1",
      "glad-arena-last-scan-v1",
      "glad-arena-passive-scans-v1",
      "glad-arena-scan-status-v1",
      "glad-arena-self-profile-v1",
      "glad-arena-ui-state-v1"
    ]),
    smelting: Object.freeze([]),
    guildMarket: Object.freeze([])
  });

  const DEFAULT_GUILD_RULE = Object.freeze({
    id: "mini-pumpkin",
    itemName: "Mini-Pumpkin",
    pricePerUnit: 100000,
    enabled: true
  });

  function clone(value) {
    if (value == null || typeof value !== "object") return value;
    if (typeof structuredClone === "function") {
      try {
        return structuredClone(value);
      } catch (_error) {
        // Fall back for values from another JavaScript realm.
      }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function freshDefaults() {
    return {
      version: VERSION,
      onboarding: { completed: false, version: ONBOARDING_VERSION },
      features: {
        auction: {
          enabled: false,
          pageSorter: true,
          fullScan: true,
          scoreBadges: true,
          applyRankingToPage: false
        },
        arena: {
          enabled: false,
          annotations: true,
          manualScan: true,
          simulations: true,
          passiveRefresh: false,
          statusWidget: true,
          quickFight: true
        },
        smelting: {
          enabled: false
        },
        guildMarket: {
          enabled: false,
          mode: "automatic",
          rules: [clone(DEFAULT_GUILD_RULE)]
        }
      },
      diagnostics: { enabled: false }
    };
  }

  function legacyDefaults() {
    const settings = freshDefaults();
    settings.onboarding.completed = true;
    settings.features.auction.enabled = true;
    settings.features.arena.enabled = true;
    settings.features.guildMarket.enabled = true;
    return settings;
  }

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : Boolean(fallback);
  }

  function normalizeItemName(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
  }

  function normalizeRuleId(value, itemName, index) {
    const explicit = String(value || "").trim();
    if (explicit) return explicit.slice(0, 100);
    const slug = itemName
      .toLocaleLowerCase("en-US")
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug || `rule-${index + 1}`;
  }

  function normalizeRules(value, fallback) {
    if (!Array.isArray(value)) return clone(Array.isArray(fallback) ? fallback : []);

    const rules = [];
    const names = new Set();
    const ids = new Set();
    for (let index = 0; index < value.length; index += 1) {
      const raw = value[index];
      if (!isObject(raw)) continue;
      const itemName = normalizeItemName(raw.itemName);
      const nameKey = itemName.toLocaleLowerCase("en-US");
      const pricePerUnit = Number(raw.pricePerUnit);
      if (!itemName || names.has(nameKey)) continue;
      if (!Number.isSafeInteger(pricePerUnit) || pricePerUnit <= 0) continue;

      let id = normalizeRuleId(raw.id, itemName, index);
      if (ids.has(id)) {
        let suffix = 2;
        while (ids.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      names.add(nameKey);
      ids.add(id);
      rules.push({
        id,
        itemName,
        pricePerUnit,
        enabled: normalizeBoolean(raw.enabled, true)
      });
    }
    return rules;
  }

  function normalize(value, fallback = freshDefaults()) {
    const safeFallback = isObject(fallback) ? fallback : freshDefaults();
    const raw = isObject(value) ? value : {};
    const rawFeatures = isObject(raw.features) ? raw.features : {};
    const fallbackFeatures = isObject(safeFallback.features)
      ? safeFallback.features
      : freshDefaults().features;
    const rawAuction = isObject(rawFeatures.auction) ? rawFeatures.auction : {};
    const rawArena = isObject(rawFeatures.arena) ? rawFeatures.arena : {};
    const rawSmelting = isObject(rawFeatures.smelting) ? rawFeatures.smelting : {};
    const rawGuild = isObject(rawFeatures.guildMarket) ? rawFeatures.guildMarket : {};
    const fallbackAuction = fallbackFeatures.auction || freshDefaults().features.auction;
    const fallbackArena = fallbackFeatures.arena || freshDefaults().features.arena;
    const fallbackSmelting = fallbackFeatures.smelting || freshDefaults().features.smelting;
    const fallbackGuild = fallbackFeatures.guildMarket || freshDefaults().features.guildMarket;
    const rawOnboarding = isObject(raw.onboarding) ? raw.onboarding : {};
    const fallbackOnboarding = safeFallback.onboarding || freshDefaults().onboarding;
    const rawDiagnostics = isObject(raw.diagnostics) ? raw.diagnostics : {};
    const fallbackDiagnostics = safeFallback.diagnostics || freshDefaults().diagnostics;

    return {
      version: VERSION,
      onboarding: {
        completed: normalizeBoolean(rawOnboarding.completed, fallbackOnboarding.completed),
        version: ONBOARDING_VERSION
      },
      features: {
        auction: {
          enabled: normalizeBoolean(rawAuction.enabled, fallbackAuction.enabled),
          pageSorter: normalizeBoolean(rawAuction.pageSorter, fallbackAuction.pageSorter),
          fullScan: normalizeBoolean(rawAuction.fullScan, fallbackAuction.fullScan),
          scoreBadges: normalizeBoolean(rawAuction.scoreBadges, fallbackAuction.scoreBadges),
          applyRankingToPage: normalizeBoolean(
            rawAuction.applyRankingToPage,
            fallbackAuction.applyRankingToPage
          )
        },
        arena: {
          enabled: normalizeBoolean(rawArena.enabled, fallbackArena.enabled),
          annotations: normalizeBoolean(rawArena.annotations, fallbackArena.annotations),
          manualScan: normalizeBoolean(rawArena.manualScan, fallbackArena.manualScan),
          simulations: normalizeBoolean(rawArena.simulations, fallbackArena.simulations),
          passiveRefresh: normalizeBoolean(rawArena.passiveRefresh, fallbackArena.passiveRefresh),
          statusWidget: normalizeBoolean(rawArena.statusWidget, fallbackArena.statusWidget),
          quickFight: normalizeBoolean(rawArena.quickFight, fallbackArena.quickFight)
        },
        smelting: {
          enabled: normalizeBoolean(rawSmelting.enabled, fallbackSmelting.enabled)
        },
        guildMarket: {
          enabled: normalizeBoolean(rawGuild.enabled, fallbackGuild.enabled),
          mode: "automatic",
          rules: normalizeRules(rawGuild.rules, fallbackGuild.rules)
        }
      },
      diagnostics: {
        enabled: normalizeBoolean(rawDiagnostics.enabled, fallbackDiagnostics.enabled)
      }
    };
  }

  function storageArea(options = {}) {
    const area = options.storageArea || root.chrome?.storage?.local;
    if (!area || typeof area.get !== "function" || typeof area.set !== "function") {
      throw new Error("chrome.storage.local is unavailable");
    }
    return area;
  }

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  async function hasLegacyState(options = {}) {
    const area = storageArea(options);
    const stored = await area.get(LEGACY_STORAGE_KEYS);
    return LEGACY_STORAGE_KEYS.some((key) => hasOwn(stored, key) && stored[key] !== undefined);
  }

  async function write(settings, options = {}) {
    const area = storageArea(options);
    await area.set({ [STORAGE_KEY]: settings });
    return clone(settings);
  }

  async function get(options = {}) {
    const area = storageArea(options);
    const stored = await area.get(STORAGE_KEY);
    if (hasOwn(stored, STORAGE_KEY) && stored[STORAGE_KEY] !== undefined) {
      const settings = normalize(stored[STORAGE_KEY]);
      if (JSON.stringify(settings) !== JSON.stringify(stored[STORAGE_KEY])) {
        await area.set({ [STORAGE_KEY]: settings });
      }
      return clone(settings);
    }

    const existingInstall = options.existingInstall === true
      || options.installationReason === "update"
      || (options.detectLegacy !== false && await hasLegacyState({ ...options, storageArea: area }));
    const settings = existingInstall ? legacyDefaults() : freshDefaults();
    await area.set({ [STORAGE_KEY]: settings });
    return clone(settings);
  }

  async function set(value, options = {}) {
    const fallback = options.fallback || freshDefaults();
    return write(normalize(value, fallback), options);
  }

  function mergePatch(target, patch) {
    if (!isObject(patch)) return clone(target);
    const out = isObject(target) ? clone(target) : {};
    for (const [key, value] of Object.entries(patch)) {
      if (isObject(value) && isObject(out[key])) out[key] = mergePatch(out[key], value);
      else out[key] = clone(value);
    }
    return out;
  }

  async function update(mutatorOrPatch, options = {}) {
    const current = await get(options);
    let next;
    if (typeof mutatorOrPatch === "function") {
      const draft = clone(current);
      next = mutatorOrPatch(draft);
      if (next === undefined) next = draft;
    } else {
      next = mergePatch(current, mutatorOrPatch);
    }
    return write(normalize(next, current), options);
  }

  function requireFeatureId(featureId) {
    const id = String(featureId || "");
    if (!FEATURE_IDS.includes(id)) throw new TypeError(`Unknown feature: ${id || "(empty)"}`);
    return id;
  }

  async function updateFeature(featureId, patch, options = {}) {
    const id = requireFeatureId(featureId);
    if (!isObject(patch)) throw new TypeError("Feature update must be an object");
    return update((settings) => {
      settings.features[id] = mergePatch(settings.features[id], patch);
      return settings;
    }, options);
  }

  async function updateDiagnostics(patch, options = {}) {
    if (!isObject(patch)) throw new TypeError("Diagnostics update must be an object");
    return update((settings) => {
      settings.diagnostics = mergePatch(settings.diagnostics, patch);
      return settings;
    }, options);
  }

  async function completeOnboarding(options = {}) {
    return update({ onboarding: { completed: true, version: ONBOARDING_VERSION } }, options);
  }

  async function reset(options = {}) {
    return write(freshDefaults(), options);
  }

  async function initializeForInstall(reason, options = {}) {
    const area = storageArea(options);
    const stored = await area.get(STORAGE_KEY);
    if (hasOwn(stored, STORAGE_KEY) && stored[STORAGE_KEY] !== undefined) {
      return write(normalize(stored[STORAGE_KEY]), { ...options, storageArea: area });
    }
    const settings = reason === "update" ? legacyDefaults() : freshDefaults();
    return write(settings, { ...options, storageArea: area });
  }

  function isCapabilityEnabled(settings, featureId, capability) {
    const id = String(featureId || "");
    if (!FEATURE_IDS.includes(id)) return false;
    const feature = settings?.features?.[id];
    if (!feature || feature.enabled !== true) return false;
    if (!capability || capability === "enabled") return true;
    return feature[capability] === true;
  }

  function subscribe(listener, options = {}) {
    if (typeof listener !== "function") throw new TypeError("Settings listener must be a function");
    const event = options.onChanged || root.chrome?.storage?.onChanged;
    if (!event || typeof event.addListener !== "function") return () => {};

    const handleChange = (changes, areaName) => {
      if (areaName && areaName !== (options.areaName || "local")) return;
      const change = changes?.[STORAGE_KEY];
      if (!change) return;
      const next = normalize(change.newValue);
      const previous = change.oldValue === undefined ? null : normalize(change.oldValue);
      listener(clone(next), { previous: previous && clone(previous), areaName: areaName || "local" });
    };
    event.addListener(handleChange);

    if (options.emitCurrent === true) {
      Promise.resolve()
        .then(() => get(options))
        .then((settings) => listener(settings, { previous: null, areaName: options.areaName || "local" }))
        .catch(() => {});
    }
    return () => {
      if (typeof event.removeListener === "function") event.removeListener(handleChange);
    };
  }

  async function removeKeys(keys, options = {}) {
    const area = storageArea(options);
    if (typeof area.remove !== "function") throw new Error("chrome.storage.local.remove is unavailable");
    await area.remove(Array.from(new Set(keys || [])));
  }

  async function clearFeatureCache(featureId, options = {}) {
    const id = requireFeatureId(featureId);
    await removeKeys(FEATURE_CACHE_KEYS[id], options);
  }

  async function clearFeatureData(featureId, options = {}) {
    const id = requireFeatureId(featureId);
    await removeKeys(FEATURE_DATA_KEYS[id], options);
  }

  const api = Object.freeze({
    storageKey: STORAGE_KEY,
    version: VERSION,
    onboardingVersion: ONBOARDING_VERSION,
    featureIds: Object.freeze([...FEATURE_IDS]),
    legacyStorageKeys: Object.freeze([...LEGACY_STORAGE_KEYS]),
    featureCacheKeys: FEATURE_CACHE_KEYS,
    featureDataKeys: FEATURE_DATA_KEYS,
    freshDefaults,
    legacyDefaults,
    normalize,
    get,
    set,
    update,
    updateFeature,
    updateDiagnostics,
    completeOnboarding,
    reset,
    subscribe,
    isCapabilityEnabled,
    hasLegacyState,
    initializeForInstall,
    clearFeatureCache,
    clearFeatureData,
    normalizeItemName,
    normalizeRules
  });

  root.GladiatusFeatureSettings = api;
  root.GladiatusHelperSettings = api;
})();
