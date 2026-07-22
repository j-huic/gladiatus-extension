// Isolated-world lifecycle controller. Tooltip mutation deliberately lives in
// the MAIN-world bridge because Gladiatus caches parsed tooltips in page jQuery.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "smelting-tooltip-content-v2";
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

  const controller = Object.freeze({
    version: VERSION,
    async start() {
      active = true;
      send("start");
    },
    async update() {
      if (active) send("refresh");
    },
    async stop() {
      active = false;
      send("stop");
    },
    getStatus() {
      return { active };
    }
  });

  root.GladiatusSmeltingTooltipFeature = controller;
  root.GladiatusFeatureControllers = root.GladiatusFeatureControllers || {};
  root.GladiatusFeatureControllers.smelting = controller;
})();
