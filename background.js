importScripts(
  "helper-security.js",
  "helper-settings.js"
);

// Capture this before log setup or any other module can initialize the v1
// settings record. It is used only for the one-time pre-settings migration.
const settingsAtWorkerStart = chrome.storage.local.get("glad-helper-settings-v1");

importScripts(
  "log-core.js",
  "log-buffer.js",
  "log-setup.js",
  "auction-schema.js",
  "tooltip-parser.js",
  "auction-core.js",
  "score-model.js",
  "arena-core.js",
  "arena-sim.js",
  "arena-background-scan.js",
  "auction-background-scan.js"
);

const SETTINGS = self.GladiatusFeatureSettings;
const SECURITY = self.GladiatusHelperSecurity;
const LOG_PREFIX = "[Gladiatus Background]";

const FEATURE_CONTENT_FILES = Object.freeze({
  auction: [
    "helper-security.js",
    "helper-settings.js",
    "auction-schema.js",
    "tooltip-parser.js",
    "score-model.js",
    "auction-model.js",
    "auction-core.js",
    "auction-content.js",
    "feature-runtime.js"
  ],
  arena: [
    "helper-security.js",
    "helper-settings.js",
    "score-model.js",
    "arena-core.js",
    "arena-sim.js",
    "arena-scan.js",
    "arena-passive-content.js",
    "arena-status-content.js",
    "arena-content.js",
    "feature-runtime.js"
  ],
  guildMarket: [
    "helper-security.js",
    "helper-settings.js",
    "guild-market-content.js",
    "feature-runtime.js"
  ]
});

let currentSettings = null;
const settingsReady = SETTINGS.get()
  .then((settings) => {
    currentSettings = settings;
    configureLogging(settings);
    return settings;
  });

SETTINGS.subscribe((settings) => {
  const passiveWasEnabled = SETTINGS.isCapabilityEnabled(currentSettings, "arena", "passiveRefresh");
  currentSettings = settings;
  configureLogging(settings);
  if (passiveWasEnabled && !SETTINGS.isCapabilityEnabled(settings, "arena", "passiveRefresh")) {
    self.GladiatusArenaBackgroundScanner?.cancelScheduledPassiveChecks?.();
  }
});

self.GladiatusBackgroundFeatureGate = featureEnabled;

SECURITY.runStorageSanitizationMigration().catch((error) => {
  console.warn(LOG_PREFIX, "Could not sanitize legacy storage.", error);
});

chrome.runtime.onInstalled.addListener((details) => {
  Promise.all([
    settingsAtWorkerStart,
    settingsReady,
    SECURITY.runStorageSanitizationMigration()
  ]).then(async ([initialRecord]) => {
    const hadVersionedSettings = Object.prototype.hasOwnProperty.call(
      initialRecord || {},
      SETTINGS.storageKey
    );
    const settings = details.reason === "update" && !hadVersionedSettings
      ? await SETTINGS.set(SETTINGS.legacyDefaults())
      : await SETTINGS.initializeForInstall(details.reason);
    currentSettings = settings;
    configureLogging(settings);
  }).catch((error) => {
    console.warn(LOG_PREFIX, "Could not initialize extension settings.", error);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isKnownMessage(message)) return false;
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(errorResponse(error)));
  return true;
});

