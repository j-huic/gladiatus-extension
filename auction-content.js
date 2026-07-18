(() => {
  const CONTENT_VERSION = "auction-content-split-v2";
  const UI_ID = "glad-ah-sorter";
  const BADGE_CLASS = "glad-ah-score";
  const CARD_SELECTOR = "form[id^='auctionForm']";
  const MESSAGE_TYPES = {
    applySort: new Set(["GLAD_AH_APPLY_SORT", "GLAD_AH_APPLY_SORT_V2"]),
    boot: new Set(["GLAD_AH_BOOT", "GLAD_AH_BOOT_V2"]),
    customDefinitionsUpdated: new Set(["GLAD_AH_CUSTOM_DEFINITIONS_UPDATED", "GLAD_AH_CUSTOM_DEFINITIONS_UPDATED_V2"]),
    repair: new Set(["GLAD_AH_REPAIR_AUCTION_CONTENT"]),
    scanAll: new Set(["GLAD_AH_SCAN_ALL", "GLAD_AH_SCAN_ALL_V2"])
  };

  if (!isAuctionPageUrl(window.location.href)) return;

  if (window.GladiatusAuctionFeature?.version === CONTENT_VERSION
    && window.GladiatusAuctionFeature?.ready !== false) return;

  const missingDependencies = getMissingDependencies();
  if (missingDependencies.length) {
    let active = false;
    window.GladiatusAuctionFeature = {
      version: CONTENT_VERSION,
      ready: false,
      async start(settings = {}) {
        if (!shouldRunAuctionController(settings)) return this.stop();
        active = true;
        registerMissingDependencyDiagnostics(missingDependencies);
        requestDependencyRepair(missingDependencies);
      },
      async update(settings = {}) {
        if (shouldRunAuctionController(settings)) return this.start(settings);
        return this.stop();
      },
      async stop() {
        active = false;
        clearMissingDependencyDiagnostics();
      },
      getStatus() {
        return { active, ready: false, missingDependencies: [...missingDependencies] };
      }
    };
    return;
  }
  clearMissingDependencyDiagnostics();

  const { SCHEMA, MODEL, CORE } = getDependencies();

  window.__GladiatusAuctionContentLoaded = true;
  window.__GladiatusAuctionContentVersion = CONTENT_VERSION;

  function isAuctionPageUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  function shouldRunAuctionController(settings) {
    return Boolean(settings?.enabled && (settings?.pageSorter || settings?.fullScan));
  }

  function getMissingDependencies() {
    const dependencies = getDependencies();
    const missing = [];
    if (!dependencies.SCHEMA) missing.push("auction-schema.js");
    if (!dependencies.SCORE) missing.push("score-model.js");
    if (!dependencies.MODEL) missing.push("auction-model.js");
    if (!dependencies.CORE) missing.push("auction-core.js");
    return missing;
  }

  function getDependencies() {
    return {
      SCHEMA: window.GladiatusAuctionSchema,
      SCORE: window.GladiatusScoreModel,
      MODEL: window.GladiatusAuctionModel,
      CORE: window.GladiatusAuctionCore
    };
  }

  function registerMissingDependencyDiagnostics(missing) {
    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    if (window.__GladiatusAuctionMissingDependencyListener) return;

    const listener = (message, _sender, sendResponse) => {
      if (!isAuctionMessage(message)) return false;
      const nextMissing = getMissingDependencies();
      if (!nextMissing.length) {
        clearMissingDependencyDiagnostics();
        return false;
      }

      sendResponse({ ok: false, error: formatMissingDependencyError(nextMissing) });
      return false;
    };
    window.__GladiatusAuctionMissingDependencyListener = listener;
    chrome.runtime.onMessage.addListener(listener);
  }

  function requestDependencyRepair(missing) {
    if (window.__GladiatusAuctionRepairRequested) return;
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

    window.__GladiatusAuctionRepairRequested = true;
    chrome.runtime.sendMessage({
      type: "GLAD_AH_REPAIR_AUCTION_CONTENT",
      missing
    }, () => {
      if (chrome.runtime.lastError) {
        window.__GladiatusAuctionRepairRequested = false;
      }
    });
  }

  function clearMissingDependencyDiagnostics() {
    const listener = window.__GladiatusAuctionMissingDependencyListener;
    if (!listener || typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
    chrome.runtime.onMessage.removeListener(listener);
    delete window.__GladiatusAuctionMissingDependencyListener;
    delete window.__GladiatusAuctionRepairRequested;
  }

  function isAuctionMessage(message) {
    return isMessageType(message, MESSAGE_TYPES.boot)
      || isMessageType(message, MESSAGE_TYPES.scanAll)
      || isMessageType(message, MESSAGE_TYPES.applySort)
      || isMessageType(message, MESSAGE_TYPES.customDefinitionsUpdated);
  }

  function isMessageType(message, types) {
    return types.has(message?.type);
  }

  function formatMissingDependencyError(missing) {
    return `Auction content script dependencies missing: ${missing.join(", ")}. Reload the unpacked extension and refresh this auction tab.`;
  }

  const BASE_SORT_OPTIONS = [
    { id: "original", label: "Original order", group: "Base fields", get: (item) => -item.originalIndex },
    { id: "primaryTotal", label: "Primary stat total", group: "Base fields", get: (item) => sumKeys(item.stats, SCHEMA.primaryStatKeys) },
    ...makeBaseStatSortOptions(),
    { id: "level", label: "Level", group: "Base fields", get: (item) => item.level || 0 },
    { id: "itemValue", label: "Item value", group: "Base fields", get: (item) => item.itemValue || 0 },
    { id: "buyoutGold", label: "Immediate gold", group: "Base fields", get: (item) => item.priceGold || 0, defaultAscending: true }
  ];
  let customDefinitions = [];
  const STORAGE_KEY = SCHEMA.storageKeys.sortState;
  const FILTER_VALUES_STORAGE_KEY = MODEL.filterValuesStorageKey;
  const PAGE_BRIDGE_REQUEST_SOURCE = CORE.constants.pageBridgeRequestSource || "glad-ah-extension";
  const PAGE_BRIDGE_RESPONSE_SOURCE = CORE.constants.pageBridgeResponseSource || "glad-ah-page";
  const PAGE_SCHEMA_SCRIPT_ID = `glad-ah-page-schema-${CORE.version || CONTENT_VERSION}`;
  const PAGE_TOOLTIP_SCRIPT_ID = `glad-ah-page-tooltip-${CORE.version || CONTENT_VERSION}`;
  const PAGE_CORE_SCRIPT_ID = `glad-ah-page-core-${CORE.version || CONTENT_VERSION}`;

  let persistedSortState = null;
  const initialState = readSortState();
  let selectedSort = initialState.selectedSort;
  let descending = initialState.descending;
  let filterValuesByView = MODEL.normalizeAllFilterValues(initialState.filterValuesByView);
  let sortContextKey = getSortContextKey();
  let bootTimer = 0;
  let refreshTimer = 0;
  let lastItemSetSignature = "";
  let pageCoreLoadPromise = null;
  let active = false;
  let activeSettings = null;
  let initialized = false;
  let operationGeneration = 0;
  let nativeTableSnapshot = null;
  let pageRankingApplied = false;

  function makeBaseStatSortOptions() {
    const keys = [
      "strength",
      "dexterity",
      "agility",
      "constitution",
      "charisma",
      "intelligence",
      "lifepoints",
      "damageBonus",
      "health",
      "armour",
      "blockvalue",
      "healing",
      "criticalattackvalue",
      "criticalhealingvalue",
      "criticaldamage",
      "hardeningvalue",
      "damageAvg",
      "damageMax"
    ];
    const groups = {
      damageAvg: "Base fields",
      damageMax: "Base fields",
      blockvalue: "Tank stats",
      healing: "Tank stats",
      criticalhealingvalue: "Tank stats",
      hardeningvalue: "Tank stats"
    };

    return keys.map((key) => ({
      id: key,
      label: longStatLabel(key),
      group: groups[key] || "Base stats",
      get: (item) => MODEL.stat(item, key)
    }));
  }

  function longStatLabel(key) {
    const labels = {
      damageAvg: "Damage average",
      damageMax: "Damage max",
      damageBonus: "Damage bonus",
      lifepoints: "Life points",
      blockvalue: "Block value",
      criticalattackvalue: "Critical attack",
      criticalhealingvalue: "Critical healing",
      criticaldamage: "Critical damage"
    };
    return labels[key] || SCHEMA.statLabel(key);
  }

  function getSortOptions() {
    return [...MODEL.getPresetSortOptions(customDefinitions), ...BASE_SORT_OPTIONS];
  }

  async function loadCustomDefinitions() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      customDefinitions = [];
      return;
    }

    const result = await chrome.storage.local.get(MODEL.customDefinitionsStorageKey);
    customDefinitions = MODEL.normalizeCustomDefinitions(result[MODEL.customDefinitionsStorageKey]);
  }

  function refreshStateFromStorage() {
    const state = readSortState();
    selectedSort = state.selectedSort;
    descending = state.descending;
  }

  function ensurePageCoreInjected() {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return Promise.resolve();
    if (document.getElementById(PAGE_CORE_SCRIPT_ID)) return Promise.resolve();
    if (pageCoreLoadPromise) return pageCoreLoadPromise;

    pageCoreLoadPromise = injectPageScript("auction-schema.js", PAGE_SCHEMA_SCRIPT_ID)
      .then(() => injectPageScript("tooltip-parser.js", PAGE_TOOLTIP_SCRIPT_ID))
      .then(() => injectPageScript("auction-core.js", PAGE_CORE_SCRIPT_ID, { gladAuctionPageBridge: "1" }));

    return pageCoreLoadPromise;
  }

  function injectPageScript(file, id, dataset = {}) {
    if (document.getElementById(id)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.id = id;
      script.src = chrome.runtime.getURL(file);
      Object.assign(script.dataset, dataset);
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Could not inject ${file}.`));
      (document.head || document.documentElement).append(script);
    });
  }

  async function callPageCore(method, args = []) {
    await ensurePageCoreInjected();

    return new Promise((resolve, reject) => {
      const id = `glad-ah-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The auction scanner did not respond."));
      }, 60000);

      function onMessage(event) {
        if (event.source !== window || event.data?.source !== PAGE_BRIDGE_RESPONSE_SOURCE || event.data.id !== id) return;

        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);

        if (event.data.ok) {
          resolve(event.data.result);
        } else {
          reject(new Error(event.data.error || "The auction scanner failed."));
        }
      }

      window.addEventListener("message", onMessage);
      window.postMessage({ source: PAGE_BRIDGE_REQUEST_SOURCE, id, method, args }, "*");
    });
  }

  async function scanAuctionInBackground() {
    const generation = operationGeneration;
    const request = CORE.createAuctionScanRequest(document);
    const response = await sendRuntimeMessage({
      type: "GLAD_AUCTION_FORCE_SCAN",
      request
    });
    if (!active || generation !== operationGeneration) throw new Error("Auction feature is disabled.");
    if (!response?.ok) throw new Error(response?.error || "Could not scan auction categories.");
    return response.result;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function readSortState() {
    const defaults = {
      selectedSort: getContextDefaultSortId(),
      descending: true,
      filterValuesByView: {}
    };

    try {
      const saved = persistedSortState;
      if (!saved || typeof saved !== "object") return defaults;
      const filterValuesByView = saved.filterByView && typeof saved.filterByView === "object" ? saved.filterByView : {};

      const contextState = saved.byItemType?.[getSortContextKey()];
      if (!contextState || typeof contextState !== "object") {
        return { ...defaults, filterValuesByView };
      }

      const selectedOption = getSortOptions().find((option) => option.id === contextState.selectedSort && isSortOptionVisibleForCurrentView(option));
      if (!selectedOption) return { ...defaults, filterValuesByView };

      return {
        selectedSort: selectedOption.id,
        descending: typeof contextState.descending === "boolean" ? contextState.descending : !selectedOption.defaultAscending,
        filterValuesByView
      };
    } catch {
      return defaults;
    }
  }

  async function loadSortState() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      persistedSortState = null;
      return;
    }

    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY] && typeof stored[STORAGE_KEY] === "object") {
      persistedSortState = stored[STORAGE_KEY];
      return;
    }

    let legacy = null;
    try {
      legacy = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      legacy = null;
    }
    persistedSortState = legacy && typeof legacy === "object" ? legacy : null;
    if (!persistedSortState) return;

    await chrome.storage.local.set({ [STORAGE_KEY]: persistedSortState });
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // The migration succeeded even if the website blocks localStorage cleanup.
    }
  }

  function getContextDefaultSortId() {
    return MODEL.defaultPresetForItemType(getCurrentItemType());
  }

  function getCurrentView() {
    return MODEL.getViewForItemType(getCurrentItemType()) || MODEL.getView("armor");
  }

  function getCurrentItemType() {
    return document.querySelector("select[name='itemType']")?.value || "";
  }

  function getSortContextKey() {
    const ttype = new URL(window.location.href).searchParams.get("ttype") || "main";
    return `${ttype}:${getCurrentItemType() || "default"}`;
  }

  function saveSortState() {
    const byItemType = persistedSortState?.byItemType && typeof persistedSortState.byItemType === "object"
      ? persistedSortState.byItemType
      : {};
    persistedSortState = {
      byItemType: {
        ...byItemType,
        [getSortContextKey()]: { selectedSort, descending }
      }
    };
    if (!active || typeof chrome === "undefined" || !chrome.storage?.local) return Promise.resolve();
    return chrome.storage.local.set({ [STORAGE_KEY]: persistedSortState });
  }

  function getFilterValues(viewId) {
    return MODEL.normalizeFilterValues(viewId, filterValuesByView[viewId]);
  }

  function setFilterValue(viewId, filterId, value) {
    filterValuesByView = {
      ...filterValuesByView,
      [viewId]: {
        ...getFilterValues(viewId),
        [filterId]: value
      }
    };
  }

  function setFilterValues(viewId, values) {
    filterValuesByView = {
      ...filterValuesByView,
      [viewId]: MODEL.normalizeFilterValues(viewId, values)
    };
  }

  async function loadSharedFilterValues() {
    const legacy = readSortState().filterValuesByView;
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return MODEL.normalizeAllFilterValues(legacy);
    }

    const result = await chrome.storage.local.get(FILTER_VALUES_STORAGE_KEY);
    if (result[FILTER_VALUES_STORAGE_KEY]) {
      return MODEL.normalizeAllFilterValues(result[FILTER_VALUES_STORAGE_KEY]);
    }
    const migrated = MODEL.normalizeAllFilterValues(legacy);
    if (Object.keys(migrated).length) {
      await chrome.storage.local.set({ [FILTER_VALUES_STORAGE_KEY]: migrated });
    }
    return migrated;
  }

  async function saveSharedFilterValues() {
    if (!active || typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [FILTER_VALUES_STORAGE_KEY]: MODEL.normalizeAllFilterValues(filterValuesByView) });
  }

  function isAuctionPage() {
    try {
      return new URL(window.location.href).searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  function sumKeys(record, keys) {
    return keys.reduce((total, key) => total + (record[key] || 0), 0);
  }

  function getAuctionTable() {
    const firstForm = document.querySelector(CARD_SELECTOR);
    return firstForm ? firstForm.closest("table") : null;
  }

  function getAuctionFilterForm() {
    return Array.from(document.querySelectorAll("#content form, form"))
      .find((form) => form.querySelector("select[name='itemType']")) || null;
  }

  function getCurrentCategoryMeta() {
    const ttype = new URL(window.location.href).searchParams.get("ttype") || "";
    return SCHEMA.getCategoryForItemType(getCurrentItemType(), ttype) || {
      itemType: getCurrentItemType(),
      ttype,
      viewId: MODEL.getViewForItemType(getCurrentItemType())?.id || "armor"
    };
  }

  function collectItems() {
    const seenCells = new Set();
    const meta = getCurrentCategoryMeta();
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => {
        const cell = form.closest("td");
        if (!cell || seenCells.has(cell)) return null;
        seenCells.add(cell);

        const parsedItem = CORE.parseAuctionItemFromForm(form, index, meta);
        if (!parsedItem) return null;

        const originalIndex = Number.parseInt(cell.dataset.gladAhOriginalIndex, 10) || index;

        return {
          ...parsedItem,
          cell,
          form,
          icon: form.querySelector("[data-tooltip]"),
          originalIndex
        };
      })
      .filter(Boolean);
  }

  function getAuctionId(form, fallbackIndex) {
    const input = form.querySelector("input[name='auctionid']");
    return input && input.value ? input.value : String(fallbackIndex);
  }

  function getItemSetSignature() {
    return Array.from(document.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => getAuctionId(form, index))
      .sort()
      .join("|");
  }

  function getSelectedOption() {
    const options = getSortOptions();
    return options.find((option) => option.id === selectedSort && isSortOptionVisibleForCurrentView(option)) || options[0];
  }

  function isSortOptionVisibleForCurrentView(option) {
    return !option.viewId || option.viewId === getCurrentView().id;
  }

  function getVisibleSortOptions() {
    return getSortOptions().filter(isSortOptionVisibleForCurrentView);
  }

  function refreshSortContext() {
    const nextContextKey = getSortContextKey();
    if (nextContextKey === sortContextKey) return;

    sortContextKey = nextContextKey;
    const state = readSortState();
    selectedSort = state.selectedSort;
    descending = state.descending;
    renderSortSelectOptions();
    syncSortSelect();
    updateOrderButton();
    renderFilterControls();
  }

  function sortItems() {
    if (!active || !activeSettings?.pageSorter) return;
    refreshSortContext();

    const table = getAuctionTable();
    if (!table || !table.tBodies.length) return;

    const tbody = table.tBodies[0];
    const items = collectItems();
    if (!items.length) return;
    for (const item of items) {
      if (!item.cell.dataset.gladAhOriginalIndex) {
        item.cell.dataset.gladAhOriginalIndex = String(item.originalIndex);
      }
    }
    captureNativeTableSnapshot(tbody, items);
    lastItemSetSignature = getItemSetSignature();

    const option = getSelectedOption();
    const direction = selectedSort === "original" ? 1 : descending ? -1 : 1;
    const view = getCurrentView();
    const filterValues = getFilterValues(view.id);
    const visibleItems = [];
    const hiddenItems = [];

    for (const item of items) {
      const matchesViewFilters = MODEL.itemMatchesFilters(item, view.id, filterValues);
      const matchesSelectedPreset = !option.matches || option.matches(item);
      if (matchesViewFilters && matchesSelectedPreset) {
        visibleItems.push(item);
      } else {
        hiddenItems.push(item);
      }
    }

    visibleItems.sort((a, b) => {
      if (selectedSort === "original") {
        return a.originalIndex - b.originalIndex;
      }

      const aScore = option.get(a);
      const bScore = option.get(b);
      if (aScore !== bScore) return (aScore - bScore) * direction;
      if (a.level !== b.level) return (a.level - b.level) * direction;
      return a.originalIndex - b.originalIndex;
    });

    removeRowsContaining(items.map((item) => item.cell), tbody);
    appendTwoColumnRows(visibleItems, tbody);
    appendHiddenStash(hiddenItems, tbody);
    clearBadges(items);
    updateBadges(visibleItems, option);
    updateItemCount(visibleItems.length, items.length);
    setPageRankingStatus("Ranking applied to the current page.");
  }

  function removeRowsContaining(cells, tbody) {
    const cellSet = new Set(cells);
    Array.from(tbody.rows).forEach((row) => {
      if (Array.from(row.cells).some((cell) => cellSet.has(cell))) {
        row.remove();
      }
    });
  }

  function appendTwoColumnRows(items, tbody) {
    let row = null;
    items.forEach((item, index) => {
      item.cell.classList.remove("glad-ah-filtered-hidden");
      if (index % 2 === 0) {
        row = document.createElement("tr");
        row.className = "glad-ah-generated-row";
        tbody.append(row);
      }
      row.append(item.cell);
    });
  }

  function appendHiddenStash(items, tbody) {
    if (!items.length) return;

    const row = document.createElement("tr");
    row.className = "glad-ah-filter-stash glad-ah-generated-row";
    tbody.append(row);

    items.forEach((item) => {
      item.cell.classList.add("glad-ah-filtered-hidden");
      row.append(item.cell);
    });
  }

  function clearBadges(items) {
    items.forEach((item) => {
      item.cell.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
      item.cell.querySelectorAll(".glad-ah-score-host").forEach((host) => host.classList.remove("glad-ah-score-host"));
    });
  }

  function updateBadges(items, option) {
    if (!activeSettings?.scoreBadges) return;
    items.forEach((item) => {
      if (selectedSort === "original") return;

      const target = item.cell.querySelector(".auction_item_div");
      if (!target) return;
      target.classList.add("glad-ah-score-host");

      const score = option.get(item);
      const badge = document.createElement("div");
      badge.className = BADGE_CLASS;
      badge.textContent = option.display ? option.display(item, score) : `${formatScore(score)} ${option.label}`;
      badge.title = item.name;
      target.append(badge);
    });
  }

  function updateItemCount(count, total = count) {
    const countNode = document.querySelector(`#${UI_ID} .glad-ah-count`);
    if (countNode) countNode.textContent = count === total ? `${count} items` : `${count} / ${total} items`;
  }

  function formatScore(score) {
    return Number.isInteger(score) ? String(score) : score.toFixed(1);
  }

  function makeSelect() {
    const select = document.createElement("select");
    select.id = "glad-ah-sort-field";
    renderSortSelectOptions(select);
    select.addEventListener("change", () => {
      applySortSelection(select.value);
    });
    return select;
  }

  function renderSortSelectOptions(select = document.getElementById("glad-ah-sort-field")) {
    if (!select) return;

    select.replaceChildren();
    for (const [group, options] of groupSortOptions()) {
      const container = document.createElement("optgroup");
      container.label = group;

      options.forEach((option) => {
        const optionEl = document.createElement("option");
        optionEl.value = option.id;
        optionEl.textContent = option.label;
        container.append(optionEl);
      });

      select.append(container);
    }
    select.value = selectedSort;
  }

  function groupSortOptions() {
    const groups = new Map();

    getVisibleSortOptions().forEach((option) => {
      const group = option.group || "Other";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(option);
    });

    return groups.entries();
  }

  function applySortSelection(sortId, options = {}) {
    const option = getSortOptions().find((candidate) => candidate.id === sortId && isSortOptionVisibleForCurrentView(candidate));
    if (!option || !isSortOptionVisibleForCurrentView(option)) return;

    selectedSort = option.id;
    if (option.defaultAscending) {
      descending = false;
    } else if (selectedSort !== "original") {
      descending = true;
    }
    saveSortState();
    syncSortSelect();
    updateOrderButton();
    pageRankingApplied = false;
    setPageRankingStatus("Ranking choices changed. Apply when ready.");
    if (options.apply === true) applyRankingToCurrentPage();
  }

  function applyRankingToCurrentPage() {
    if (!active || !activeSettings?.pageSorter) return;
    pageRankingApplied = true;
    sortItems();
  }

  function setPageRankingStatus(text) {
    const status = document.querySelector(`#${UI_ID} .glad-ah-page-status`);
    if (status) status.textContent = text;
  }

  function syncSortSelect() {
    const select = document.getElementById("glad-ah-sort-field");
    if (select) select.value = selectedSort;
  }

  function makeFilterControls() {
    const controls = document.createElement("span");
    controls.id = "glad-ah-filter-controls";
    renderFilterControls(controls);
    return controls;
  }

  function renderFilterControls(container = document.getElementById("glad-ah-filter-controls")) {
    if (!container) return;

    const view = getCurrentView();
    const filterValues = getFilterValues(view.id);
    const controls = MODEL.getFilterControlDescriptors(view.id, filterValues);
    container.replaceChildren();

    if (!controls.length) return;

    const title = document.createElement("span");
    title.className = "glad-ah-filter-title";
    title.textContent = "Ranking rules";
    container.append(title);

    for (const filter of controls) {
      const label = document.createElement("label");
      label.className = "glad-ah-filter-control";

      const text = document.createElement("span");
      text.textContent = filter.label;

      const input = document.createElement("input");
      input.type = filter.type;
      input.min = String(filter.min);
      input.step = String(filter.step);
      input.dataset.viewId = view.id;
      input.dataset.filterId = filter.id;
      input.value = filter.value;
      input.addEventListener("input", () => {
        setFilterValue(view.id, filter.id, input.value);
        saveSharedFilterValues().catch(() => {});
        pageRankingApplied = false;
        setPageRankingStatus("Ranking choices changed. Apply when ready.");
      });

      label.append(text, input);
      container.append(label);
    }
  }

  function updateOrderButton() {
    const button = document.getElementById("glad-ah-sort-order");
    if (!button) return;
    button.textContent = descending ? "High first" : "Low first";
    button.disabled = selectedSort === "original";
  }

  function ensureUi() {
    if (!active || !activeSettings?.pageSorter || !isAuctionPage() || document.getElementById(UI_ID)) return;

    const table = getAuctionTable();
    const anchor = table || getAuctionFilterForm() || document.querySelector("#content");
    if (!anchor) return;

    const panel = document.createElement("div");
    panel.id = UI_ID;

    const title = document.createElement("strong");
    title.textContent = "Current-page ranking";

    const label = document.createElement("label");
    label.htmlFor = "glad-ah-sort-field";
    label.textContent = "Sort by";

    const select = makeSelect();
    const filterControls = makeFilterControls();

    const orderButton = document.createElement("button");
    orderButton.type = "button";
    orderButton.id = "glad-ah-sort-order";
    orderButton.addEventListener("click", () => {
      descending = !descending;
      saveSortState();
      updateOrderButton();
      pageRankingApplied = false;
      setPageRankingStatus("Ranking choices changed. Apply when ready.");
    });

    const applyButton = document.createElement("button");
    applyButton.type = "button";
    applyButton.textContent = "Apply ranking to current page";
    applyButton.addEventListener("click", applyRankingToCurrentPage);

    const pageStatus = document.createElement("span");
    pageStatus.className = "glad-ah-page-status";
    pageStatus.setAttribute("aria-live", "polite");
    pageStatus.textContent = "The native auction order is unchanged.";

    const count = document.createElement("span");
    count.className = "glad-ah-count";
    count.textContent = `${collectItems().length} items`;

    panel.append(title, label, select, orderButton, filterControls, applyButton, pageStatus, count);
    insertPanel(panel, table, anchor);
    updateOrderButton();
  }

  function insertPanel(panel, table, anchor) {
    const compareHeader = Array.from(document.querySelectorAll("#content h2"))
      .find((heading) => heading.textContent.trim() === "Compare with");

    if (compareHeader && compareHeader.parentElement) {
      compareHeader.before(panel);
      return;
    }

    const auctionTableContainer = table?.closest("#auction_table");
    if (auctionTableContainer) {
      auctionTableContainer.before(panel);
      return;
    }

    if (anchor.tagName === "FORM") {
      anchor.after(panel);
      return;
    }

    anchor.prepend(panel);
  }

  function boot() {
    if (!active || !activeSettings?.pageSorter) return;
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      ensureUi();
    }, 100);
  }
  window.__GladiatusAuctionBoot = boot;

  function scheduleRefresh() {
    if (!active || !activeSettings?.pageSorter || !pageRankingApplied) return;
    if (!document.getElementById(UI_ID)) {
      boot();
      return;
    }

    const signature = getItemSetSignature();
    if (!signature || signature === lastItemSetSignature) return;
    refreshSortContext();
    pageRankingApplied = false;
    lastItemSetSignature = signature;
    updateItemCount(collectItems().length);
    setPageRankingStatus("Auction items changed. Apply ranking to this page when ready.");
  }

  async function initialize(generation) {
    await loadSortState();
    await loadCustomDefinitions();
    filterValuesByView = await loadSharedFilterValues();
    if (!active || generation !== operationGeneration) return;
    refreshStateFromStorage();

    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleAuctionStorageChanged);
    }

    if (activeSettings?.pageSorter && document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else if (activeSettings?.pageSorter) {
      boot();
    }

    if (activeSettings?.pageSorter) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }
    initialized = true;
  }

  function handleAuctionStorageChanged(changes, areaName) {
    if (!active || areaName !== "local") return;

    if (changes[MODEL.customDefinitionsStorageKey]) {
      customDefinitions = MODEL.normalizeCustomDefinitions(changes[MODEL.customDefinitionsStorageKey].newValue);
      refreshStateFromStorage();
      renderSortSelectOptions();
      syncSortSelect();
      updateOrderButton();
      renderFilterControls();
      pageRankingApplied = false;
      setPageRankingStatus("Ranking rules changed. Apply when ready.");
    }

    if (changes[FILTER_VALUES_STORAGE_KEY]) {
      const nextValues = MODEL.normalizeAllFilterValues(changes[FILTER_VALUES_STORAGE_KEY].newValue);
      if (MODEL.filterValuesEqual(filterValuesByView, nextValues)) return;

      filterValuesByView = nextValues;
      renderFilterControls();
      pageRankingApplied = false;
      setPageRankingStatus("Ranking rules changed. Apply when ready.");
    }
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (!isAuctionMessage(message) && !isMessageType(message, MESSAGE_TYPES.repair)) return false;
    if (!active) {
      sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Auction feature is disabled." });
      return false;
    }

    if (isMessageType(message, MESSAGE_TYPES.applySort)) {
      if (!activeSettings?.pageSorter || !activeSettings?.applyRankingToPage) {
        sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Applying popup rankings to the page is disabled." });
        return false;
      }

      const option = getSortOptions().find((candidate) => candidate.id === message.sortId && isSortOptionVisibleForCurrentView(candidate));
      if (!option) {
        sendResponse({ ok: false, error: "Unknown auction sort preset." });
        return false;
      }

      if (message.viewId && message.filterValues) {
        setFilterValues(message.viewId, message.filterValues);
        saveSharedFilterValues().catch(() => {});
      }
      applySortSelection(option.id);
      renderFilterControls();
      applyRankingToCurrentPage();
      sendResponse({ ok: true });
      return false;
    }

    if (isMessageType(message, MESSAGE_TYPES.customDefinitionsUpdated)) {
      customDefinitions = MODEL.normalizeCustomDefinitions(message.definitions);
      refreshStateFromStorage();
      renderSortSelectOptions();
      syncSortSelect();
      updateOrderButton();
      renderFilterControls();
      pageRankingApplied = false;
      setPageRankingStatus("Ranking rules changed. Apply when ready.");
      sendResponse({ ok: true });
      return false;
    }

    if (isMessageType(message, MESSAGE_TYPES.boot)) {
      boot();
      sendResponse({
        ok: true,
        isAuctionPage: isAuctionPage(),
        hasPanel: Boolean(document.getElementById(UI_ID)),
        itemForms: document.querySelectorAll(CARD_SELECTOR).length,
        hasFilterForm: Boolean(getAuctionFilterForm())
      });
      return false;
    }

    if (!isMessageType(message, MESSAGE_TYPES.scanAll)) return false;
    if (!activeSettings?.fullScan) {
      sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Full auction scanning is disabled." });
      return false;
    }

    scanAuctionInBackground()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  const observer = new MutationObserver(() => {
    scheduleRefresh();
  });

  function captureNativeTableSnapshot(tbody, items) {
    if (nativeTableSnapshot?.tbody === tbody) return;
    nativeTableSnapshot = {
      tbody,
      rows: Array.from(tbody.rows).map((row) => ({ row, cells: Array.from(row.cells) })),
      itemCells: items.map((item) => item.cell)
    };
  }

  function restoreNativeTable() {
    const snapshot = nativeTableSnapshot;
    nativeTableSnapshot = null;
    if (!snapshot?.tbody?.isConnected) {
      document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
      document.querySelectorAll(".glad-ah-score-host").forEach((host) => host.classList.remove("glad-ah-score-host"));
      document.querySelectorAll(".glad-ah-filtered-hidden").forEach((cell) => cell.classList.remove("glad-ah-filtered-hidden"));
      document.querySelectorAll("[data-glad-ah-original-index]").forEach((cell) => delete cell.dataset.gladAhOriginalIndex);
      return;
    }

    snapshot.tbody.querySelectorAll(".glad-ah-generated-row").forEach((row) => row.remove());
    for (const entry of snapshot.rows) {
      for (const cell of entry.cells) entry.row.append(cell);
      snapshot.tbody.append(entry.row);
    }
    for (const cell of snapshot.itemCells) {
      cell.classList.remove("glad-ah-filtered-hidden");
      delete cell.dataset.gladAhOriginalIndex;
    }
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    document.querySelectorAll(".glad-ah-score-host").forEach((host) => host.classList.remove("glad-ah-score-host"));
    document.querySelectorAll("[data-glad-ah-original-index]").forEach((cell) => delete cell.dataset.gladAhOriginalIndex);
  }

  async function start(settings = {}) {
    if (!shouldRunAuctionController(settings)) return stop();
    if (active) return update(settings);

    active = true;
    activeSettings = { ...settings };
    operationGeneration += 1;
    const generation = operationGeneration;
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    }

    if (!activeSettings?.pageSorter) {
      initialized = true;
      return;
    }

    try {
      await initialize(generation);
    } catch {
      if (active && generation === operationGeneration && activeSettings?.pageSorter) boot();
    }
  }

  async function update(settings = {}) {
    await stop();
    if (shouldRunAuctionController(settings)) await start(settings);
  }

  async function stop() {
    active = false;
    activeSettings = null;
    initialized = false;
    operationGeneration += 1;
    window.clearTimeout(bootTimer);
    window.clearTimeout(refreshTimer);
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", boot);
    document.getElementById(UI_ID)?.remove();
    restoreNativeTable();
    lastItemSetSignature = "";
    pageRankingApplied = false;

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(handleAuctionStorageChanged);
    }
  }

  window.__GladiatusAuctionBoot = boot;
  window.GladiatusAuctionFeature = {
    version: CONTENT_VERSION,
    ready: true,
    start,
    update,
    stop,
    getStatus() {
      return {
        active,
        initialized,
        isAuctionPage: isAuctionPage(),
        hasPanel: Boolean(document.getElementById(UI_ID))
      };
    }
  };
})();
