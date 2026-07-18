(() => {
  const CONTENT_VERSION = "arena-content-v3";
  const MESSAGE_TYPES = {
    scanOpponents: "GLAD_ARENA_SCAN_OPPONENTS",
    boot: "GLAD_ARENA_BOOT_V2",
    status: "GLAD_ARENA_CONTENT_STATUS_V2",
    refreshSelfProfile: "GLAD_ARENA_REFRESH_SELF_PROFILE"
  };
  const ARENA = window.GladiatusArenaCore;
  const SCANNER = window.GladiatusArenaScanner;
  const devLogger = window.GladiatusLog ? window.GladiatusLog.createLogger("arena-content") : null;

  if (window.GladiatusArenaFeature?.version === CONTENT_VERSION
    && window.GladiatusArenaFeature?.ready !== false) return;

  if (!ARENA || !SCANNER) {
    let active = false;
    window.GladiatusArenaFeature = {
      version: CONTENT_VERSION,
      ready: false,
      async start(settings = {}) {
        if (!shouldRunArenaController(settings)) return this.stop();
        active = true;
        registerMissingArenaDependencyDiagnostic();
      },
      async update(settings = {}) {
        if (shouldRunArenaController(settings)) return this.start(settings);
        return this.stop();
      },
      async stop() {
        active = false;
        const listener = window.__GladiatusArenaMissingDependencyListener;
        if (listener && typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
          chrome.runtime.onMessage.removeListener(listener);
        }
        delete window.__GladiatusArenaMissingDependencyListener;
      },
      getStatus() { return { active, ready: false }; }
    };
    return;
  }

  if (window.__GladiatusArenaMissingDependencyListener && typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.removeListener?.(window.__GladiatusArenaMissingDependencyListener);
    delete window.__GladiatusArenaMissingDependencyListener;
  }

  function shouldRunArenaController(settings) {
    return Boolean(settings?.enabled
      && (settings?.annotations || settings?.manualScan)
      && isCurrentArenaPage());
  }

  function isCurrentArenaPage() {
    try {
      const parsed = new URL(window.location.href);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "arena";
    } catch {
      return false;
    }
  }

  window.__GladiatusArenaContentBootstrapped = true;

  const PANEL_ID = "glad-arena-scanner";
  const BADGE_CLASS = "glad-arena-score";
  const BEST_CLASS = "glad-arena-best";
  const VISIBLE_SCAN_RETRY_DELAY_MS = 1200;
  const VISIBLE_SCAN_MAX_RETRIES = 3;
  const ARENA_UI_STATE_KEY = ARENA.uiStateStorageKey || "glad-arena-ui-state-v1";
  const LEGACY_POPUP_STATE_KEY = window.GladiatusAuctionSchema?.storageKeys?.popupState || "glad-ah-popup-state-v1";
  let arenaFormulas = [ARENA.defaultArenaFormula()];
  let selectedFormulaId = "";
  let bootTimer = 0;
  let annotationTimer = 0;
  let visibleRefreshRetryTimer = 0;
  let visibleRefreshInFlight = false;
  let lastObservedHref = window.location.href;
  let active = false;
  let activeSettings = null;
  let operationGeneration = 0;
  let initialized = false;

  function registerMissingArenaDependencyDiagnostic() {
    const error = "Arena content script dependency missing: arena-core.js or arena-scan.js. Reload the unpacked extension and refresh this arena tab.";
    if (devLogger) devLogger.error(error);
    else console.error(error);

    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage || window.__GladiatusArenaMissingDependencyListener) return;

    window.__GladiatusArenaMissingDependencyListener = (message, _sender, sendResponse) => {
      if (![MESSAGE_TYPES.scanOpponents, MESSAGE_TYPES.boot, MESSAGE_TYPES.status, MESSAGE_TYPES.refreshSelfProfile].includes(message?.type)) return false;
      sendResponse({ ok: false, error });
      return false;
    };
    chrome.runtime.onMessage.addListener(window.__GladiatusArenaMissingDependencyListener);
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (![MESSAGE_TYPES.scanOpponents, MESSAGE_TYPES.boot, MESSAGE_TYPES.status, MESSAGE_TYPES.refreshSelfProfile].includes(message?.type)) return false;
    if (!active) {
      sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Arena feature is disabled." });
      return false;
    }

    if (message?.type === MESSAGE_TYPES.boot) {
      boot();
      sendResponse(getArenaContentStatus());
      return false;
    }

    if (message?.type === MESSAGE_TYPES.status) {
      sendResponse(getArenaContentStatus());
      return false;
    }

    if (message?.type === MESSAGE_TYPES.refreshSelfProfile) {
      if (!activeSettings?.manualScan || !activeSettings?.simulations) {
        sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Arena simulations are disabled." });
        return false;
      }
      const generation = operationGeneration;
      SCANNER.refreshSelfProfile({ force: Boolean(message.force) })
        .then((record) => {
          if (!active || generation !== operationGeneration) {
            sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Arena feature is disabled." });
            return;
          }
          sendResponse({ ok: true, record });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (!activeSettings?.manualScan) {
      sendResponse({ ok: false, code: "FEATURE_DISABLED", error: "Manual arena scanning is disabled." });
      return false;
    }

    scanOpponents(message.formula)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  function getArenaContentStatus() {
    const isArenaPage = ARENA.isArenaPageUrl(window.location.href);
    const entries = isArenaPage ? ARENA.readArenaOpponentEntries(document, window.location.href) : [];
    return {
      ok: true,
      isArenaPage,
      hasPanel: Boolean(document.getElementById(PANEL_ID)),
      opponentRows: entries.length,
      hasBadges: Boolean(document.querySelector(`.${BADGE_CLASS}`))
    };
  }

  async function scanOpponents(rawFormula) {
    if (!active || !activeSettings?.manualScan) throw new Error("Manual arena scanning is disabled.");
    const generation = operationGeneration;
    if (!ARENA.isArenaPageUrl(window.location.href)) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    clearArenaBadges();
    const result = await SCANNER.scanCurrentPage(rawFormula, {
      force: true,
      simulations: activeSettings?.simulations !== false
    });
    if (!active || generation !== operationGeneration) throw new Error("Arena feature is disabled.");
    clearArenaBadges();
    if (activeSettings?.annotations) annotateResult(result);
    return result;
  }

  async function loadFormulaState() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      arenaFormulas = [ARENA.defaultArenaFormula()];
      selectedFormulaId = arenaFormulas[0].id;
      return;
    }

    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, ARENA_UI_STATE_KEY, LEGACY_POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    arenaFormulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula()];
    const uiState = result[ARENA_UI_STATE_KEY] || {};
    selectedFormulaId = String(uiState.arenaFormulaId || result[LEGACY_POPUP_STATE_KEY]?.arenaFormulaId || "");
    if (!getSelectedFormula()) selectedFormulaId = getAvailableFormulas()[0]?.id || ARENA.defaultArenaFormula().id;
    if (!uiState.arenaFormulaId && selectedFormulaId) {
      await chrome.storage.local.set({ [ARENA_UI_STATE_KEY]: { arenaFormulaId: selectedFormulaId } });
    }
  }

  function getAvailableFormulas() {
    const enabled = arenaFormulas.filter((formula) => formula.enabled);
    return enabled.length ? enabled : arenaFormulas;
  }

  function getSelectedFormula() {
    const available = getAvailableFormulas();
    return available.find((formula) => formula.id === selectedFormulaId) || available[0] || ARENA.defaultArenaFormula();
  }

  async function saveSelectedFormulaId(formulaId) {
    selectedFormulaId = formulaId;
    if (!active || typeof chrome === "undefined" || !chrome.storage?.local) return;

    const generation = operationGeneration;
    const result = await chrome.storage.local.get(ARENA_UI_STATE_KEY);
    if (!active || generation !== operationGeneration) return;
    await chrome.storage.local.set({
      [ARENA_UI_STATE_KEY]: {
        ...(result[ARENA_UI_STATE_KEY] || {}),
        arenaFormulaId: selectedFormulaId
      }
    });
  }

  function annotateResult(result) {
    if (!active || !activeSettings?.annotations) return;
    const entries = ARENA.readArenaOpponentEntries(document, window.location.href);
    annotateRows(entries, result?.opponents || []);
  }

  async function annotateCachedResult(options = {}) {
    if (!active || !activeSettings?.annotations) return false;
    const generation = operationGeneration;
    const result = await SCANNER.getCachedResultForCurrentPage(getSelectedFormula(), {
      updateLastResult: false,
      scanSource: options.fromStorage ? "storage" : "visible-cache"
    });

    if (!active || generation !== operationGeneration) return false;
    if (result) {
      clearArenaBadges();
      annotateResult(result);
      const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
      if (status) setPanelStatus(status, resultStatusText(result), false);
    }

    if (activeSettings?.passiveRefresh && options.refresh !== false && !options.fromStorage) {
      refreshVisibleScanInBackground(result);
    }

    return Boolean(result);
  }

  function refreshVisibleScanInBackground(previousResult = null, options = {}) {
    if (!active || !activeSettings?.passiveRefresh || visibleRefreshInFlight) return;
    visibleRefreshInFlight = true;
    const generation = operationGeneration;
    const attempt = ARENA.parseInteger(options.attempt);

    SCANNER.ensureScanForCurrentPage(getSelectedFormula(), {
      updateLastResult: true,
      scanSource: "visible",
      simulations: activeSettings?.simulations !== false
    })
      .then((result) => {
        if (!active || generation !== operationGeneration) return;
        if (!result) {
          if (!previousResult && shouldRetryVisibleScan(attempt)) scheduleVisibleScanRetry(attempt + 1);
          return;
        }
        window.clearTimeout(visibleRefreshRetryTimer);
        if (previousResult
          && previousResult.scannedAt === result.scannedAt
          && previousResult.fingerprint === result.fingerprint
          && previousResult.formulaFingerprint === result.formulaFingerprint) {
          return;
        }

        clearArenaBadges();
        annotateResult(result);
        const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
        if (status) setPanelStatus(status, resultStatusText(result), false);
      })
      .catch((error) => {
        if (!active || generation !== operationGeneration) return;
        const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
        if (status && !document.querySelector(`.${BADGE_CLASS}`)) setPanelStatus(status, error.message || String(error), true);
      })
      .finally(() => {
        if (generation === operationGeneration) visibleRefreshInFlight = false;
      });
  }

  function shouldRetryVisibleScan(attempt) {
    if (!active || !activeSettings?.passiveRefresh) return false;
    if (attempt >= VISIBLE_SCAN_MAX_RETRIES) return false;
    if (!ARENA.isArenaPageUrl(window.location.href)) return false;
    if (document.querySelector(`.${BADGE_CLASS}`)) return false;
    return ARENA.readArenaOpponentEntries(document, window.location.href).length > 0;
  }

  function scheduleVisibleScanRetry(attempt) {
    if (!active || !activeSettings?.passiveRefresh) return;
    window.clearTimeout(visibleRefreshRetryTimer);
    visibleRefreshRetryTimer = window.setTimeout(() => {
      refreshVisibleScanInBackground(null, { attempt });
    }, VISIBLE_SCAN_RETRY_DELAY_MS);
  }

  function annotateRows(entries, opponents) {
    const scoreMode = isTeamScan(entries, opponents);
    const best = scoreMode ? bestScoreResult(opponents) : bestSimulationResult(opponents) || bestScoreResult(opponents);
    const resultIndex = indexOpponentResults(opponents);

    for (const entry of entries) {
      const result = findOpponentResult(entry, resultIndex);
      if (!result) continue;

      const targetCell = entry.link.parentElement || entry.row.cells?.[0];
      if (!targetCell) continue;

      entry.row.classList.toggle(BEST_CLASS, Boolean(best && result.rowIndex === best.rowIndex));
      const badge = document.createElement("span");
      badge.className = BADGE_CLASS;

      if (scoreMode) {
        if (Number.isFinite(result.score)) {
          badge.textContent = `${entry.opponent.arenaKind === "team" ? "Team" : "Power"} ${ARENA.formatNumber(result.score)}`;
          badge.title = scoreTitle(result, { includeSimulation: false });
          if (result.matches === false) badge.classList.add("glad-arena-score-warning");
        } else {
          badge.classList.add("glad-arena-score-error");
          badge.textContent = "Power ?";
          badge.title = result.error || "Scan failed.";
        }
      } else if (result.simulation?.ready) {
        badge.textContent = simulationWinLabel(result);
        badge.title = scoreTitle(result);
      } else if (Number.isFinite(result.score)) {
        badge.classList.add("glad-arena-score-warning");
        badge.textContent = `Power ${ARENA.formatNumber(result.score)}`;
        badge.title = scoreTitle(result);
        if (result.matches === false) badge.classList.add("glad-arena-score-warning");
      } else {
        badge.classList.add(result.error ? "glad-arena-score-error" : "glad-arena-score-warning");
        badge.textContent = "Power ?";
        badge.title = scoreTitle(result) || result.error || "Simulation unavailable.";
      }

      targetCell.append(badge);
    }
  }

  function indexOpponentResults(opponents = []) {
    const byRowIndex = new Map();
    const byIdentity = new Map();

    for (const result of opponents) {
      const rowIndex = ARENA.parseInteger(result?.rowIndex ?? result?.opponent?.rowIndex);
      if (Number.isFinite(rowIndex)) byRowIndex.set(rowIndex, result);
      for (const key of opponentIdentityKeys(result?.opponent || result?.character || {})) {
        if (!byIdentity.has(key)) byIdentity.set(key, result);
      }
    }

    return { byRowIndex, byIdentity };
  }

  function findOpponentResult(entry, index) {
    const rowResult = index.byRowIndex.get(ARENA.parseInteger(entry?.opponent?.rowIndex));
    if (rowResult && sameOpponent(entry.opponent, rowResult.opponent)) return rowResult;

    for (const key of opponentIdentityKeys(entry?.opponent || {})) {
      const result = index.byIdentity.get(key);
      if (result) return result;
    }
    return null;
  }

  function sameOpponent(a, b) {
    if (!a || !b) return false;
    const aKeys = new Set(opponentIdentityKeys(a));
    return opponentIdentityKeys(b).some((key) => aKeys.has(key));
  }

  function opponentIdentityKeys(opponent) {
    const kind = String(opponent?.arenaKind || "");
    const keys = [];
    if (opponent?.id) keys.push(`id:${kind}:${String(opponent.id)}`);
    const profileUrl = normalizeOpponentProfileUrl(opponent?.profileUrl || "");
    if (profileUrl) keys.push(`url:${kind}:${profileUrl}`);
    const name = String(opponent?.name || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (name) keys.push(`name:${kind}:${name}`);
    return keys;
  }

  function normalizeOpponentProfileUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.href);
      url.hash = "";
      url.searchParams.delete("sh");
      url.searchParams.sort();
      return url.href;
    } catch {
      return "";
    }
  }

  function scoreTitle(result, options = {}) {
    const includeSimulation = options.includeSimulation !== false;
    const simulation = includeSimulation ? simulationTitle(result) : "";
    if (result.team) {
      const teamTitle = result.team.members
        .map((member) => `${member.roleLabel}: ${ARENA.formatNumber(member.formulaScore)} (${ARENA.formatCharacterStats(member)})`)
        .join("\n");
      return [teamTitle, simulation].filter(Boolean).join("\n");
    }
    return [
      result.character ? ARENA.formatCharacterStats(result.character) : result.error || "",
      simulation
    ].filter(Boolean).join("\n");
  }

  function simulationWinLabel(result) {
    return result?.simulation?.ready ? `Win ${formatPercent(result.simulation.winRate)}` : "";
  }

  function bestSimulationResult(opponents = []) {
    return [...opponents]
      .filter((entry) => entry?.simulation?.ready)
      .sort((a, b) => {
        const winDiff = (b.simulation.winRate || 0) - (a.simulation.winRate || 0);
        if (winDiff) return winDiff;
        const lossDiff = (a.simulation.lossRate || 0) - (b.simulation.lossRate || 0);
        if (lossDiff) return lossDiff;
        return (a.opponent?.rowIndex || a.rowIndex || 0) - (b.opponent?.rowIndex || b.rowIndex || 0);
      })[0] || null;
  }

  function bestScoreResult(opponents = []) {
    return [...opponents]
      .filter((entry) => Number.isFinite(entry?.score))
      .sort((a, b) => {
        const scoreDiff = a.score - b.score;
        if (scoreDiff) return scoreDiff;
        return (a.opponent?.rowIndex || a.rowIndex || 0) - (b.opponent?.rowIndex || b.rowIndex || 0);
      })[0] || null;
  }

  function simulationTitle(result) {
    const simulation = result?.simulation;
    if (!simulation) return "";
    if (!simulation.ready) return simulation.missing?.length ? `Simulation unavailable: ${simulation.missing.join(", ")}` : "";
    return `Simulation: win ${formatPercent(simulation.winRate)}, loss ${formatPercent(simulation.lossRate)}, draw ${formatPercent(simulation.drawRate)} (${simulation.iterations} runs)`;
  }

  function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
  }

  function isTeamScan(entries = [], opponents = []) {
    return entries.some((entry) => entry?.opponent?.arenaKind === "team")
      || opponents.some((entry) => entry?.team || entry?.opponent?.arenaKind === "team");
  }

  function clearArenaBadges() {
    document.querySelectorAll(`.${BADGE_CLASS}`).forEach((badge) => badge.remove());
    document.querySelectorAll(`.${BEST_CLASS}`).forEach((row) => row.classList.remove(BEST_CLASS));
  }

  function removeArenaPanel() {
    window.clearTimeout(visibleRefreshRetryTimer);
    document.getElementById(PANEL_ID)?.remove();
    clearArenaBadges();
  }

  function ensurePanel() {
    if (!active || (!activeSettings?.manualScan && !activeSettings?.annotations)
      || !ARENA.isArenaPageUrl(window.location.href) || document.getElementById(PANEL_ID)) return;

    const entries = ARENA.readArenaOpponentEntries(document);
    const table = entries[0]?.row?.closest("table");
    if (!table) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const title = document.createElement("strong");
    title.textContent = "Arena insights";

    const formulaLabel = document.createElement("label");
    formulaLabel.htmlFor = "glad-arena-formula";
    formulaLabel.textContent = "Formula";

    const select = document.createElement("select");
    select.id = "glad-arena-formula";
    renderFormulaOptions(select);
    select.addEventListener("change", () => {
      saveSelectedFormulaId(select.value)
        .then(() => {
          clearArenaBadges();
          return activeSettings?.annotations ? annotateCachedResult({ refresh: activeSettings?.passiveRefresh }) : false;
        })
        .catch(() => {});
    });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entries.some((entry) => entry?.opponent?.arenaKind === "team") ? "Scan scores" : "Scan odds";
    button.disabled = !activeSettings?.manualScan;
    button.addEventListener("click", () => {
      runPanelScan(button, select, status).catch((error) => {
        setPanelStatus(status, error.message || String(error), true);
      });
    });

    const status = document.createElement("span");
    status.className = "glad-arena-status";
    status.setAttribute("aria-live", "polite");
    status.textContent = `${entries.length} opponents`;

    panel.append(title, formulaLabel, select, button, status);
    table.before(panel);
  }

  function renderFormulaOptions(select) {
    select.replaceChildren();
    for (const formula of getAvailableFormulas()) {
      const option = document.createElement("option");
      option.value = formula.id;
      option.textContent = formula.name;
      select.append(option);
    }
    select.value = getSelectedFormula().id;
  }

  async function runPanelScan(button, select, status) {
    if (!active || !activeSettings?.manualScan) throw new Error("Manual arena scanning is disabled.");
    const generation = operationGeneration;
    button.disabled = true;
    select.disabled = true;
    setPanelStatus(status, "Scanning profiles...", false);

    try {
      const formula = arenaFormulas.find((candidate) => candidate.id === select.value) || getSelectedFormula();
      await saveSelectedFormulaId(formula.id);
      const result = await scanOpponents(formula);
      if (!active || generation !== operationGeneration) return;
      if (!result) throw new Error("Scan is already running. Wait for the current scan to finish.");

      setPanelStatus(status, resultStatusText(result), false);
    } finally {
      button.disabled = false;
      select.disabled = false;
    }
  }

  function resultStatusText(result) {
    if (!result) return "Scan is already running";
    const failed = result.failedCount ? `, ${result.failedCount} failed` : "";
    if (result.arenaKind === "team") {
      return result.bestName
        ? `Best: ${result.bestName} (${ARENA.formatNumber(result.bestScore)})${failed}`
        : `Scanned ${result.opponentCount}${failed}`;
    }
    if (!result.bestName) return `Scanned ${result.opponentCount}${failed}`;
    const best = bestResultFromSummary(result);
    return best?.simulation?.ready
      ? `Best win: ${result.bestName} (${formatPercent(best.simulation.winRate)})${failed}`
      : `Best power: ${result.bestName} (${ARENA.formatNumber(result.bestScore)})${failed}`;
  }

  function bestResultFromSummary(result) {
    const opponents = result?.opponents || [];
    return opponents.find((entry) => entry?.displayName === result.bestName)
      || opponents.find((entry) => entry?.opponent?.name === result.bestName)
      || null;
  }

  function setPanelStatus(status, text, isError) {
    status.textContent = text;
    status.classList.toggle("glad-arena-status-error", Boolean(isError));
  }

  function boot() {
    if (!active) return;
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      if (!active) return;
      if (!ARENA.isArenaPageUrl(window.location.href)) {
        removeArenaPanel();
        return;
      }

      loadFormulaState()
        .then(async () => {
          if (!active) return;
          ensurePanel();
          if (activeSettings?.annotations) subscribeToPassiveCacheChanges();
          if (activeSettings?.passiveRefresh) await SCANNER.rememberCurrentListUrl(window.location.href);
          if (activeSettings?.annotations) {
            await annotateCachedResult({ refresh: activeSettings?.passiveRefresh });
          }
        })
        .catch(() => {
          if (!active) return;
          arenaFormulas = [ARENA.defaultArenaFormula()];
          selectedFormulaId = arenaFormulas[0].id;
          ensurePanel();
        });
    }, 150);
  }
  window.__GladiatusArenaContentBoot = boot;

  function scheduleCachedAnnotation() {
    if (!active || !activeSettings?.annotations) return;
    window.clearTimeout(annotationTimer);
    annotationTimer = window.setTimeout(() => {
      annotateCachedResult().catch(() => {});
    }, 80);
  }

  function handleArenaContentMutation() {
    if (!active) return;
    if (window.location.href !== lastObservedHref) {
      lastObservedHref = window.location.href;
      boot();
      return;
    }

    if (!ARENA.isArenaPageUrl(window.location.href)) return;

    if (!document.getElementById(PANEL_ID)) {
      boot();
      return;
    }

    const hasEntries = ARENA.readArenaOpponentEntries(document, window.location.href).length > 0;
    if (hasEntries && !document.querySelector(`.${BADGE_CLASS}`)) scheduleCachedAnnotation();
  }

  function scheduleArenaBootForLocation() {
    if (!active) return;
    if (window.location.href !== lastObservedHref) lastObservedHref = window.location.href;
    boot();
  }

  const observer = new MutationObserver(handleArenaContentMutation);

  function subscribeToPassiveCacheChanges() {
    if (!active || !activeSettings?.annotations || !chrome.storage?.onChanged || window.__GladiatusArenaPassiveCacheListener) return;

    window.__GladiatusArenaPassiveCacheListener = (changes, areaName) => {
      if (areaName !== "local" || !changes[ARENA.passiveScansStorageKey]) return;
      annotateCachedResult({ fromStorage: true }).catch(() => {});
    };
    chrome.storage.onChanged.addListener(window.__GladiatusArenaPassiveCacheListener);
  }

  async function start(settings = {}) {
    if (!shouldRunArenaController(settings)) return stop();
    if (active) return update(settings);

    active = true;
    activeSettings = { ...settings };
    operationGeneration += 1;
    initialized = true;

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      boot();
    }
    window.addEventListener("pageshow", scheduleArenaBootForLocation);
    window.addEventListener("popstate", scheduleArenaBootForLocation);
    window.addEventListener("hashchange", scheduleArenaBootForLocation);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function update(settings = {}) {
    await stop();
    if (shouldRunArenaController(settings)) await start(settings);
  }

  async function stop() {
    active = false;
    activeSettings = null;
    initialized = false;
    operationGeneration += 1;
    visibleRefreshInFlight = false;
    window.clearTimeout(bootTimer);
    window.clearTimeout(annotationTimer);
    window.clearTimeout(visibleRefreshRetryTimer);
    observer.disconnect();
    document.removeEventListener("DOMContentLoaded", boot);
    window.removeEventListener("pageshow", scheduleArenaBootForLocation);
    window.removeEventListener("popstate", scheduleArenaBootForLocation);
    window.removeEventListener("hashchange", scheduleArenaBootForLocation);
    removeArenaPanel();

    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
    }
    const cacheListener = window.__GladiatusArenaPassiveCacheListener;
    if (cacheListener && typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(cacheListener);
    }
    delete window.__GladiatusArenaPassiveCacheListener;
  }

  window.__GladiatusArenaContentBoot = boot;
  window.GladiatusArenaFeature = {
    version: CONTENT_VERSION,
    ready: true,
    start,
    update,
    stop,
    getStatus() {
      return { ...getArenaContentStatus(), active, initialized };
    }
  };
})();
