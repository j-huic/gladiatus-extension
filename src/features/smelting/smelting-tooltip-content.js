// Isolated-world lifecycle controller. Tooltip mutation deliberately lives in
// the MAIN-world bridge because Gladiatus caches parsed tooltips in page jQuery.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "smelting-tooltip-content-v3";
  const MATERIAL_COLORS_ATTRIBUTE = "data-glad-smelting-material-colors";
  const CONTROL_EVENTS = Object.freeze({
    start: "glad-smelting-tooltip-start-v1",
    refresh: "glad-smelting-tooltip-refresh-v1",
    stop: "glad-smelting-tooltip-stop-v1"
  });

  if (root.GladiatusSmeltingTooltipFeature?.version === VERSION) return;

  let active = false;

  function send(action) {
    const eventName = CONTROL_EVENTS[action];
    if (!eventName || typeof root.dispatchEvent !== "function" || typeof root.Event !== "function") return;
    root.dispatchEvent(new root.Event(eventName));
  }

  function writeMaterialColors(settings) {
    const colors = settings?.materialColors && typeof settings.materialColors === "object"
      ? settings.materialColors
      : {};
    const html = root.document?.documentElement;
    if (typeof html?.setAttribute === "function") html.setAttribute(MATERIAL_COLORS_ATTRIBUTE, JSON.stringify(colors));
  }

  function clearMaterialColors() {
    const html = root.document?.documentElement;
    if (typeof html?.removeAttribute === "function") html.removeAttribute(MATERIAL_COLORS_ATTRIBUTE);
  }

  const controller = Object.freeze({
    version: VERSION,
    async start(settings = {}) {
      active = true;
      writeMaterialColors(settings);
      send("start");
    },
    async update(settings = {}) {
      if (!active) return;
      writeMaterialColors(settings);
      send("refresh");
    },
    async stop() {
      send("stop");
      clearMaterialColors();
      active = false;
    },
    getStatus() {
      return { active };
    }
  });

  root.GladiatusSmeltingTooltipFeature = controller;
  root.GladiatusFeatureControllers = root.GladiatusFeatureControllers || {};
  root.GladiatusFeatureControllers.smelting = controller;
})();
