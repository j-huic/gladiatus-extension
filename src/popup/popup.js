import { createArenaView } from "./views/arena-view.js";
import { createAuctionView } from "./views/auction-view.js";
import { createDevLogView } from "./views/dev-log-view.js";
import { createSettingsView } from "./views/settings-view.js";
import {
  ARENA,
  AUCTION_CONTENT_MESSAGES,
  FEATURE_SETTINGS,
  MODEL,
  detectPageMode,
  ensureAuctionPageUi,
  featureModules,
  getActiveTab,
  loadStorage,
  nodes,
  refreshArenaSelfProfile,
  saveStorage,
  scanArenaOpponents,
  sendAuctionScanMessage,
  sendTabMessage,
  setStatus
} from "./runtime.js";
import {
  FILTER_VALUES_STORAGE_KEY,
  POPUP_STATE_KEY,
  SCAN_ARCHIVE_STORAGE_KEY,
  SCAN_STORAGE_KEY,
  archivePreviousScan,
  getFilterValues,
  getSelectedArenaFormula,
  getSelectedPreset,
  getView,
  loadArenaFormulas,
  loadArenaUiState,
  makeNewArenaFormulaDraft,
  makeNewDefinitionDraft,
  normalizePopupState,
  normalizeScanResult,
  state
} from "./store.js";

const FALLBACK_ARENA_STORAGE_KEYS = {
  formulas: "glad-arena-formulas-v1",
  passiveScans: "glad-arena-passive-scans-v1",
  results: "glad-arena-last-scan-v1",
  scanStatus: "glad-arena-scan-status-v1",
  selfProfile: "glad-arena-self-profile-v1",
  uiState: "glad-arena-ui-state-v1"
};

const hydrated = { auction: false, arena: false };
let settingsUnsubscribe = null;

const auctionView = createAuctionView({ render, applyCurrentSortToPage });
const arenaView = createArenaView({ render, refreshSelfProfile });
const settingsView = createSettingsView({
  render,
  navigate,
  clearFeatureCache,
  clearAllData
});
createDevLogView({ setStatus });

nodes.scanButton.addEventListener("click", onScanButtonClick);
nodes.appNav.addEventListener("click", onAppNavClick);
nodes.pageTabs.addEventListener("click", onPageTabClick);
nodes.tabs.addEventListener("click", onItemTabClick);
nodes.controls.addEventListener("click", onPresetClick);
nodes.controls.addEventListener("input", onControlInput);
nodes.controls.addEventListener("change", onControlInput);
nodes.results.addEventListener("click", onResultsClick);
nodes.results.addEventListener("input", onEditorInput);
nodes.results.addEventListener("change", onResultsChange);
nodes.results.addEventListener("toggle", (event) => settingsView.onToggle(event), true);

init().catch((error) => {
  setStatus(`Could not initialize the popup: ${error?.message || error}`);
  state.shellPage = "home";
  state.helperSettings ||= fallbackSettings();
  render();
});

async function init() {
  state.activeTab = await getActiveTab();
  state.pageMode = detectPageMode(state.activeTab?.url);
  state.helperSettings = await loadHelperSettings();
  state.popupState = normalizePopupState(await loadStorage(POPUP_STATE_KEY));

  for (const featureId of ["auction", "arena"]) {
    if (!isFeatureEnabled(featureId)) continue;
    try {
      await hydrateFeatureData(featureId);
    } catch (error) {
      featureModules[featureId] = false;
      console.warn(`[Gladiatus Helper] Could not load ${featureId} popup data.`, error);
    }
  }

  subscribeToSettingsChanges();
  subscribeToSharedFilterChanges();

  if (!state.helperSettings.onboarding?.completed) {
    state.shellPage = "onboarding";
  } else {
    state.shellPage = settingsView.contextWorkspaceAvailable() ? "workspace" : "home";
  }
  render();

  if (state.shellPage === "workspace" && state.pageMode === "auction" && state.activeTab?.id) {
    ensureAuctionPageUi(state.activeTab).catch(() => {});
  }
}

async function loadHelperSettings() {
  if (!FEATURE_SETTINGS?.get) {
    setStatus("Feature settings did not load. Reload the extension after checking its files.");
    return fallbackSettings();
  }
  const saved = await FEATURE_SETTINGS.get();
  return FEATURE_SETTINGS.normalize ? FEATURE_SETTINGS.normalize(saved) : saved;
}

