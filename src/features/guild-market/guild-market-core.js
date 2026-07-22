// Guild-market MAIN-world bridge.
//
// The game's marketDrop/calcDues functions only exist in the page world. This
// module deliberately does nothing to them when it is loaded. The isolated
// guild-market controller starts the bridge when the feature is enabled, reads
// the staged-item event, and sends one immediate price-fill request for a
// matching rule. No code here submits the sell form. A short, bounded guard
// restores an automatic price only when another script overwrites it.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const CORE_VERSION = "guild-market-core-v12";
  const SELLID_SELECTOR = "#sellForm [name=\"sellid\"]";
  const PRICE_FIELD_ID = "preis";
  const DURATION_FIELD_ID = "dauer";
  const DURATION_24H_VALUE = "3";
  const INSTALL_RETRY_MS = 100;
  const INSTALL_MAX_ATTEMPTS = 20;
  const PRICE_GUARD_INTERVAL_MS = 50;
  const PRICE_GUARD_DURATION_MS = 1500;
  const EVENTS = Object.freeze({
    source: "glad-helper:guild-market-main",
    staged: "staged"
  });

  const previous = root.GladiatusGuildMarket;
  if (previous?.version === CORE_VERSION) return;

  // Recover cleanly when an unpacked extension is reloaded over the old
  // auto-pricing implementation on an already-open game page.
  try {
    previous?.stop?.();
  } catch (_error) {
    // A stale helper must not prevent the safe bridge from loading.
  }
  if (root.marketDrop?.__gladiatusAutoPrice && typeof root.marketDrop.__original === "function") {
    root.marketDrop = root.marketDrop.__original;
  }
  if (root.__GladiatusGuildMarketControlBridge && root.document?.removeEventListener) {
    root.document.removeEventListener(
      "glad-helper:guild-market:control",
      root.__GladiatusGuildMarketControlBridge
    );
    delete root.__GladiatusGuildMarketControlBridge;
  }
  const state = {
    started: false,
    wrapper: null,
    original: null,
    retryTimer: null,
    retryAttempts: 0,
    stageSequence: 0,
    staged: null,
    priceGuard: null
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

  function decodeTooltipText(value, context = root) {
    const text = String(value ?? "").replace(/<[^>]*>/g, "").trim();
    const doc = context.document || root.document;
    if (!text || !doc?.createElement) return text;
    const textarea = doc.createElement("textarea");
    textarea.innerHTML = text;
    return String(textarea.value || textarea.textContent || text).trim();
  }

  function parseTooltipLinesFromValue(raw, context = root) {
    if (!raw) return [];

    const sharedParser = context.GladiatusTooltipParser?.parseTooltipLinesFromValue
      || context.GladiatusTooltipParser?.parseLinesFromValue;
    if (typeof sharedParser === "function") {
      try {
        return sharedParser(raw, context.document || root.document);
      } catch (_error) {
        // Fall through to the small local decoder so this feature stays isolated.
      }
    }

    try {
      const tooltip = JSON.parse(String(raw));
      const entries = Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
      return entries
        .map((entry) => decodeTooltipText(Array.isArray(entry) ? entry[0] : entry, context))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function tooltipLines(element, context = root) {
    const raw = element?.dataset?.tooltip || element?.getAttribute?.("data-tooltip") || "";
    return parseTooltipLinesFromValue(raw, context);
  }

  function findTooltipElement(candidate) {
    if (!candidate) return null;
    if (candidate.dataset?.tooltip || candidate.getAttribute?.("data-tooltip")) return candidate;
    return candidate.querySelector?.("[data-tooltip]") || null;
  }

  function readItemName(to, context = root) {
    const doc = context.document || root.document;
    const candidates = [to, to?.[0], to?.element, doc?.querySelector?.("#sellForm")];
    for (const candidate of candidates) {
      const lines = tooltipLines(findTooltipElement(candidate), context);
      if (lines.length) return lines[0];
    }
    return "";
  }

  function positiveSafeInteger(value) {
    const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }

  function readSellId(context = root) {
    const doc = context.document || root.document;
    return String(doc?.querySelector?.(SELLID_SELECTOR)?.value || "");
  }

  function readPrice(context = root) {
    const doc = context.document || root.document;
    return String(doc?.getElementById?.(PRICE_FIELD_ID)?.value || "");
  }

  function captureStagedItem(to, amount, context = root) {
    const quantity = positiveSafeInteger(amount);
    state.stageSequence += 1;
    state.staged = {
      stageId: `stage-${state.stageSequence}`,
      itemName: readItemName(to, context),
      quantity,
      sellId: readSellId(context),
      defaultPrice: readPrice(context)
    };
    return { ...state.staged };
  }

  function emitStagedItem(to, amount, context = root) {
    if (!state.started) return null;
    const staged = captureStagedItem(to, amount, context);
    context.postMessage?.({ source: EVENTS.source, type: EVENTS.staged, detail: staged }, "*");
    return staged;
  }

  function validateFillRequest(request, context = root) {
    if (!state.started) return { ok: false, code: "FEATURE_DISABLED", error: "Guild-market pricing is disabled." };
    if (!request || typeof request !== "object") {
      return { ok: false, code: "INVALID_REQUEST", error: "The price-fill request is invalid." };
    }
    if (!state.staged || request.stageId !== state.staged.stageId) {
      return { ok: false, code: "STALE_ITEM", error: "The staged market item changed. Stage it again before filling a price." };
    }

    const quantity = positiveSafeInteger(request.quantity);
    const unitPrice = positiveSafeInteger(request.unitPrice);
    const price = positiveSafeInteger(request.price);
    if (quantity === null || unitPrice === null || price === null) {
      return { ok: false, code: "INVALID_PRICE", error: "The quantity and price must be positive whole numbers." };
    }
    const expectedPrice = quantity * unitPrice;
    if (!Number.isSafeInteger(expectedPrice) || expectedPrice !== price) {
      return { ok: false, code: "INVALID_PRICE", error: "The proposed total does not match the unit-price calculation." };
    }

    const normalizedExpectedName = String(request.itemName || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const normalizedStagedName = String(state.staged.itemName || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    if (!normalizedExpectedName || normalizedExpectedName !== normalizedStagedName || quantity !== state.staged.quantity) {
      return { ok: false, code: "STALE_ITEM", error: "The staged market item no longer matches this automatic price." };
    }

    const currentSellId = readSellId(context);
    if (currentSellId !== state.staged.sellId) {
      return { ok: false, code: "STALE_ITEM", error: "The staged market item changed. Stage it again before filling a price." };
    }
    const field = (context.document || root.document)?.getElementById?.(PRICE_FIELD_ID);
    if (!field) return { ok: false, code: "PRICE_FIELD_MISSING", error: "The guild-market price field was not found." };
    return { ok: true, field, price };
  }

  function fillPriceField(request, context = root) {
    const validation = validateFillRequest(request, context);
    if (!validation.ok) return validation;
    validation.field.value = String(validation.price);
    setDuration24Hours(context);
    startPriceGuard({
      price: validation.price,
      sellId: state.staged.sellId
    }, context);
    refreshDues(context);
    return { ok: true, price: validation.price, stageId: state.staged.stageId };
  }

  function setDuration24Hours(context = root) {
    const doc = context.document || root.document;
    const field = doc?.getElementById?.(DURATION_FIELD_ID);
    if (!field) return false;
    const has24HourOption = Array.from(field.options || [])
      .some((option) => String(option?.value ?? "") === DURATION_24H_VALUE);
    if (!has24HourOption) return false;
    field.value = DURATION_24H_VALUE;
    return field.value === DURATION_24H_VALUE;
  }

  function refreshDues(context = root) {
    if (typeof context.calcDues !== "function") return false;
    try {
      context.calcDues();
      return true;
    } catch (_error) {
      // The bounded price guard must survive a broken third-party calcDues
      // wrapper. Fee refresh can safely be retried on the next reassertion.
      return false;
    }
  }

  function clearPriceGuard(context = root) {
    const guard = state.priceGuard;
    if (!guard) return;
    if (guard.timer != null) context.clearInterval?.(guard.timer);
    state.priceGuard = null;
  }

  function reassertGuardedPrice(guard, context = root) {
    if (!state.started) {
      clearPriceGuard(context);
      return;
    }

    const currentSellId = readSellId(context);
    if (guard.sellId && !currentSellId) return;
    if (currentSellId && currentSellId !== guard.sellId) {
      clearPriceGuard(context);
      return;
    }

    const doc = context.document || root.document;
    const field = doc?.getElementById?.(PRICE_FIELD_ID);
    if (!field) return;
    if (doc.activeElement === field || field.value === String(guard.price)) return;
    field.value = String(guard.price);
    refreshDues(context);
  }

  function startPriceGuard(details, context = root) {
    clearPriceGuard(context);
    if (typeof context.setInterval !== "function") return;

    let checks = 0;
    const guard = {
      ...details,
      timer: null
    };
    guard.timer = context.setInterval(() => {
      checks += 1;
      reassertGuardedPrice(guard, context);
      if (checks >= PRICE_GUARD_DURATION_MS / PRICE_GUARD_INTERVAL_MS) clearPriceGuard(context);
    }, PRICE_GUARD_INTERVAL_MS);
    state.priceGuard = guard;
  }

  function clearInstallRetry(context = root) {
    if (state.retryTimer != null && typeof context.clearInterval === "function") {
      context.clearInterval(state.retryTimer);
    }
    state.retryTimer = null;
    state.retryAttempts = 0;
  }

  function install(context = root) {
    if (!state.started) return false;
    if (state.wrapper && context.marketDrop === state.wrapper) return true;
    if (typeof context.marketDrop !== "function") return false;

    const original = context.marketDrop;
    function marketDrop(to, amount) {
      const result = original.apply(this, arguments);
      if (state.started) emitStagedItem(to, amount, context);
      return result;
    }
    marketDrop.__gladiatusGuildMarketBridge = true;
    marketDrop.__gladiatusGuildMarketOwner = CORE_VERSION;
    marketDrop.__original = original;
    state.original = original;
    state.wrapper = marketDrop;
    context.marketDrop = marketDrop;
    clearInstallRetry(context);
    return true;
  }

  function scheduleInstallRetry(context = root) {
    if (!state.started || state.retryTimer != null || typeof context.setInterval !== "function") return;
    state.retryTimer = context.setInterval(() => {
      if (!state.started || install(context)) return;
      state.retryAttempts += 1;
      if (state.retryAttempts >= INSTALL_MAX_ATTEMPTS) clearInstallRetry(context);
    }, INSTALL_RETRY_MS);
  }

  function start(_settings, context = root) {
    const href = context.location?.href || context.document?.location?.href || "";
    if (!isGuildMarketUrl(href)) return false;
    state.started = true;
    if (!install(context)) scheduleInstallRetry(context);
    return true;
  }

  function update(settings, context = root) {
    if (settings?.enabled === false) {
      stop(context);
      return false;
    }
    return start(settings, context);
  }

  function stop(context = root) {
    state.started = false;
    clearInstallRetry(context);
    clearPriceGuard(context);
    if (state.wrapper && context.marketDrop === state.wrapper && typeof state.original === "function") {
      context.marketDrop = state.original;
    }
    state.wrapper = null;
    state.original = null;
    state.staged = null;
    return true;
  }

  function getStatus(context = root) {
    return {
      started: state.started,
      installed: Boolean(state.wrapper && context.marketDrop === state.wrapper),
      waitingForMarketDrop: Boolean(state.retryTimer != null),
      hasStagedItem: Boolean(state.staged),
      guardingPrice: Boolean(state.priceGuard)
    };
  }

  const api = {
    version: CORE_VERSION,
    events: EVENTS,
    isGuildMarketUrl,
    parseTooltipLinesFromValue,
    tooltipLines,
    readItemName,
    positiveSafeInteger,
    captureStagedItem,
    emitStagedItem,
    validateFillRequest,
    fillPriceField,
    setDuration24Hours,
    install,
    start,
    update,
    stop,
    getStatus
  };
  root.GladiatusGuildMarket = api;
})();
