export const SCHEMA = window.GladiatusAuctionSchema || null;
export const SCORE = window.GladiatusScoreModel || null;
export const MODEL = window.GladiatusAuctionModel || null;
export const CORE = window.GladiatusAuctionCore || null;
export const ARENA = window.GladiatusArenaCore || null;
export const ARENA_SIM = window.GladiatusArenaSim || null;
export const SMELTING_DATA = window.GladiatusSmeltingMaterialData || null;
export const SMELTING_TOOLTIP_MODEL = window.GladiatusSmeltingTooltipModel || null;
export const FEATURE_SETTINGS = window.GladiatusFeatureSettings || window.GladiatusHelperSettings || null;

export const featureModules = {
  auction: Boolean(SCHEMA && SCORE && MODEL && CORE),
  arena: Boolean(SCORE && ARENA && ARENA_SIM),
  smelting: Boolean(SMELTING_DATA && SMELTING_TOOLTIP_MODEL),
  guildMarket: true
};

export const AUCTION_CONTENT_MESSAGES = {
  applySort: "GLAD_AH_APPLY_SORT_V2",
  boot: "GLAD_AH_BOOT_V2",
  customDefinitionsUpdated: "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED_V2",
  scanAll: "GLAD_AH_SCAN_ALL_V2"
};

export const nodes = {
  title: document.querySelector("h1"),
  contextLabel: document.getElementById("context-label"),
  scanButton: document.getElementById("scan-button"),
  status: document.getElementById("status"),
  appNav: document.getElementById("app-nav"),
  workspaceNav: document.getElementById("workspace-nav"),
  pageTabs: document.getElementById("page-tabs"),
  summary: document.getElementById("summary"),
  tabs: document.getElementById("tabs"),
  controls: document.getElementById("controls"),
  results: document.getElementById("results"),
  diagnostics: document.getElementById("diagnostics")
};

export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

export function detectPageMode(url) {
  try {
    const parsed = new URL(url || "");
    if (!parsed.hostname.endsWith(".gladiatus.gameforge.com") || !parsed.pathname.endsWith("/game/index.php")) return "unsupported";
    const mod = parsed.searchParams.get("mod");
    if (mod === "auction") return "auction";
    if (mod === "arena") return "arena";
    if (mod === "guildMarket") return "guildMarket";
  } catch {
    // Unsupported pages use the default mode.
  }

  return "unsupported";
}

export async function sendAuctionScanMessage(tab) {
  try {
    const response = await sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
    if (response) return response;
  } catch {
    await ensureFeatureContentScript(tab.id, "auction");
    return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
  }

  await ensureFeatureContentScript(tab.id, "auction");
  return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.scanAll });
}

export async function ensureAuctionPageUi(tab) {
  try {
    const response = await sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.boot });
    if (response?.ok) return response;
  } catch {
    // Retry by explicitly injecting the current content scripts.
  }

  await ensureFeatureContentScript(tab.id, "auction");
  return sendTabMessage(tab.id, { type: AUCTION_CONTENT_MESSAGES.boot });
}

export async function scanArenaOpponents(tab, formula) {
  const message = {
    type: "GLAD_ARENA_SCAN_OPPONENTS",
    formula
  };

  try {
    const response = await sendTabMessage(tab.id, message);
    if (response) return response;
  } catch {
    await ensureFeatureContentScript(tab.id, "arena");
    return sendTabMessage(tab.id, message);
  }

  await ensureFeatureContentScript(tab.id, "arena");
  return sendTabMessage(tab.id, message);
}

export async function refreshArenaSelfProfile(tab, options = {}) {
  const message = {
    type: "GLAD_ARENA_REFRESH_SELF_PROFILE",
    force: Boolean(options.force)
  };

  try {
    const response = await sendTabMessage(tab.id, message);
    if (response) return response;
  } catch {
    await ensureFeatureContentScript(tab.id, "arena");
    return sendTabMessage(tab.id, message);
  }

  await ensureFeatureContentScript(tab.id, "arena");
  return sendTabMessage(tab.id, message);
}

export function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}

export async function ensureFeatureContentScript(tabId, featureId) {
  if (!chrome.scripting?.executeScript) {
    throw new Error("This feature is not available on the tab. Reload the page after reloading the extension.");
  }

  const filesByFeature = {
    auction: [
      "src/shared/helper-security.js",
      "src/shared/helper-settings.js",
      "src/shared/logging/log-core.js",
      "src/shared/logging/log-setup.js",
      "src/features/auction/auction-schema.js",
      "src/shared/score-model.js",
      "src/features/auction/auction-model.js",
      "src/shared/tooltip-parser.js",
      "src/features/auction/auction-core.js",
      "src/features/auction/auction-content.js",
      "src/runtime/feature-runtime.js"
    ],
    arena: [
      "src/shared/helper-security.js",
      "src/shared/helper-settings.js",
      "src/shared/logging/log-core.js",
      "src/shared/logging/log-setup.js",
      "src/shared/score-model.js",
      "src/features/arena/arena-core.js",
      "src/features/arena/arena-sim.js",
      "src/features/arena/arena-scan.js",
      "src/features/arena/arena-passive-content.js",
      "src/features/arena/arena-fight.js",
      "src/features/arena/arena-header-button.js",
      "src/features/arena/arena-status-content.js",
      "src/features/arena/arena-content.js",
      "src/runtime/feature-runtime.js"
    ]
  };
  const files = filesByFeature[featureId];
  if (!files) throw new Error(`Unknown feature repair request: ${featureId}`);

  await chrome.scripting.executeScript({
    target: { tabId },
    files
  });
}

// Compatibility for callers that still use the old auction-specific name.
export function ensureAuctionContentScript(tabId) {
  return ensureFeatureContentScript(tabId, "auction");
}

export async function loadStorage(key) {
  const result = await chrome.storage.local.get(key);
  return result[key] ?? null;
}

export async function saveStorage(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export function setStatus(text) {
  if (nodes.status) nodes.status.textContent = text;
}