async function hydrateFeatureData(featureId) {
  if (hydrated[featureId] || !featureModules[featureId]) return;

  if (featureId === "auction") {
    state.scanResult = normalizeScanResult(await loadStorage(SCAN_STORAGE_KEY));
    state.filterValuesByView = MODEL.normalizeAllFilterValues(
      await loadStorage(FILTER_VALUES_STORAGE_KEY) || state.popupState.filterByView
    );
    state.customDefinitions = MODEL.normalizeCustomDefinitions(await loadStorage(MODEL.customDefinitionsStorageKey));
    state.editorDraft = makeNewDefinitionDraft();
  }

  if (featureId === "arena") {
    state.arenaResult = await loadStorage(arenaStorageKey("results"));
    state.selfProfile = await loadStorage(arenaStorageKey("selfProfile"));
    state.arenaFormulas = await loadArenaFormulas();
    state.arenaUiState = await loadArenaUiState(state.popupState);
    state.arenaFormulaDraft = makeNewArenaFormulaDraft();
  }

  hydrated[featureId] = true;
}

function subscribeToSettingsChanges() {
  if (!FEATURE_SETTINGS?.subscribe) return;
  settingsUnsubscribe = FEATURE_SETTINGS.subscribe(async (nextSettings) => {
    const previous = state.helperSettings;
    state.helperSettings = FEATURE_SETTINGS.normalize ? FEATURE_SETTINGS.normalize(nextSettings) : nextSettings;
    for (const featureId of ["auction", "arena"]) {
      if (!previous?.features?.[featureId]?.enabled && isFeatureEnabled(featureId)) {
        try {
          await hydrateFeatureData(featureId);
        } catch (error) {
          featureModules[featureId] = false;
          console.warn(`[Gladiatus Helper] Could not load ${featureId} popup data.`, error);
        }
      }
    }
    if (state.shellPage === "workspace" && !settingsView.contextWorkspaceAvailable()) state.shellPage = "home";
    render();
  });
}

function subscribeToSharedFilterChanges() {
  if (!chrome.storage?.onChanged || !MODEL) return;

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[FILTER_VALUES_STORAGE_KEY] || !isFeatureEnabled("auction")) return;
    const nextValues = MODEL.normalizeAllFilterValues(changes[FILTER_VALUES_STORAGE_KEY].newValue);
    if (MODEL.filterValuesEqual(state.filterValuesByView, nextValues)) return;

    state.filterValuesByView = nextValues;
    if (state.shellPage === "workspace" && state.pageMode === "auction" && state.popupState.pageId === "items") {
      auctionView.renderControls();
      auctionView.renderItems();
    }
  });
}

async function scanAuction() {
  if (!isCapabilityEnabled("auction", "fullScan")) {
    setStatus("Enable Auction tools and Full auction scan before scanning.");
    return;
  }

  nodes.scanButton.disabled = true;
  nodes.results.textContent = "";
  setStatus("Scanning auction categories…");

  try {
    const tab = await getActiveTab();
    if (!tab?.id) throw new Error("No active tab found.");
    if (detectPageMode(tab.url) !== "auction") throw new Error("Open a Gladiatus auction page before scanning.");

    const response = await sendAuctionScanMessage(tab);
    if (!response?.ok) throw featureResponseError(response, "The auction page did not return scan results.");

    const previousScan = state.scanResult;
    state.scanResult = normalizeScanResult(response.result);
    if (!isCapabilityEnabled("auction", "fullScan")) return;
    await archivePreviousScan(previousScan, state.scanResult);
    await saveStorage(SCAN_STORAGE_KEY, state.scanResult);
    state.popupState.pageId = "items";
    await saveStorage(POPUP_STATE_KEY, state.popupState);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    nodes.scanButton.disabled = false;
  }
}

async function scanArena() {
  if (!isCapabilityEnabled("arena", "manualScan")) {
    setStatus("Enable Arena insights and Manual opponent scan before scanning.");
    return;
  }

  nodes.scanButton.disabled = true;
  nodes.results.textContent = "";
  setStatus("Scanning arena opponents…");

  try {
    state.activeTab = await getActiveTab();
    if (!state.activeTab?.id) throw new Error("No active tab found.");
    if (detectPageMode(state.activeTab.url) !== "arena") throw new Error("Open a Gladiatus arena page before scanning opponents.");

    const response = await scanArenaOpponents(state.activeTab, getSelectedArenaFormula());
    if (!response?.ok) throw featureResponseError(response, "The arena page did not return scan results.");
    if (!isCapabilityEnabled("arena", "manualScan")) return;

    state.arenaResult = response.result;
    await saveStorage(arenaStorageKey("results"), state.arenaResult);
    render();
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    nodes.scanButton.disabled = false;
  }
}

