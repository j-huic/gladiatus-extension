// Feature-neutral lifecycle coordinator for isolated content scripts.
// Feature modules register inert controllers; this is the only always-on
// storage listener that starts, updates, and stops them.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "feature-runtime-v1";
  const SETTINGS = root.GladiatusFeatureSettings;

  if (!SETTINGS || typeof chrome === "undefined" || !chrome.storage?.local) return;
  if (root.GladiatusFeatureRuntime?.version === VERSION) {
    root.GladiatusFeatureRuntime.refresh();
    return;
  }

  let currentSettings = null;
  let applyQueue = Promise.resolve();
  let unsubscribe = null;
  const applied = new Map();

  function controllerEntries() {
    const registered = root.GladiatusFeatureControllers || {};
    return [
      ["auction", "auction", root.GladiatusAuctionFeature || registered.auction],
      ["arena", "arena", root.GladiatusArenaFeature || registered.arena],
      ["arena-passive", "arena", root.GladiatusArenaPassiveFeature || registered.arenaPassive],
      ["arena-status", "arena", root.GladiatusArenaStatusFeature || registered.arenaStatus],
      ["guild-market", "guildMarket", root.GladiatusGuildMarketController || registered.guildMarket]
    ].filter((entry) => entry[2]);
  }

  function fingerprint(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  async function applyController(key, featureId, controller, settings) {
    const featureSettings = settings.features[featureId];
    const nextFingerprint = fingerprint(featureSettings);
    const previous = applied.get(key);
    if (previous?.controller === controller && previous.fingerprint === nextFingerprint) return;

    try {
      if (!featureSettings?.enabled) {
        await controller.stop?.();
      } else if (previous?.controller === controller) {
        await controller.update?.(featureSettings);
      } else {
        if (previous?.controller && previous.controller !== controller) await previous.controller.stop?.();
        await controller.start?.(featureSettings);
      }
      applied.set(key, { controller, fingerprint: nextFingerprint });
    } catch (error) {
      console.warn(`[Gladiatus Helper] Could not apply ${key} settings.`, error);
    }
  }

  async function applySettings(rawSettings) {
    const settings = SETTINGS.normalize(rawSettings);
    currentSettings = settings;
    const entries = controllerEntries();
    for (const [key, featureId, controller] of entries) {
      await applyController(key, featureId, controller, settings);
    }
    return settings;
  }

  function enqueue(settings) {
    applyQueue = applyQueue.then(() => applySettings(settings));
    return applyQueue;
  }

  async function refresh() {
    const settings = await SETTINGS.get();
    return enqueue(settings);
  }

  async function stopAll() {
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    for (const { controller } of applied.values()) {
      try {
        await controller.stop?.();
      } catch {
        // One broken controller must not keep another feature alive.
      }
    }
    applied.clear();
  }

  root.GladiatusFeatureRuntime = {
    version: VERSION,
    refresh,
    stopAll,
    getSettings() {
      return currentSettings && SETTINGS.normalize(currentSettings);
    },
    getStatus() {
      return Object.fromEntries(controllerEntries().map(([key, featureId, controller]) => [key, {
        featureId,
        status: controller.getStatus?.() || null
      }]));
    }
  };

  unsubscribe = SETTINGS.subscribe((settings) => enqueue(settings));
  refresh().catch((error) => {
    console.warn("[Gladiatus Helper] Could not initialize feature settings.", error);
  });
})();
