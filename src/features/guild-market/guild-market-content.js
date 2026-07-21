// Isolated-world guild-market pricing controller.
//
// Pricing rules and UI live here. After the game stages a matching item, this
// controller immediately asks the page-world bridge to fill #preis. It never
// submits the Guild Market form or reasserts the value after user edits.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const CONTENT_VERSION = "guild-market-content-v3";
  const PANEL_ID = "glad-guild-market-suggestion";
  const STYLE_ID = "glad-guild-market-style";
  const STATUS_ID = "glad-guild-market-status";
  const FILL_TIMEOUT_MS = 1500;
  const PAGE_MESSAGES = Object.freeze({
    source: "glad-helper:guild-market-main",
    staged: "staged"
  });
  const RUNTIME_MESSAGES = Object.freeze({
    control: "GLAD_GUILD_MARKET_CONTROL",
    fill: "GLAD_GUILD_MARKET_FILL"
  });
  const DEFAULT_RULES = Object.freeze([{
    id: "mini-pumpkin",
    itemName: "Mini-Pumpkin",
    pricePerUnit: 100000,
    enabled: true
  }]);

  const previous = root.GladiatusGuildMarketController;
  if (previous?.version === CONTENT_VERSION) return;
  try {
    previous?.stop?.()?.catch?.(() => {});
  } catch (_error) {
    // A stale controller must not block the safe replacement.
  }

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
    return (Array.isArray(rules) ? rules : []).find((rule) => (
      rule?.enabled === true && normalizeItemName(rule.itemName) === normalizedName
    )) || null;
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
      rules: validation.rules,
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

  function ensureStyles() {
    const doc = root.document;
    if (!doc || doc.getElementById(STYLE_ID)) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID}.glad-guild-market-suggestion {
        box-sizing: border-box;
        margin: 8px 0;
        padding: 9px 10px;
        max-width: 430px;
        border: 1px solid #73552d;
        border-radius: 4px;
        background: #f4e8c8;
        color: #2f2416;
        font: 12px/1.4 Arial, sans-serif;
      }
      #${PANEL_ID} .glad-guild-market-title { font-weight: 700; margin-bottom: 4px; }
      #${PANEL_ID} .glad-guild-market-calculation { font-size: 13px; margin: 5px 0; }
      #${PANEL_ID} .glad-guild-market-note { color: #5e4c34; margin: 4px 0; }
      #${PANEL_ID} .glad-guild-market-status { min-height: 1.4em; margin-top: 4px; }
      #${PANEL_ID} .glad-guild-market-error { color: #8b1e16; }
    `;
    (doc.head || doc.documentElement)?.append?.(style);
  }

  function removeOwnedUi() {
    root.document?.getElementById?.(PANEL_ID)?.remove?.();
    root.document?.getElementById?.(STYLE_ID)?.remove?.();
  }

  function appendTextElement(parent, tagName, className, text) {
    const element = root.document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function ensurePanel() {
    const doc = root.document;
    if (!doc) return null;
    let panel = doc.getElementById(PANEL_ID);
    if (panel) return panel;
    const priceField = doc.getElementById("preis");
    const sellForm = doc.querySelector?.("#sellForm");
    if (!priceField && !sellForm) return null;

    panel = doc.createElement("section");
    panel.id = PANEL_ID;
    panel.className = "glad-guild-market-suggestion";
    panel.setAttribute("aria-label", "Guild Market automatic price helper");
    if (priceField?.parentNode) {
      priceField.parentNode.insertBefore(panel, priceField.nextSibling);
    } else {
      sellForm.append(panel);
    }
    return panel;
  }

  function formatGold(value) {
    try {
      return new Intl.NumberFormat().format(value);
    } catch {
      return String(value);
    }
  }

  function setStatus(text, error = false) {
    const status = root.document?.getElementById?.(STATUS_ID);
    if (!status) return;
    status.textContent = text;
    status.classList?.toggle?.("glad-guild-market-error", error);
  }

  function clearPending() {
    if (!state.pending) return;
    clearTimer(state.pending.timer);
    state.pending = null;
  }

  function render() {
    if (!state.started || !state.staged) {
      root.document?.getElementById?.(PANEL_ID)?.remove?.();
      return null;
    }
    ensureStyles();
    const panel = ensurePanel();
    if (!panel) return null;
    panel.replaceChildren();

    appendTextElement(panel, "div", "glad-guild-market-title", "Guild Market price helper");
    if (!state.staged.itemName) {
      appendTextElement(panel, "div", "glad-guild-market-error", "The staged item name could not be read.");
      return null;
    }

    const rule = matchRule(state.staged.itemName, state.settings.rules);
    if (!rule) {
      appendTextElement(panel, "div", "", `No enabled pricing rule matches “${state.staged.itemName}”.`);
      if (state.settings.ruleErrors.length) {
        appendTextElement(panel, "div", "glad-guild-market-error", state.settings.ruleErrors[0].error);
      }
      return null;
    }

    const suggestion = calculateSuggestion(state.staged, rule);
    if (!suggestion) {
      appendTextElement(panel, "div", "glad-guild-market-error", "This stack cannot be priced safely. Check its quantity and pricing rule.");
      return null;
    }

    appendTextElement(panel, "div", "", `${state.staged.itemName} matches “${rule.itemName}”.`);
    appendTextElement(
      panel,
      "div",
      "glad-guild-market-calculation",
      `${formatGold(suggestion.quantity)} × ${formatGold(suggestion.unitPrice)} = ${formatGold(suggestion.price)} gold`
    );
    appendTextElement(panel, "p", "glad-guild-market-note", "The price field is filled automatically. Review it before listing the item.");

    const status = appendTextElement(panel, "div", "glad-guild-market-status", "");
    status.id = STATUS_ID;
    status.setAttribute("aria-live", "polite");
    return { rule, suggestion };
  }

  function renderAndFill() {
    const candidate = render();
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
    setStatus("Filling price automatically…");

    state.requestSequence += 1;
    const requestId = `guild-price-${state.requestSequence}`;
    const timer = addTimer(() => {
      if (state.pending?.requestId !== requestId) return;
      state.pending = null;
      setStatus("The page did not accept the price. Stage the item again.", true);
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
    renderAndFill();
  }

  function onFilled(result) {
    if (!state.started || !state.pending || result?.requestId !== state.pending.requestId) return;
    clearPending();
    if (result.ok) setStatus(`Filled ${formatGold(result.price)} gold automatically. Review before listing.`);
    else setStatus(result.error || "The price field could not be filled.", true);
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
    ensureStyles();
    const response = await controlMain("start", normalized);
    if (!state.started || generation !== state.lifecycleGeneration) return false;
    if (!response?.ok) {
      await stop();
      throw new Error(response?.error || "The guild-market page bridge could not start.");
    }
    renderAndFill();
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
    renderAndFill();
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
    removeOwnedUi();
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
      hasSuggestion: Boolean(root.document?.getElementById?.(PANEL_ID)),
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
