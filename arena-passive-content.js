(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;
  const devLogger = root.GladiatusLog ? root.GladiatusLog.createLogger("arena-passive") : null;

  if (!ARENA || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  if (root.__GladiatusArenaPassiveContentLoaded) {
    root.__GladiatusArenaPassiveContentBoot?.();
    return;
  }
  root.__GladiatusArenaPassiveContentLoaded = true;

  const PASSIVE_BOOT_DELAY_MS = 1200;
  const PASSIVE_FORCE_DEBOUNCE_MS = 15 * 1000;
  const AFTER_FIGHT_CHECK_DELAY_MS = 1500;
  const FIGHT_CLICK_SCAN_DELAY_MS = 5 * 1000;
  let passiveBootTimer = 0;
  let lastForcedPassiveCheckAt = 0;
  let lastAfterFightSignal = "";
  let lastArenaKind = "";

  function isGladiatusGamePage(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function currentArenaKind() {
    return ARENA.isArenaPageUrl(root.location?.href || "") ? ARENA.arenaKindFromUrl(root.location.href) : "";
  }

  function preferredArenaKind() {
    const kind = currentArenaKind();
    if (kind) lastArenaKind = kind;
    return kind || arenaKindFromCombatReportUrl(root.location?.href || "") || lastArenaKind;
  }

  function bootPassiveContent() {
    if (!isGladiatusGamePage(root.location?.href || "")) return;
    preferredArenaKind();
    subscribePassiveTriggers();
    root.clearTimeout(passiveBootTimer);
    passiveBootTimer = root.setTimeout(() => {
      maybeTriggerAfterFightCheck();
    }, PASSIVE_BOOT_DELAY_MS);
  }
  root.__GladiatusArenaPassiveContentBoot = bootPassiveContent;

  function subscribePassiveTriggers() {
    if (root.__GladiatusArenaPassiveTriggers) return;
    root.__GladiatusArenaPassiveTriggers = true;

    root.addEventListener?.("focus", recoverAfterFightCheck);
    root.addEventListener?.("pageshow", recoverAfterFightCheck);

    root.document?.addEventListener?.("visibilitychange", () => {
      if (root.document.visibilityState && root.document.visibilityState !== "visible") return;
      recoverAfterFightCheck();
    });

    root.document?.addEventListener?.("click", handleFightTriggerClick, true);

    if (root.MutationObserver && root.document?.documentElement && !root.__GladiatusArenaAfterFightObserver) {
      root.__GladiatusArenaAfterFightObserver = new root.MutationObserver(() => {
        maybeTriggerAfterFightCheck();
      });
      root.__GladiatusArenaAfterFightObserver.observe(root.document.documentElement, { childList: true, subtree: true });
    }
  }

  function recoverAfterFightCheck() {
    maybeTriggerAfterFightCheck();
  }

  function maybeTriggerAfterFightCheck() {
    if (!looksLikeArenaAfterFightPage()) return;

    const signal = afterFightSignal();
    if (!signal || signal === lastAfterFightSignal) return;
    lastAfterFightSignal = signal;

    const preferredKind = preferredArenaKind();
    triggerPassiveCheck("after-fight", {
      delayMs: AFTER_FIGHT_CHECK_DELAY_MS,
      force: true,
      bypassDebounce: true,
      preferredKind,
      onlyPreferred: Boolean(preferredKind)
    }).catch((error) => {
      if (devLogger) devLogger.warn("after-fight arena scan trigger failed", { error: String(error?.message || error) });
      else console.warn("After-fight arena scan trigger failed.", error);
    });
  }

  function looksLikeArenaAfterFightPage() {
    if (!isGladiatusGamePage(root.location?.href || "")) return false;
    const text = arenaContentText();
    if (isCombatReportUrl(root.location?.href || "")) {
      return /\b(Battle Report|Reward|Statistics)\b/i.test(text);
    }

    return ARENA.isArenaPageUrl(root.location?.href || "")
      && !ARENA.readArenaOpponentEntries(root.document, root.location.href).length
      && /\b(report|battle|fight|round|winner|victory|defeat|loot|honou?r|experience|gold)\b/i.test(text);
  }

  function isCombatReportUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/")
        && parsed.searchParams.get("mod") === "reports"
        && (parsed.searchParams.get("submod") === "showCombatReport" || parsed.searchParams.has("reportId"));
    } catch {
      return false;
    }
  }

  function afterFightSignal() {
    return `${root.location?.href || ""}|${arenaContentText().slice(0, 240)}`;
  }

  function arenaContentText() {
    const content = root.document?.querySelector?.("#content") || root.document?.body;
    return String(content?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function handleFightTriggerClick(event) {
    const trigger = event.target?.closest?.(".attack[onclick], [onclick*='startFight'], [onclick*='startGroupFight'], [onclick*='startProvinciarumFight']");
    if (!trigger || !root.document?.contains?.(trigger)) return;

    const kind = arenaKindFromFightTrigger(trigger);
    if (kind) lastArenaKind = kind;
    scheduleFightClickCheck(kind);
  }

  function arenaKindFromFightTrigger(trigger) {
    const onclick = trigger?.getAttribute?.("onclick") || "";
    const parsed = ARENA.parseFightArgs(onclick);
    return parsed.arenaKind || currentArenaKind() || arenaKindFromCombatReportUrl(root.location?.href || "") || lastArenaKind;
  }

  function arenaKindFromCombatReportUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("mod") !== "reports") return "";
      const reportType = parsed.searchParams.get("t");
      if (reportType === "3") return "team";
      if (reportType === "2") return "single";
    } catch {
      return "";
    }
    return "";
  }

  function scheduleFightClickCheck(kind = "") {
    const preferredKind = kind || preferredArenaKind();
    triggerPassiveCheck("fight-click", {
      delayMs: FIGHT_CLICK_SCAN_DELAY_MS,
      force: true,
      bypassDebounce: true,
      preferredKind,
      onlyPreferred: Boolean(preferredKind)
    }).catch((error) => {
      if (devLogger) devLogger.warn("fight-click arena scan trigger failed", { error: String(error?.message || error) });
      else console.warn("Fight-click arena scan trigger failed.", error);
    });
  }

  function triggerPassiveCheck(_reason, options = {}) {
    const force = Boolean(options.force);
    const now = Date.now();
    if (force && !options.bypassDebounce && now - lastForcedPassiveCheckAt < PASSIVE_FORCE_DEBOUNCE_MS) {
      return Promise.resolve([]);
    }
    if (force) lastForcedPassiveCheckAt = now;

    return sendRuntimeMessage({
      type: "GLAD_ARENA_PASSIVE_CHECK",
      url: root.location?.href || "",
      preferredKind: options.preferredKind || preferredArenaKind(),
      force,
      onlyPreferred: Boolean(options.onlyPreferred),
      delayMs: ARENA.parseInteger(options.delayMs),
      reason: _reason
    }).then((response) => {
      if (!response?.ok) throw new Error(response?.error || "Could not run passive arena check.");
      return response.results || [];
    });
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  if (root.document?.readyState === "loading") {
    root.document.addEventListener("DOMContentLoaded", bootPassiveContent, { once: true });
  } else {
    bootPassiveContent();
  }
})();