async function handleMessage(message, sender) {
  if (message?.type === "GLAD_DEV_LOG") {
    const settings = await getSettings();
    if (settings.diagnostics.enabled && message.record && self.GladiatusLogBuffer) {
      self.GladiatusLogBuffer.append(SECURITY.sanitizeForLog(message.record));
    }
    return { ok: true };
  }

  validateFeatureSender(sender);

  if (message?.type === "GLAD_GUILD_MARKET_CONTROL") {
    validateFeaturePage(sender, "guildMarket", "Guild Market");
    const action = String(message.action || "");
    if (!["start", "update", "stop"].includes(action)) {
      const error = new Error("Unknown guild-market lifecycle action.");
      error.code = "INVALID_REQUEST";
      throw error;
    }
    if (action !== "stop") await requireFeature("guildMarket");
    const result = await runGuildMarketMain(sender, action, action === "stop" ? [] : [message.settings || {}]);
    if (action !== "stop" && !await featureEnabled("guildMarket")) {
      await runGuildMarketMain(sender, "stop", []).catch(() => {});
      await requireFeature("guildMarket");
    }
    return { ok: true, result };
  }

  if (message?.type === "GLAD_GUILD_MARKET_APPLY") {
    await requireFeature("guildMarket");
    validateFeaturePage(sender, "guildMarket", "Guild Market");
    const result = await runGuildMarketMain(sender, "applySuggestedPrice", [message.request || {}]);
    await requireFeature("guildMarket");
    return { ok: true, result: SECURITY.sanitizeForStorage(result) };
  }

  if (message?.type === "GLAD_AUCTION_FORCE_SCAN") {
    await requireFeature("auction", "fullScan");
    validateGameUrl(message.request?.sourceUrl, "Auction source URL");
    log("manual auction scan requested", { url: safeUrl(message.request?.sourceUrl) });
    const result = await auctionScanner().forceScan(message.request);
    await requireFeature("auction", "fullScan");
    return { ok: true, result: SECURITY.sanitizeForStorage(result) };
  }

  if (message?.type === "GLAD_AH_REPAIR_AUCTION_CONTENT") {
    await requireFeature("auction");
    await repairFeatureContent(sender, "auction");
    return { ok: true };
  }

  if (message?.type === "GLAD_FEATURE_REPAIR") {
    const featureId = String(message.feature || "");
    await requireFeature(featureId);
    await repairFeatureContent(sender, featureId);
    return { ok: true };
  }

  if (message?.type === "GLAD_ARENA_PASSIVE_CHECK") {
    await requireFeature("arena", "passiveRefresh");
    validateGameUrl(message.url, "Arena page URL");
    const results = await arenaScanner().schedulePassiveCheck({
      url: message.url,
      preferredKind: message.preferredKind,
      force: Boolean(message.force),
      onlyPreferred: Boolean(message.onlyPreferred),
      delayMs: Number(message.delayMs) || 0,
      reason: message.reason || ""
    });
    await requireFeature("arena", "passiveRefresh");
    return { ok: true, results: SECURITY.sanitizeForStorage(results) };
  }

  if (message?.type === "GLAD_ARENA_ENSURE_VISIBLE_SCAN") {
    await requireFeature("arena", "passiveRefresh");
    validateGameUrl(message.url, "Arena page URL");
    const result = await arenaScanner().ensureVisibleScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula,
      simulations: await featureEnabled("arena", "simulations")
    });
    await requireFeature("arena", "passiveRefresh");
    return { ok: true, result: SECURITY.sanitizeForStorage(result) };
  }

  if (message?.type === "GLAD_ARENA_FORCE_SCAN") {
    await requireFeature("arena", "manualScan");
    validateGameUrl(message.url, "Arena page URL");
    const result = await arenaScanner().forceScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula,
      simulations: await featureEnabled("arena", "simulations")
    });
    await requireFeature("arena", "manualScan");
    return { ok: true, result: SECURITY.sanitizeForStorage(result) };
  }

  if (message?.type === "GLAD_ARENA_FETCH_PROFILE") {
    await requireFeature("arena", "manualScan");
    validateGameUrl(message.url, "Arena profile URL");
    const html = await arenaScanner().fetchProfileHtml(message.url);
    await requireFeature("arena", "manualScan");
    return { ok: true, html };
  }

  if (message?.type === "GLAD_ARENA_REFRESH_SELF_PROFILE") {
    await requireFeature("arena", "simulations");
    validateGameUrl(message.profileUrl, "Self profile URL");
    const record = await arenaScanner().refreshSelfProfile({
      profileUrl: message.profileUrl,
      force: Boolean(message.force)
    });
    await requireFeature("arena", "simulations");
    return { ok: true, record: SECURITY.sanitizeForStorage(record) };
  }

  if (message?.type === "GLAD_ARENA_FETCH_LIST") {
    await requireFeature("arena", "passiveRefresh");
    validateGameUrl(message.url, "Arena list URL");
    const html = await arenaScanner().fetchArenaListHtml(message.url);
    await requireFeature("arena", "passiveRefresh");
    return { ok: true, html };
  }

  return { ok: false, code: "UNKNOWN_MESSAGE", error: "Unknown extension message." };
}

function isKnownMessage(message) {
  return new Set([
    "GLAD_DEV_LOG",
    "GLAD_GUILD_MARKET_CONTROL",
    "GLAD_GUILD_MARKET_APPLY",
    "GLAD_AUCTION_FORCE_SCAN",
    "GLAD_AH_REPAIR_AUCTION_CONTENT",
    "GLAD_FEATURE_REPAIR",
    "GLAD_ARENA_PASSIVE_CHECK",
    "GLAD_ARENA_ENSURE_VISIBLE_SCAN",
    "GLAD_ARENA_FORCE_SCAN",
    "GLAD_ARENA_FETCH_PROFILE",
    "GLAD_ARENA_REFRESH_SELF_PROFILE",
    "GLAD_ARENA_FETCH_LIST"
  ]).has(message?.type);
}

