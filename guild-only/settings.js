// Settings for the standalone guild-market release target.
//
// This intentionally exposes one switch and one Mini-Pumpkin unit price. It
// does not import the multi-feature extension's settings or feature runtime.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusGuildMarketSettings) return;

  const STORAGE_KEY = "glad-guild-market-settings-v1";
  const LEGACY_SETTINGS_KEY = "glad-helper-settings-v1";
  const VERSION = 1;
  const ITEM_NAME = "Mini-Pumpkin";
  const DEFAULT_UNIT_PRICE = 100000;

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

  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function positiveSafeInteger(value) {
    const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function defaults() {
    return {
      version: VERSION,
      enabled: false,
      pricePerUnit: DEFAULT_UNIT_PRICE
    };
  }

  function normalize(value, fallback = defaults()) {
    const raw = isObject(value) ? value : {};
    const safeFallback = isObject(fallback) ? fallback : defaults();
    return {
      version: VERSION,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : safeFallback.enabled === true,
      pricePerUnit: positiveSafeInteger(raw.pricePerUnit)
        || positiveSafeInteger(safeFallback.pricePerUnit)
        || DEFAULT_UNIT_PRICE
    };
  }

  function normalizedName(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  }

  function migrateLegacy(value) {
    const guild = isObject(value?.features?.guildMarket) ? value.features.guildMarket : null;
    if (!guild) return null;
    const miniPumpkinRule = Array.isArray(guild.rules)
      ? guild.rules.find((rule) => normalizedName(rule?.itemName) === normalizedName(ITEM_NAME))
      : null;
    const pricePerUnit = positiveSafeInteger(miniPumpkinRule?.pricePerUnit);
    return normalize({
      enabled: guild.enabled === true && miniPumpkinRule?.enabled !== false && pricePerUnit !== null,
      pricePerUnit: pricePerUnit || DEFAULT_UNIT_PRICE
    });
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

  async function write(settings, options = {}) {
    const normalized = normalize(settings, options.fallback);
    await storageArea(options).set({ [STORAGE_KEY]: normalized });
    return clone(normalized);
  }

  async function get(options = {}) {
    const area = storageArea(options);
    const stored = await area.get(STORAGE_KEY);
    if (hasOwn(stored, STORAGE_KEY) && stored[STORAGE_KEY] !== undefined) {
      const normalized = normalize(stored[STORAGE_KEY]);
      if (JSON.stringify(normalized) !== JSON.stringify(stored[STORAGE_KEY])) {
        await area.set({ [STORAGE_KEY]: normalized });
      }
      return clone(normalized);
    }

    const legacy = await area.get(LEGACY_SETTINGS_KEY);
    const initial = migrateLegacy(legacy[LEGACY_SETTINGS_KEY]) || defaults();
    await area.set({ [STORAGE_KEY]: initial });
    return clone(initial);
  }

  async function update(patchOrMutator, options = {}) {
    const current = await get(options);
    let next;
    if (typeof patchOrMutator === "function") {
      const draft = clone(current);
      next = patchOrMutator(draft);
      if (next === undefined) next = draft;
    } else {
      next = { ...current, ...(isObject(patchOrMutator) ? patchOrMutator : {}) };
    }
    return write(normalize(next, current), { ...options, fallback: current });
  }

  function subscribe(listener, options = {}) {
    if (typeof listener !== "function") throw new TypeError("Settings listener must be a function");
    const changes = options.onChanged || root.chrome?.storage?.onChanged;
    if (!changes?.addListener) return () => {};
    const onChanged = (records, areaName) => {
      if (areaName && areaName !== "local") return;
      if (!hasOwn(records, STORAGE_KEY)) return;
      const next = records[STORAGE_KEY]?.newValue;
      listener(next === undefined ? defaults() : normalize(next));
    };
    changes.addListener(onChanged);
    return () => changes.removeListener?.(onChanged);
  }

  function toFeatureSettings(value) {
    const settings = normalize(value);
    return {
      enabled: settings.enabled,
      mode: "suggest",
      rules: [{
        id: "mini-pumpkin",
        itemName: ITEM_NAME,
        pricePerUnit: settings.pricePerUnit,
        enabled: true
      }]
    };
  }

  root.GladiatusGuildMarketSettings = Object.freeze({
    version: VERSION,
    storageKey: STORAGE_KEY,
    legacySettingsKey: LEGACY_SETTINGS_KEY,
    itemName: ITEM_NAME,
    defaultUnitPrice: DEFAULT_UNIT_PRICE,
    defaults,
    normalize,
    migrateLegacy,
    get,
    update,
    subscribe,
    toFeatureSettings
  });
})();
