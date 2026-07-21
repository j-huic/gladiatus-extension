// Lifecycle-owned Arena/Circus quick-fight controls for the private full build.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const VERSION = "arena-header-button-v2";
  const BUTTON_CLASS = "glad-arena-header-button";
  const SLOTS = Object.freeze([
    { rankId: "arenaPlace", kind: "single", label: "Arena" },
    { rankId: "grouparenaPlace", kind: "team", label: "Circus" }
  ]);

  if (root.GladiatusArenaHeaderButtonFeature?.version === VERSION) return;

  let active = false;
  let operationGeneration = 0;
  let observer = null;
  const errorTimers = new Set();

  function shouldRun(settings) {
    return Boolean(settings?.enabled && settings?.quickFight && isGladiatusGamePage());
  }

  function isGladiatusGamePage() {
    try {
      const parsed = new URL(root.location?.href || "");
      return parsed.protocol === "https:"
        && parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function ownedButton(kind) {
    return root.document?.querySelector?.(`.${BUTTON_CLASS}[data-kind="${kind}"]`) || null;
  }

  function ensureButtons() {
    if (!active || !root.GladiatusArenaFight) return;
    for (const slot of SLOTS) {
      const rank = root.document?.getElementById?.(slot.rankId);
      if (!rank || ownedButton(slot.kind)) continue;
      rank.after(createButton(slot));
    }
  }

  function createButton(slot) {
    const button = root.document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.dataset.kind = slot.kind;
    button.textContent = "⚔";
    button.title = `Fight best ${slot.label} opponent`;
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      runFight(slot, button).catch(() => {});
    });
    return button;
  }

  async function runFight(slot, button) {
    if (!active || button.dataset.busy === "1") return;
    const generation = operationGeneration;
    const fightModule = root.GladiatusArenaFight;
    if (!fightModule) return;

    button.dataset.busy = "1";
    button.disabled = true;
    button.classList.remove("glad-arena-header-button-error");
    button.classList.add("glad-arena-header-button-busy");
    try {
      const target = await fightModule.loadBestTarget(slot.kind);
      if (!active || generation !== operationGeneration) return;
      if (!target) throw new Error(`No ${slot.label} scan yet — open the ${slot.label} page so it can scan opponents first.`);
      const outcome = await fightModule.fight(target);
      if (!active || generation !== operationGeneration) return;
      const destination = outcome.reportUrl || outcome.reportsUrl;
      if (destination) root.location.href = destination;
    } catch (error) {
      if (active && generation === operationGeneration) showButtonError(slot, button, error.message || String(error));
    } finally {
      if (active && generation === operationGeneration) {
        button.dataset.busy = "";
        button.disabled = false;
        button.classList.remove("glad-arena-header-button-busy");
      }
    }
  }

  function showButtonError(slot, button, message) {
    button.title = message;
    button.setAttribute("aria-label", message);
    button.classList.add("glad-arena-header-button-error");
    const timer = root.setTimeout(() => {
      errorTimers.delete(timer);
      if (!active || !button.isConnected) return;
      button.classList.remove("glad-arena-header-button-error");
      button.title = `Fight best ${slot.label} opponent`;
      button.setAttribute("aria-label", button.title);
    }, 4000);
    errorTimers.add(timer);
  }

  function removeButtons() {
    for (const button of root.document?.querySelectorAll?.(`.${BUTTON_CLASS}`) || []) button.remove();
  }

  async function start(settings = {}) {
    if (!shouldRun(settings)) return stop();
    if (active) {
      ensureButtons();
      return;
    }
    active = true;
    operationGeneration += 1;
    ensureButtons();
    if (root.MutationObserver && root.document?.documentElement) {
      observer = new root.MutationObserver(ensureButtons);
      observer.observe(root.document.documentElement, { childList: true, subtree: true });
    }
  }

  async function update(settings = {}) {
    if (!shouldRun(settings)) return stop();
    if (!active) return start(settings);
    ensureButtons();
  }

  async function stop() {
    active = false;
    operationGeneration += 1;
    observer?.disconnect();
    observer = null;
    for (const timer of errorTimers) root.clearTimeout(timer);
    errorTimers.clear();
    removeButtons();
  }

  root.GladiatusArenaHeaderButtonFeature = Object.freeze({
    version: VERSION,
    start,
    update,
    stop,
    getStatus() {
      return {
        active,
        buttons: root.document?.querySelectorAll?.(`.${BUTTON_CLASS}`)?.length || 0,
        observing: Boolean(observer)
      };
    }
  });
})();
