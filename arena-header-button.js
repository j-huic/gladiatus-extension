(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;

  if (root.__GladiatusArenaHeaderButtonLoaded) {
    root.__GladiatusArenaHeaderButtonBoot?.();
    return;
  }
  root.__GladiatusArenaHeaderButtonLoaded = true;

  const BUTTON_CLASS = "glad-arena-header-button";
  // Each header rank value gets a button injected right after it, into the gap
  // before the cooldown bar. Placeholder for now — it does nothing.
  const SLOTS = [
    { rankId: "arenaPlace", kind: "single", label: "Arena" },
    { rankId: "grouparenaPlace", kind: "team", label: "Circus" }
  ];
  function isGladiatusGamePage() {
    try {
      const parsed = new URL(root.location?.href || "");
      return parsed.hostname.endsWith(".gladiatus.gameforge.com") && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function ensureButtons() {
    if (!isGladiatusGamePage()) return;
    for (const slot of SLOTS) {
      const rank = root.document?.getElementById?.(slot.rankId);
      if (!rank) continue;
      if (rankHasButton(rank)) continue;
      rank.after(createButton(slot));
    }
  }

  function rankHasButton(rank) {
    const next = rank.nextElementSibling;
    return Boolean(next && next.classList && next.classList.contains(BUTTON_CLASS));
  }

  function createButton(slot) {
    const button = root.document.createElement("span");
    button.className = BUTTON_CLASS;
    button.dataset.kind = slot.kind;
    button.textContent = "⚔";
    button.title = `Fight best ${slot.label} opponent`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      runFight(slot, button).catch(() => {});
    });
    return button;
  }

  async function runFight(slot, button) {
    const fightModule = root.GladiatusArenaFight;
    if (!fightModule || button.dataset.busy === "1") return;
    button.dataset.busy = "1";
    button.classList.remove("glad-arena-header-button-error");
    button.classList.add("glad-arena-header-button-busy");
    try {
      const target = await fightModule.loadBestTarget(slot.kind);
      if (!target) throw new Error(`No ${slot.label} scan yet — open the ${slot.label} page so it can scan opponents first.`);
      const outcome = await fightModule.fight(target);
      root.location.href = outcome.reportUrl || outcome.reportsUrl;
    } catch (error) {
      showButtonError(slot, button, error.message || String(error));
    } finally {
      button.dataset.busy = "";
      button.classList.remove("glad-arena-header-button-busy");
    }
  }

  function showButtonError(slot, button, message) {
    button.title = message;
    button.classList.add("glad-arena-header-button-error");
    root.clearTimeout(button.__gladErrorTimer);
    button.__gladErrorTimer = root.setTimeout(() => {
      button.classList.remove("glad-arena-header-button-error");
      button.title = `Fight best ${slot.label} opponent`;
    }, 4000);
  }

  function buttonsIntact() {
    return SLOTS.every((slot) => {
      const rank = root.document?.getElementById?.(slot.rankId);
      return !rank || rankHasButton(rank);
    });
  }

  function observeHeader() {
    if (!root.MutationObserver || !root.document?.documentElement || root.__GladiatusArenaHeaderButtonObserver) return;
    root.__GladiatusArenaHeaderButtonObserver = new root.MutationObserver(() => {
      if (!buttonsIntact()) ensureButtons();
    });
    root.__GladiatusArenaHeaderButtonObserver.observe(root.document.documentElement, { childList: true, subtree: true });
  }

  function boot() {
    if (!isGladiatusGamePage()) return;
    ensureButtons();
    observeHeader();
  }
  root.__GladiatusArenaHeaderButtonBoot = boot;

  if (root.document?.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
