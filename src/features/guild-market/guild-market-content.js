// Isolated-world guild-market pricing controller.
//
// Pricing rules live here. After the game stages a matching item, this
// controller silently asks the page-world bridge to fill #preis. It injects no
// page UI and never submits the form.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const CONTENT_VERSION = "guild-market-content-v5";
  const LEGACY_UI_IDS = Object.freeze([
    "glad-guild-market-suggestion",
    "glad-guild-market-style"
  ]);
  const FILL_TIMEOUT_MS = 1500;
  const PAGE_MESSAGES = Object.freeze({
    source: "glad-helper:guild-market-main",
    staged: "staged"
  });
  const RUNTIME_MESSAGES = Object.freeze({
    control: "GLAD_GUILD_MARKET_CONTROL",
    fill: "GLAD_GUILD_MARKET_FILL"
  });
  const DEFAULT_RULES = Object.freeze([
    { id: "mini-pumpkin", itemName: "Mini-Pumpkin", pricePerUnit: 100000, enabled: true }
  ]);
  const TEST_RULES = Object.freeze([
    { id: "test-meat-haunch", itemName: "Meat Haunch", pricePerUnit: 100000, enabled: true }
  ]);

  const previous = root.GladiatusGuildMarketController;
  if (previous?.version === CONTENT_VERSION) return;
  try {
    previous?.stop?.()?.catch?.(() => {});
  } catch (_error) {
    // A stale controller must not block the safe replacement.
  }

  function removeLegacyUi() {
    for (const id of LEGACY_UI_IDS) root.document?.getElementById?.(id)?.remove?.();
  }

  removeLegacyUi();

  const state = {
    started: false,
    settings: null,
    staged: null,
    pending: null,
    requestSequence: 0,
    timers: new Set(),
    lifecycleGeneration: 0
  };

  function isGuildMarketUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:"
        && parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "guildMarket";
    } catch {
      return false;
    }
  }

  function normalizeItemName(value) {
    return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  function positiveSafeInteger(value) {
    const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function validateRules(rawRules) {
    const rules = [];
    const errors = [];
    const names = new Set();
    const source = Array.isArray(rawRules) ? rawRules : [];

    source.forEach((rawRule, index) => {
      if (!rawRule || typeof rawRule !== "object") {
        errors.push({ index, code: "INVALID_RULE", error: "Pricing rules must be objects." });
        return;
      }
      const itemName = String(rawRule.itemName ?? "").trim().replace(/\s+/g, " ");
      const normalizedName = normalizeItemName(itemName);
      const pricePerUnit = positiveSafeInteger(rawRule.pricePerUnit);
      if (!normalizedName) {
        errors.push({ index, code: "ITEM_NAME_REQUIRED", error: "A pricing rule needs an item name." });
        return;
      }
      if (names.has(normalizedName)) {
        errors.push({ index, code: "DUPLICATE_ITEM", error: `Only one pricing rule may target ${itemName}.` });
        return;
      }
      if (pricePerUnit === null) {
        errors.push({ index, code: "INVALID_UNIT_PRICE", error: `${itemName} needs a positive whole-number unit price.` });
        return;
      }
      names.add(normalizedName);
      rules.push({
        id: String(rawRule.id || `guild-rule-${index + 1}`),
        itemName,
        pricePerUnit,
        enabled: rawRule.enabled !== false
      });
    });

    return { valid: errors.length === 0, rules, errors };
  }

  function matchRule(itemName, rules) {
    const normalizedName = normalizeItemName(itemName);
    if (!normalizedName) return null;
    const enabledRules = (Array.isArray(rules) ? rules : []).filter((rule) => rule?.enabled === true);
    return enabledRules.find((rule) => normalizeItemName(rule.itemName) === normalizedName)
      || enabledRules.find((rule) => normalizedName.includes(normalizeItemName(rule.itemName)))
      || null;
  }

  function calculateSuggestion(staged, rule) {
    const quantity = positiveSafeInteger(staged?.quantity);
    const unitPrice = positiveSafeInteger(rule?.pricePerUnit);
    if (quantity === null || unitPrice === null) return null;
    const price = quantity * unitPrice;
    if (!Number.isSafeInteger(price) || price <= 0) return null;
    return { quantity, unitPrice, price };
  }

  function featureSettingsFrom(value) {
    if (value?.features?.guildMarket) return value.features.guildMarket;
    if (value?.guildMarket) return value.guildMarket;
    return value && typeof value === "object" ? value : {};
  }

  function normalizeSettings(value) {
    const raw = featureSettingsFrom(value);
    const sourceRules = raw.rules === undefined ? DEFAULT_RULES : raw.rules;
    const validation = validateRules(sourceRules);
    return {
      enabled: raw.enabled === true,
      mode: "automatic",
      rules: [...validation.rules, ...TEST_RULES],
      ruleErrors: validation.errors
    };
  }

  function addTimer(callback, delay) {
    if (typeof root.setTimeout !== "function") return null;
    const timer = root.setTimeout(() => {
      state.timers.delete(timer);
      callback();
    }, delay);
    state.timers.add(timer);
    return timer;
  }

  function clearTimer(timer) {
    if (timer == null) return;
    root.clearTimeout?.(timer);
    state.timers.delete(timer);
  }

  function clearAllTimers() {
    for (const timer of state.timers) root.clearTimeout?.(timer);
    state.timers.clear();
  }

  function clearPending() {
    if (!state.pending) return;
    clearTimer(state.pending.timer);
    state.pending = null;
  }

  function priceCandidate() {
    if (!state.started || !state.staged?.itemName) return null;
    const rule = matchRule(state.staged.itemName, state.settings.rules);
    if (!rule) return null;
    const suggestion = calculateSuggestion(state.staged, rule);
    return suggestion ? { rule, suggestion } : null;
  }

  function fillCurrentStage() {
    const candidate = priceCandidate();
    if (!candidate) return;
    requestFill(candidate.rule, candidate.suggestion).catch((error) => {
      onFilled({
        requestId: state.pending?.requestId || "",
        ok: false,
        error: error?.message || String(error)
      });
    });
  }

  async function requestFill(rule, suggestion) {
    if (!state.started || !state.staged || state.pending) return;

    state.requestSequence += 1;
    const requestId = `guild-price-${state.requestSequence}`;
    const timer = addTimer(() => {
      if (state.pending?.requestId !== requestId) return;
      state.pending = null;
    }, FILL_TIMEOUT_MS);
    state.pending = { requestId, timer };
    const request = {
      requestId,
      stageId: state.staged.stageId,
      itemName: state.staged.itemName,
      quantity: suggestion.quantity,
      unitPrice: suggestion.unitPrice,
      price: suggestion.price,
      ruleId: rule.id
    };
    const response = await sendRuntimeMessage({ type: RUNTIME_MESSAGES.fill, request });
    if (response?.ok) onFilled({ requestId, ...(response.result || {}) });
    else onFilled({
      requestId,
      ok: false,
      code: response?.code || "EXTENSION_ERROR",
      error: response?.error || "The price field could not be filled."
    });
  }

  function onWindowMessage(event) {
    if (event.source !== root
      || event.data?.source !== PAGE_MESSAGES.source
      || event.data?.type !== PAGE_MESSAGES.staged) return;
    onStaged(event.data.detail);
  }

  function onStaged(staged) {
    if (!state.started) return;
    if (!staged || typeof staged !== "object" || !String(staged.stageId || "")) return;
    clearPending();
    state.staged = {
      stageId: String(staged.stageId),
      itemName: String(staged.itemName || "").trim().replace(/\s+/g, " "),
      quantity: positiveSafeInteger(staged.quantity),
      defaultPrice: String(staged.defaultPrice || "")
    };
    fillCurrentStage();
  }

  function onFilled(result) {
    if (!state.started || !state.pending || result?.requestId !== state.pending.requestId) return;
    clearPending();
  }

  function attachListeners() {
    root.addEventListener?.("message", onWindowMessage);
  }

  function detachListeners() {
    root.removeEventListener?.("message", onWindowMessage);
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!root.chrome?.runtime?.sendMessage) {
        reject(new Error("The guild-market background bridge is unavailable."));
        return;
      }
      root.chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = root.chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message));
        else resolve(response);
      });
    });
  }

  async function controlMain(action, settings = null) {
    return sendRuntimeMessage({ type: RUNTIME_MESSAGES.control, action, settings });
  }

  async function start(settings) {
    const normalized = normalizeSettings(settings);
    const href = root.location?.href || root.document?.location?.href || "";
    if (!normalized.enabled || !isGuildMarketUrl(href)) {
      await stop();
      return false;
    }
    state.lifecycleGeneration += 1;
    const generation = state.lifecycleGeneration;
    state.settings = normalized;
    clearPending();
    if (!state.started) {
      state.started = true;
      attachListeners();
    }
    removeLegacyUi();
    const response = await controlMain("start", normalized);
    if (!state.started || generation !== state.lifecycleGeneration) return false;
    if (!response?.ok) {
      await stop();
      throw new Error(response?.error || "The guild-market page bridge could not start.");
    }
    fillCurrentStage();
    return true;
  }

  async function update(settings) {
    const normalized = normalizeSettings(settings);
    if (!normalized.enabled) {
      await stop();
      return false;
    }
    if (!state.started) return start(normalized);
    state.lifecycleGeneration += 1;
    const generation = state.lifecycleGeneration;
    state.settings = normalized;
    clearPending();
    const response = await controlMain("update", normalized);
    if (!state.started || generation !== state.lifecycleGeneration) return false;
    if (!response?.ok) {
      await stop();
      throw new Error(response?.error || "The guild-market page bridge could not update.");
    }
    fillCurrentStage();
    return true;
  }

  async function stop() {
    const wasStarted = state.started;
    state.lifecycleGeneration += 1;
    state.started = false;
    detachListeners();
    clearPending();
    clearAllTimers();
    state.settings = null;
    state.staged = null;
    removeLegacyUi();
    if (wasStarted) {
      try {
        await controlMain("stop");
      } catch (_error) {
        // A tab reload also restores the native page function. Local teardown
        // must still complete if the service worker is temporarily unavailable.
      }
    }
    return true;
  }

  function getStatus() {
    return {
      started: state.started,
      hasPageUi: false,
      hasStagedItem: Boolean(state.staged),
      filling: Boolean(state.pending),
      validRuleCount: state.settings?.rules?.length || 0,
      ruleErrorCount: state.settings?.ruleErrors?.length || 0
    };
  }

  const controller = {
    version: CONTENT_VERSION,
    id: "guildMarket",
    events: PAGE_MESSAGES,
    runtimeMessages: RUNTIME_MESSAGES,
    defaultRules: DEFAULT_RULES,
    isGuildMarketUrl,
    normalizeItemName,
    positiveSafeInteger,
    validateRules,
    matchRule,
    calculateSuggestion,
    normalizeSettings,
    start,
    update,
    stop,
    getStatus
  };
  root.GladiatusGuildMarketController = controller;
  root.GladiatusFeatureControllers = root.GladiatusFeatureControllers || {};
  root.GladiatusFeatureControllers.guildMarket = controller;
})();
