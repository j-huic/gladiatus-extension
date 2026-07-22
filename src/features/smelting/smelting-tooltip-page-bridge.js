// MAIN-world bridge for native Gladiatus tooltip enrichment. This is the only
// smelting module that touches the game's jQuery tooltip cache.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "smelting-tooltip-page-bridge-v3";
  const MODEL = root.GladiatusSmeltingTooltipModel;
  const pageDocument = root.document || null;
  const ITEM_SELECTOR = "[data-tooltip][class*='item-i-']";
  const ENRICHED_ATTRIBUTE = "data-glad-smelting-tooltip-version";
  const MATERIAL_COLORS_ATTRIBUTE = "data-glad-smelting-material-colors";
  const CONTROL_EVENTS = Object.freeze({
    start: "glad-smelting-tooltip-start-v1",
    refresh: "glad-smelting-tooltip-refresh-v1",
    stop: "glad-smelting-tooltip-stop-v1"
  });

  if (!MODEL) throw new Error("GladiatusSmeltingTooltipModel must load before the smelting tooltip page bridge.");
  if (root.GladiatusSmeltingTooltipPageBridge?.version === VERSION) return;

  const originals = new Map();
  let observer = null;
  let active = false;

  function jqueryFor(element) {
    return typeof root.jQuery === "function" ? root.jQuery(element) : null;
  }

  function tooltipCacheFor(element) {
    const jquery = jqueryFor(element);
    return jquery?.data ? jquery.data("tooltip") : undefined;
  }

  function setTooltipCache(element, payload) {
    const jquery = jqueryFor(element);
    if (jquery?.data) jquery.data("tooltip", payload);
  }

  function rememberOriginal(element) {
    if (originals.has(element)) return;
    originals.set(element, {
      attribute: element.getAttribute("data-tooltip"),
      cache: tooltipCacheFor(element)
    });
  }

  function materialColors() {
    const rawColors = pageDocument?.documentElement?.getAttribute?.(MATERIAL_COLORS_ATTRIBUTE);
    if (!rawColors) return {};
    try {
      const parsed = JSON.parse(rawColors);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function enrichElement(element) {
    if (!element?.matches?.(ITEM_SELECTOR) || element.getAttribute(ENRICHED_ATTRIBUTE) === VERSION) return false;
    const cache = tooltipCacheFor(element);
    const enriched = MODEL.appendMaterials(cache || element.getAttribute("data-tooltip"), { materialColors: materialColors() });
    if (!enriched.changed) return false;

    rememberOriginal(element);
    element.setAttribute("data-tooltip", JSON.stringify(enriched.payload));
    setTooltipCache(element, enriched.payload);
    element.setAttribute(ENRICHED_ATTRIBUTE, VERSION);
    return true;
  }

  function scan(node = pageDocument) {
    if (!node?.querySelectorAll) return 0;
    let count = node.matches?.(ITEM_SELECTOR) && enrichElement(node) ? 1 : 0;
    for (const element of node.querySelectorAll(ITEM_SELECTOR)) {
      if (enrichElement(element)) count += 1;
    }
    return count;
  }

  function restoreAll() {
    for (const [element, original] of originals.entries()) {
      if (!element?.isConnected && "isConnected" in element) continue;
      if (original.attribute == null) element.removeAttribute("data-tooltip");
      else element.setAttribute("data-tooltip", original.attribute);
      const jquery = jqueryFor(element);
      if (original.cache === undefined) jquery?.removeData?.("tooltip");
      else setTooltipCache(element, original.cache);
      element.removeAttribute(ENRICHED_ATTRIBUTE);
    }
    originals.clear();
  }

  function start() {
    if (active) return scan();
    active = true;
    const count = scan();
    if (typeof root.MutationObserver === "function" && pageDocument?.documentElement) {
      observer = new root.MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes || []) scan(node);
        }
      });
      observer.observe(pageDocument.documentElement, { childList: true, subtree: true });
    }
    return count;
  }

  function refresh() {
    if (!active) return 0;
    restoreAll();
    return scan();
  }

  function stop() {
    active = false;
    observer?.disconnect();
    observer = null;
    restoreAll();
  }

  root.addEventListener?.(CONTROL_EVENTS.start, start);
  root.addEventListener?.(CONTROL_EVENTS.refresh, () => {
    refresh();
  });
  root.addEventListener?.(CONTROL_EVENTS.stop, stop);

  root.GladiatusSmeltingTooltipPageBridge = Object.freeze({
    version: VERSION,
    start,
    stop,
    refresh,
    scan,
    getStatus() {
      return { active, enrichedItems: originals.size };
    }
  });
})();