async function onScanButtonClick() {
  if (state.shellPage !== "workspace") return;
  if (state.pageMode === "arena") return scanArena();
  if (state.pageMode === "auction") return scanAuction();
}

function render() {
  configureShell();
  clearWorkspaceChrome();

  if (!state.helperSettings?.onboarding?.completed || state.shellPage === "onboarding") {
    settingsView.renderOnboarding();
    return;
  }
  if (state.shellPage === "home") {
    settingsView.renderHome();
    return;
  }
  if (state.shellPage === "settings") {
    settingsView.renderSettings();
    return;
  }
  renderWorkspace();
}

function configureShell() {
  const onboarding = !state.helperSettings?.onboarding?.completed || state.shellPage === "onboarding";
  nodes.title.textContent = "Gladiatus Helper";
  nodes.contextLabel.textContent = contextLabel();
  nodes.appNav.hidden = onboarding;

  for (const button of nodes.appNav.querySelectorAll("button[data-shell-page]")) {
    const active = button.dataset.shellPage === state.shellPage;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  nodes.workspaceNav.textContent = workspaceLabel();
  nodes.workspaceNav.disabled = !settingsView.contextWorkspaceAvailable();
  nodes.diagnostics.hidden = !(state.shellPage === "settings" && state.helperSettings?.diagnostics?.enabled);

  const canScanAuction = state.shellPage === "workspace"
    && state.pageMode === "auction"
    && isCapabilityEnabled("auction", "fullScan");
  const canScanArena = state.shellPage === "workspace"
    && state.pageMode === "arena"
    && isCapabilityEnabled("arena", "manualScan");
  nodes.scanButton.hidden = !(canScanAuction || canScanArena);
  nodes.scanButton.textContent = canScanArena ? "Scan opponents" : "Scan auction";
}

function clearWorkspaceChrome() {
  nodes.pageTabs.hidden = true;
  nodes.pageTabs.replaceChildren();
  nodes.summary.hidden = true;
  nodes.summary.textContent = "";
  nodes.tabs.hidden = true;
  nodes.tabs.replaceChildren();
  nodes.controls.hidden = true;
  nodes.controls.replaceChildren();
}

function renderWorkspace() {
  if (!settingsView.contextWorkspaceAvailable()) {
    state.shellPage = "home";
    settingsView.renderHome();
    return;
  }

  if (state.pageMode === "auction") {
    auctionView.renderPageTabs();
    if (state.popupState.pageId === "filters") auctionView.renderFiltersPage();
    else if (state.popupState.pageId === "current") auctionView.renderCurrentPage();
    else auctionView.renderItemsPage();
    return;
  }

  if (state.pageMode === "arena") {
    arenaView.renderArenaPage();
    return;
  }

  if (state.pageMode === "guildMarket") renderGuildMarketWorkspace();
}

function renderGuildMarketWorkspace() {
  const page = document.createElement("section");
  page.className = "shell-page";
  const title = document.createElement("h2");
  title.className = "shell-heading";
  title.textContent = "Guild Market pricing";
  const description = document.createElement("p");
  description.className = "shell-intro";
  description.textContent = "Stage an item on the Guild Market page. A matching enabled rule changes only the price field automatically.";
  const notice = document.createElement("p");
  notice.className = "notice";
  notice.textContent = "No extra page controls are added. Fees are recalculated, and the extension never submits the listing.";
  page.append(title, description, notice);

  const rules = state.helperSettings.features.guildMarket.rules.filter((rule) => rule.enabled !== false);
  const list = document.createElement("section");
  list.className = "settings-card";
  const heading = document.createElement("h2");
  heading.textContent = "Enabled pricing rules";
  list.append(heading);
  if (!rules.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No enabled pricing rules. Edit Guild Market pricing from Home.";
    list.append(empty);
  } else {
    for (const rule of rules) {
      const row = document.createElement("p");
      row.className = "rule-meta";
      row.textContent = `${rule.itemName}: ${new Intl.NumberFormat().format(rule.pricePerUnit)} gold per item`;
      list.append(row);
    }
  }
  page.append(list);
  nodes.results.replaceChildren(page);
  setStatus("Automatic Guild Market pricing is ready on the current page.");
}

function navigate(shellPage) {
  if (shellPage === "workspace" && !settingsView.contextWorkspaceAvailable()) {
    setStatus("Enable the current page’s feature from Home first.");
    state.shellPage = "home";
  } else {
    state.shellPage = shellPage;
  }
  render();
}

function onAppNavClick(event) {
  const button = event.target.closest("button[data-shell-page]");
  if (!button || button.disabled) return;
  navigate(button.dataset.shellPage);
}

async function onPageTabClick(event) {
  if (state.shellPage !== "workspace") return;
  const button = event.target.closest("button[data-page-id]");
  if (!button) return;

  if (state.pageMode === "arena") state.popupState.arenaPageId = button.dataset.pageId;
  else state.popupState.pageId = button.dataset.pageId;
  await saveStorage(POPUP_STATE_KEY, state.popupState);
  render();
}

async function onItemTabClick(event) {
  if (state.shellPage === "workspace" && state.pageMode === "auction") await auctionView.onItemTabClick(event);
}

async function onPresetClick(event) {
  if (state.shellPage !== "workspace") return;
  if (state.pageMode === "arena" && await arenaView.onControlsClick(event)) return;
  if (state.pageMode === "auction") await auctionView.onPresetClick(event);
}

async function onControlInput(event) {
  if (state.shellPage !== "workspace") return;
  if (state.pageMode === "arena" && await arenaView.onControlsInput(event)) return;
  if (state.pageMode === "auction") await auctionView.onFilterInput(event);
}

async function onResultsClick(event) {
  if (state.shellPage !== "workspace" || state.pageMode === "guildMarket") {
    await settingsView.onClick(event);
    return;
  }
  if (state.pageMode === "arena" && await arenaView.onResultsClick(event)) return;
  if (state.pageMode === "auction") await auctionView.onResultsClick(event);
}

async function onResultsChange(event) {
  if (state.shellPage !== "workspace" || state.pageMode === "guildMarket") {
    await settingsView.onChange(event);
    return;
  }
  onEditorInput(event);
}

function onEditorInput(event) {
  if (state.shellPage !== "workspace") return;
  if (state.pageMode === "arena" && arenaView.onEditorInput(event)) return;
  if (state.pageMode === "auction") auctionView.onEditorInput(event);
}

async function applyCurrentSortToPage() {
  if (!isCapabilityEnabled("auction", "pageSorter")) {
    setStatus("Enable Current-page ranking in Auction tools first.");
    return;
  }
  if (!isCapabilityEnabled("auction", "applyRankingToPage")) {
    setStatus("Enable Allow popup Apply in Auction tools before changing the open page from the popup.");
    return;
  }
  const view = getView();
  if (!view) {
    setStatus("Auction ranking modules are unavailable.");
    return;
  }
  const preset = getSelectedPreset(view);
  const filterValues = getFilterValues(view.id);

  try {
    const tab = await getActiveTab();
    if (!tab?.id || detectPageMode(tab.url) !== "auction") throw new Error("Open a Gladiatus auction page before applying a ranking.");
    const response = await sendTabMessage(tab.id, {
      type: AUCTION_CONTENT_MESSAGES.applySort,
      sortId: preset.isCustom ? preset.id : MODEL.presetSortId(view.id, preset.id),
      viewId: view.id,
      filterValues
    });
    if (response?.ok === false) throw featureResponseError(response, "The auction page rejected the ranking.");
    setStatus("Ranking applied to the current auction page.");
  } catch (error) {
    setStatus(error?.message || "Could not apply the ranking to the current page.");
  }
}

async function refreshSelfProfile(options = {}) {
  if (!isCapabilityEnabled("arena", "manualScan")) {
    setStatus("Enable Manual opponent scan before refreshing your profile.");
    return;
  }
  if (!isCapabilityEnabled("arena", "simulations")) {
    setStatus("Enable Matchup simulations before refreshing your combat profile.");
    return;
  }
  setStatus("Refreshing self profile…");

  try {
    state.activeTab = await getActiveTab();
    if (!state.activeTab?.id || detectPageMode(state.activeTab.url) !== "arena") {
      throw new Error("Open a Gladiatus arena page before refreshing your profile.");
    }

    const response = await refreshArenaSelfProfile(state.activeTab, { force: options.force !== false });
    if (!response?.ok) throw featureResponseError(response, "Could not refresh self profile.");
    if (!isCapabilityEnabled("arena", "manualScan") || !isCapabilityEnabled("arena", "simulations")) return;

    state.selfProfile = response.record || await loadStorage(arenaStorageKey("selfProfile"));
    await saveStorage(arenaStorageKey("selfProfile"), state.selfProfile);
    render();
    setStatus("Self profile refreshed.");
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

async function clearFeatureCache(featureId) {
  let message = "";
  if (featureId === "auction") {
    await chrome.storage.local.remove([SCAN_STORAGE_KEY, SCAN_ARCHIVE_STORAGE_KEY]);
    state.scanResult = null;
    message = "Auction scan cache cleared. Ranking rules and eligibility settings were kept.";
  } else if (featureId === "arena") {
    await chrome.storage.local.remove([
      arenaStorageKey("results"),
      arenaStorageKey("passiveScans"),
      arenaStorageKey("scanStatus"),
      arenaStorageKey("selfProfile")
    ]);
    state.arenaResult = null;
    state.selfProfile = null;
    message = "Arena scans and cached profiles cleared. Formulas were kept.";
  }
  render();
  if (message) setStatus(message);
}

async function clearAllData() {
  if (settingsUnsubscribe) {
    settingsUnsubscribe();
    settingsUnsubscribe = null;
  }
  await chrome.storage.local.clear();
  await window.GladiatusLogDrain?.clear?.();
  state.helperSettings = FEATURE_SETTINGS?.reset
    ? await FEATURE_SETTINGS.reset()
    : fallbackSettings();
  state.helperSettings ||= fallbackSettings();
  state.popupState = normalizePopupState();
  state.scanResult = null;
  state.arenaResult = null;
  state.selfProfile = null;
  state.customDefinitions = [];
  state.arenaFormulas = [];
  state.filterValuesByView = {};
  state.guildRuleDraft = null;
  hydrated.auction = false;
  hydrated.arena = false;
  state.shellPage = "onboarding";
  subscribeToSettingsChanges();
  render();
  setStatus("All extension data cleared. Choose features to begin again.");
}

function isFeatureEnabled(featureId) {
  return isCapabilityEnabled(featureId);
}

function isCapabilityEnabled(featureId, capability) {
  if (FEATURE_SETTINGS?.isCapabilityEnabled) {
    return FEATURE_SETTINGS.isCapabilityEnabled(state.helperSettings, featureId, capability);
  }
  const feature = state.helperSettings?.features?.[featureId];
  return Boolean(feature?.enabled && (!capability || feature[capability]));
}

function arenaStorageKey(name) {
  const propertyByName = {
    formulas: "formulasStorageKey",
    passiveScans: "passiveScansStorageKey",
    results: "resultsStorageKey",
    scanStatus: "scanStatusStorageKey",
    selfProfile: "selfProfileStorageKey",
    uiState: "uiStateStorageKey"
  };
  return ARENA?.[propertyByName[name]] || FALLBACK_ARENA_STORAGE_KEYS[name];
}

function contextLabel() {
  if (state.shellPage === "settings") return "Settings";
  if (state.shellPage === "home" || state.shellPage === "onboarding") return "Unofficial Gladiatus workflow helper";
  if (state.pageMode === "auction") return "Auction";
  if (state.pageMode === "arena") return "Arena";
  if (state.pageMode === "guildMarket") return "Guild Market";
  return "Unofficial";
}

function workspaceLabel() {
  if (state.pageMode === "auction") return "Auction";
  if (state.pageMode === "arena") return "Arena";
  if (state.pageMode === "guildMarket") return "Guild Market";
  return "Current page";
}

function featureResponseError(response, fallback) {
  const error = new Error(response?.error || fallback);
  error.code = response?.code || "";
  return error;
}

function fallbackSettings() {
  return {
    version: 1,
    onboarding: { completed: false, version: 1 },
    features: {
      auction: { enabled: false, pageSorter: true, fullScan: true, scoreBadges: true, applyRankingToPage: false },
      arena: { enabled: false, annotations: true, manualScan: true, simulations: true, passiveRefresh: false, statusWidget: true, quickFight: true },
      guildMarket: {
        enabled: false,
        mode: "automatic",
        rules: [{ id: "mini-pumpkin", itemName: "Mini-Pumpkin", pricePerUnit: 100000, enabled: true }]
      }
    },
    diagnostics: { enabled: false }
  };
}
