// Read-only native-tooltip enrichment for smelting materials. This controller
// changes only client-side tooltip data and never performs a game action.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "smelting-tooltip-content-v1";
  const MODEL = root.GladiatusSmeltingTooltipModel;
  const pageDocument = root.document || null;

  if (!MODEL) throw new Error("GladiatusSmeltingTooltipModel must load before the smelting tooltip controller.");
  if (root.GladiatusSmeltingTooltipFeature?.version === VERSION) return;

  const ITEM_SELECTOR = "[data-tooltip][class*='item-i-']";
  const ENRICHED_ATTRIBUTE = "data-glad-smelting-tooltip-version";
  const originals = new Map();
  let observer = null;
  let active = false;

  function jqueryFor(element) {
    const jquery = root.jQuery || root.$;
    return typeof jquery === "function" ? jquery(element) : null;
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
    const attribute = element.getAttribute("data-tooltip");
    originals.set(element, {
      attribute,
      cache: tooltipCacheFor(element) || MODEL.parsePayload(attribute)
    });
  }

  function enrichElement(element) {
    if (!element?.matches?.(ITEM_SELECTOR) || element.getAttribute(ENRICHED_ATTRIBUTE) === VERSION) return false;
    const sourceTooltip = tooltipCacheFor(element) || element.getAttribute("data-tooltip");
    const enriched = MODEL.appendMaterials(sourceTooltip);
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
      setTooltipCache(element, original.cache);
      element.removeAttribute(ENRICHED_ATTRIBUTE);
    }
    originals.clear();
  }

  const controller = Object.freeze({
    version: VERSION,
    async start() {
      if (active) return this.update();
      active = true;
      scan();
      if (typeof root.MutationObserver === "function" && pageDocument?.documentElement) {
        observer = new root.MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes || []) scan(node);
          }
        });
        observer.observe(pageDocument.documentElement, { childList: true, subtree: true });
      }
    },
    async update() {
      if (active) scan();
    },
    async stop() {
      active = false;
      observer?.disconnect();
      observer = null;
      restoreAll();
    },
    getStatus() {
      return { active, enrichedItems: originals.size };
    }
  });

  root.GladiatusSmeltingTooltipFeature = controller;
  root.GladiatusFeatureControllers = root.GladiatusFeatureControllers || {};
  root.GladiatusFeatureControllers.smelting = controller;
})();