async function getSettings() {
  if (currentSettings) return currentSettings;
  return settingsReady;
}

async function featureEnabled(featureId, capability = "") {
  const settings = await getSettings();
  return SETTINGS.isCapabilityEnabled(settings, featureId, capability);
}

async function requireFeature(featureId, capability = "") {
  if (await featureEnabled(featureId, capability)) return;
  const error = new Error(capability
    ? `${featureLabel(featureId)} ${capability} capability is disabled.`
    : `${featureLabel(featureId)} feature is disabled.`);
  error.code = "FEATURE_DISABLED";
  throw error;
}

function featureLabel(featureId) {
  return featureId === "guildMarket" ? "Guild market" : `${String(featureId || "Feature").replace(/^./, (value) => value.toUpperCase())}`;
}

function validateFeatureSender(sender) {
  const senderUrl = sender?.tab?.url || "";
  if (!SECURITY.isAllowedGameforgeUrl(senderUrl)) {
    const error = new Error("Feature requests must come from a Gladiatus game tab.");
    error.code = "INVALID_SENDER";
    throw error;
  }
}

function validateGameUrl(value, label) {
  try {
    return SECURITY.parseAllowedGameforgeUrl(value);
  } catch {
    const error = new Error(`${label} must use HTTPS on a Gladiatus Gameforge host.`);
    error.code = "INVALID_URL";
    throw error;
  }
}

function validateFeaturePage(sender, expectedMod, label) {
  const url = validateGameUrl(sender?.tab?.url, `${label} page URL`);
  if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== expectedMod) {
    const error = new Error(`${label} requests must come from the matching Gladiatus page.`);
    error.code = "INVALID_SENDER";
    throw error;
  }
  return url;
}

async function runGuildMarketMain(sender, method, args) {
  const tabId = sender?.tab?.id;
  if (!tabId || !chrome.scripting?.executeScript) {
    const error = new Error("The guild-market MAIN-world bridge is unavailable.");
    error.code = "BRIDGE_UNAVAILABLE";
    throw error;
  }
  const executions = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (methodName, methodArgs) => {
      const api = globalThis.GladiatusGuildMarket;
      if (!api || typeof api[methodName] !== "function") {
        return { ok: false, code: "BRIDGE_UNAVAILABLE", error: "The guild-market page bridge is unavailable." };
      }
      try {
        return { ok: true, result: api[methodName](...(Array.isArray(methodArgs) ? methodArgs : [])) };
      } catch (error) {
        return { ok: false, code: "BRIDGE_ERROR", error: error?.message || String(error) };
      }
    },
    args: [method, args]
  });
  const payload = executions?.[0]?.result;
  if (payload?.ok) return payload.result;
  const error = new Error(payload?.error || "The guild-market page bridge did not respond.");
  error.code = payload?.code || "BRIDGE_UNAVAILABLE";
  throw error;
}

async function repairFeatureContent(sender, featureId) {
  const tabId = sender?.tab?.id;
  const files = FEATURE_CONTENT_FILES[featureId];
  if (!tabId || !files) throw new Error("Cannot repair this feature without a supported sender tab.");
  if (!chrome.scripting?.executeScript) throw new Error("chrome.scripting is not available.");
  await chrome.scripting.executeScript({ target: { tabId }, files });
}

function arenaScanner() {
  if (!self.GladiatusArenaBackgroundScanner) throw new Error("Arena background scanner failed to load.");
  return self.GladiatusArenaBackgroundScanner;
}

function auctionScanner() {
  if (!self.GladiatusAuctionBackgroundScanner) throw new Error("Auction background scanner failed to load.");
  return self.GladiatusAuctionBackgroundScanner;
}

function errorResponse(error) {
  return {
    ok: false,
    code: error?.code || "EXTENSION_ERROR",
    error: error?.message || String(error)
  };
}

const devLogger = self.GladiatusLog ? self.GladiatusLog.createLogger("background") : null;

function log(message, details = {}) {
  if (devLogger) devLogger.debug(message, SECURITY.sanitizeForLog(details));
  else console.log(LOG_PREFIX, message, SECURITY.sanitizeForLog(details));
}

function safeUrl(value) {
  return SECURITY.sanitizeUrl(value);
}

function configureLogging(settings) {
  if (!self.GladiatusLog?.installFor) return;
  self.GladiatusLog.installFor("background", {
    diagnosticsEnabled: Boolean(settings?.diagnostics?.enabled)
  });
}
