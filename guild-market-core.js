// Guild market auto-pricing.
//
// On the guild market page (index.php?mod=guildMarket) the game prices a freshly
// placed sell item via window.marketDrop(to, amount): it sets the hidden sellid,
// fills #preis from the item's average/gold price, then recomputes fees through
// calcDues(). We wrap marketDrop so that Mini-Pumpkin is priced at 100,000 gold
// per unit in its stack. Every other item keeps the game default.
//
// This runs in the MAIN world (see manifest content_scripts) so it can see the
// page's marketDrop / calcDues globals directly. The drop machinery dispatches by
// reading data-request-function="marketDrop" and calling it by name, so replacing
// window.marketDrop is picked up even after the sell cell re-renders.
//
// Some other guild helper extensions also write #preis, but ~100ms AFTER the drop,
// clobbering our value. So after applying our price we run a short re-assert guard:
// for GUARD_DURATION_MS we keep restoring our price whenever something else changes
// it, as long as the same item is still staged and the user is not editing the
// field. This wins the race regardless of the other extension's exact timing.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const CORE_VERSION = "guild-market-core-v2";
  const TARGET_ITEM_NAME = "Mini-Pumpkin";
  const RATE_PER_ITEM = 100000;
  const GUARD_DURATION_MS = 1500;
  const GUARD_INTERVAL_MS = 50;
  const SELLID_SELECTOR = "#sellForm [name=\"sellid\"]";

  function isGuildMarketUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "guildMarket";
    } catch {
      return false;
    }
  }

  function tooltipLines(element, context = root) {
    const raw = element?.dataset?.tooltip || element?.getAttribute?.("data-tooltip") || "";
    if (!raw) return [];

    const parser = context.GladiatusAuctionCore?.parseTooltipLinesFromValue;
    if (typeof parser === "function") return parser(raw, context.document || root.document);

    try {
      const tooltip = JSON.parse(raw);
      const entries = Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
      return entries
        .map((entry) => String(Array.isArray(entry) ? entry[0] : entry).replace(/<[^>]*>/g, "").trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  // `to` is the game's drop target. After marketDrop has run it contains the
  // staged item; checking #sellForm also covers markup variants where it does not.
  function isTargetItem(to, context = root) {
    const doc = context.document || root.document;
    const candidates = [to, to?.[0], to?.element, doc?.querySelector?.("#sellForm")];

    return candidates.some((candidate) => {
      if (!candidate) return false;
      const icon = candidate.dataset?.tooltip || candidate.getAttribute?.("data-tooltip")
        ? candidate
        : candidate.querySelector?.("[data-tooltip]");
      return tooltipLines(icon, context).some((line) => line === TARGET_ITEM_NAME);
    });
  }

  // Overwrite #preis with the Mini-Pumpkin stack price and refresh the fee display.
  // Returns the applied price, or null when the game default should stand.
  function applyAutoPrice(to, amount, context = root) {
    if (!isTargetItem(to, context)) return null;
    const quantity = Number(amount);
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    const price = Math.floor(quantity) * RATE_PER_ITEM;
    const doc = context.document || root.document;
    const field = doc?.getElementById("preis");
    if (!field) return null;
    field.value = String(price);
    if (typeof context.calcDues === "function") context.calcDues();
    return price;
  }

  // Restore our price if something else changed #preis. Does nothing when the
  // value is already ours, the user is editing the field, or a different item
  // (or none) is now staged. Returns true when it re-applied the price.
  function reassertIfClobbered(target, expectedSellid, context = root) {
    const doc = context.document || root.document;
    const field = doc?.getElementById?.("preis");
    if (!field) return false;
    if (doc.activeElement === field) return false;             // user is typing — don't fight
    const sellEl = doc.querySelector?.(SELLID_SELECTOR);
    if (expectedSellid != null && sellEl && sellEl.value !== expectedSellid) return false;
    if (field.value === String(target)) return false;          // already correct
    field.value = String(target);
    if (typeof context.calcDues === "function") context.calcDues();
    return true;
  }

  // Keep our price in place for a short window after the drop, defeating a late
  // overwrite by another extension. Re-arms (replaces) any prior guard.
  function guardPrice(target, context = root) {
    if (typeof context.setInterval !== "function") return;
    const doc = context.document || root.document;
    const sellEl = doc?.querySelector?.(SELLID_SELECTOR);
    const expectedSellid = sellEl ? sellEl.value : null;
    if (context.__gmGuardTimer != null && typeof context.clearInterval === "function") {
      context.clearInterval(context.__gmGuardTimer);
    }
    let elapsed = 0;
    context.__gmGuardTimer = context.setInterval(() => {
      elapsed += GUARD_INTERVAL_MS;
      reassertIfClobbered(target, expectedSellid, context);
      if (elapsed >= GUARD_DURATION_MS && typeof context.clearInterval === "function") {
        context.clearInterval(context.__gmGuardTimer);
        context.__gmGuardTimer = null;
      }
    }, GUARD_INTERVAL_MS);
  }

  // Replace context.marketDrop with a wrapper that applies the Mini-Pumpkin stack price
  // after the game's own pricing, then guards it. Idempotent; returns true once a
  // wrapper is in place (or marketDrop is not defined yet).
  function install(context = root) {
    const original = context.marketDrop;
    if (typeof original !== "function") return false;
    if (original.__gladiatusAutoPrice) return true;

    function marketDrop(to, amount) {
      const result = original.apply(this, arguments);
      const price = applyAutoPrice(to, amount, context);
      if (price !== null) guardPrice(price, context);
      return result;
    }
    marketDrop.__gladiatusAutoPrice = true;
    marketDrop.__original = original;
    context.marketDrop = marketDrop;
    return true;
  }

  if (root.GladiatusGuildMarket?.version === CORE_VERSION) {
    root.GladiatusGuildMarket.install();
    return;
  }

  root.GladiatusGuildMarket = {
    version: CORE_VERSION,
    targetItemName: TARGET_ITEM_NAME,
    ratePerItem: RATE_PER_ITEM,
    guardDurationMs: GUARD_DURATION_MS,
    guardIntervalMs: GUARD_INTERVAL_MS,
    isGuildMarketUrl,
    tooltipLines,
    isTargetItem,
    applyAutoPrice,
    reassertIfClobbered,
    guardPrice,
    install
  };

  if (isGuildMarketUrl(root.location?.href || root.document?.location?.href || "")) {
    // marketDrop is defined inline by the page and is normally ready by the time
    // this content script runs at document_idle; retry briefly to cover ordering.
    if (!install() && typeof root.setInterval === "function") {
      let tries = 0;
      const timer = root.setInterval(() => {
        tries += 1;
        if (install() || tries >= 20) root.clearInterval(timer);
      }, 100);
    }
  }
})();
