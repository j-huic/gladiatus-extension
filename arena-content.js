(() => {
  const MESSAGE_TYPES = {
    scanOpponents: "GLAD_ARENA_SCAN_OPPONENTS",
    boot: "GLAD_ARENA_BOOT_V2",
    status: "GLAD_ARENA_CONTENT_STATUS_V2"
  };
  const ARENA = window.GladiatusArenaCore;
  const SCANNER = window.GladiatusArenaScanner;

  if (!ARENA || !SCANNER) {
    registerMissingArenaDependencyDiagnostic();
    return;
  }

  if (window.__GladiatusArenaMissingDependencyListener && typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.removeListener?.(window.__GladiatusArenaMissingDependencyListener);
    delete window.__GladiatusArenaMissingDependencyListener;
  }

  if (window.__GladiatusArenaContentBootstrapped) {
    window.__GladiatusArenaContentBoot?.();
    return;
  }
  window.__GladiatusArenaContentBootstrapped = true;

  const PANEL_ID = "glad-arena-scanner";
  const BADGE_CLASS = "glad-arena-score";
  const BEST_CLASS = "glad-arena-best";
  const VISIBLE_SCAN_RETRY_DELAY_MS = 1200;
  const VISIBLE_SCAN_MAX_RETRIES = 3;
  const POPUP_STATE_KEY = window.GladiatusAuctionSchema?.storageKeys?.popupState || "glad-ah-popup-state-v1";
  let arenaFormulas = [ARENA.defaultArenaFormula()];
  let selectedFormulaId = "";
  let bootTimer = 0;
  let annotationTimer = 0;
  let visibleRefreshRetryTimer = 0;
  let visibleRefreshInFlight = false;
  let lastObservedHref = window.location.href;

  function registerMissingArenaDependencyDiagnostic() {
    const error = "Arena content script dependency missing: arena-core.js or arena-scan.js. Reload the unpacked extension and refresh this arena tab.";
    console.error(error);

    if (typeof chrome === "undefined" || !chrome.runtime?.onMessage || window.__GladiatusArenaMissingDependencyListener) return;

    window.__GladiatusArenaMissingDependencyListener = (message, _sender, sendResponse) => {
      if (![MESSAGE_TYPES.scanOpponents, MESSAGE_TYPES.boot, MESSAGE_TYPES.status].includes(message?.type)) return false;
      sendResponse({ ok: false, error });
      return false;
    };
    chrome.runtime.onMessage.addListener(window.__GladiatusArenaMissingDependencyListener);
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === MESSAGE_TYPES.boot) {
        boot();
        sendResponse(getArenaContentStatus());
        return false;
      }

      if (message?.type === MESSAGE_TYPES.status) {
        sendResponse(getArenaContentStatus());
        return false;
      }

      if (message?.type !== MESSAGE_TYPES.scanOpponents) return false;

      scanOpponents(message.formula)
        .then(async (result) => {
          await saveArenaResult(result);
          sendResponse({ ok: true, result });
        })
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

      return true;
    });
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
    if (!ARENA.isArenaPageUrl(window.location.href)) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    clearArenaBadges();
    const result = await SCANNER.scanCurrentPage(rawFormula, { force: true });
    clearArenaBadges();
    annotateResult(result);
    return result;
  }

  async function loadFormulaState() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      arenaFormulas = [ARENA.defaultArenaFormula()];
      selectedFormulaId = arenaFormulas[0].id;
      return;
    }

    const result = await chrome.storage.local.get([ARENA.formulasStorageKey, POPUP_STATE_KEY]);
    const storedFormulas = ARENA.normalizeArenaFormulas(result[ARENA.formulasStorageKey]);
    arenaFormulas = storedFormulas.length ? storedFormulas : [ARENA.defaultArenaFormula()];
    selectedFormulaId = String(result[POPUP_STATE_KEY]?.arenaFormulaId || "");
    if (!getSelectedFormula()) selectedFormulaId = getAvailableFormulas()[0]?.id || ARENA.defaultArenaFormula().id;
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
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;

    const result = await chrome.storage.local.get(POPUP_STATE_KEY);
    await chrome.storage.local.set({
      [POPUP_STATE_KEY]: {
        ...(result[POPUP_STATE_KEY] || {}),
        arenaFormulaId: selectedFormulaId
      }
    });
  }

  async function saveArenaResult(result) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return;
    await chrome.storage.local.set({ [ARENA.resultsStorageKey]: result });
  }

  function annotateResult(result) {
    const entries = ARENA.readArenaOpponentEntries(document, window.location.href);
    annotateRows(entries, result?.opponents || []);
  }

  async function annotateCachedResult(options = {}) {
    const result = await SCANNER.getCachedResultForCurrentPage(getSelectedFormula(), {
      updateLastResult: true,
      scanSource: options.fromStorage ? "storage" : "visible-cache"
    });

    if (result) {
      clearArenaBadges();
      annotateResult(result);
      const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
      if (status) setPanelStatus(status, resultStatusText(result, "Cached"), false);
    }

    if (options.refresh !== false && !options.fromStorage) {
      refreshVisibleScanInBackground(result);
    }

    return Boolean(result);
  }

  function refreshVisibleScanInBackground(previousResult = null, options = {}) {
    if (visibleRefreshInFlight) return;
    visibleRefreshInFlight = true;
    const attempt = ARENA.parseInteger(options.attempt);

    SCANNER.ensureScanForCurrentPage(getSelectedFormula(), {
      updateLastResult: true,
      scanSource: "visible"
    })
      .then((result) => {
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
        if (status) setPanelStatus(status, resultStatusText(result, result.arenaKind === "team" ? "Best" : "Best win"), false);
      })
      .catch((error) => {
        const status = document.querySelector(`#${PANEL_ID} .glad-arena-status`);
        if (status && !document.querySelector(`.${BADGE_CLASS}`)) setPanelStatus(status, error.message || String(error), true);
      })
      .finally(() => {
        visibleRefreshInFlight = false;
      });
  }

  function shouldRetryVisibleScan(attempt) {
    if (attempt >= VISIBLE_SCAN_MAX_RETRIES) return false;
    if (!ARENA.isArenaPageUrl(window.location.href)) return false;
    if (document.querySelector(`.${BADGE_CLASS}`)) return false;
    return ARENA.readArenaOpponentEntries(document, window.location.href).length > 0;
  }

  function scheduleVisibleScanRetry(attempt) {
    window.clearTimeout(visibleRefreshRetryTimer);
    visibleRefreshRetryTimer = window.setTimeout(() => {
      refreshVisibleScanInBackground(null, { attempt });
    }, VISIBLE_SCAN_RETRY_DELAY_MS);
  }

  function annotateRows(entries, opponents) {
    const scoreMode = isTeamScan(entries, opponents);
    const best = scoreMode ? bestScoreResult(opponents) : bestSimulationResult(opponents);
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
      } else {
        badge.classList.add(result.error ? "glad-arena-score-error" : "glad-arena-score-warning");
        badge.textContent = "Win ?";
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
    if (!ARENA.isArenaPageUrl(window.location.href) || document.getElementById(PANEL_ID)) return;

    const entries = ARENA.readArenaOpponentEntries(document);
    const table = entries[0]?.row?.closest("table");
    if (!table) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const title = document.createElement("strong");
    title.textContent = "Arena scanner";

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
          return annotateCachedResult();
        })
        .catch(() => {});
    });

    const button = document.createElement("button");
    button.type = "button";
    button.textContent = entries.some((entry) => entry?.opponent?.arenaKind === "team") ? "Scan scores" : "Scan odds";
    button.addEventListener("click", () => {
      runPanelScan(button, select, status).catch((error) => {
        setPanelStatus(status, error.message || String(error), true);
      });
    });

    const status = document.createElement("span");
    status.className = "glad-arena-status";
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
    button.disabled = true;
    select.disabled = true;
    setPanelStatus(status, "Scanning profiles...", false);

    try {
      const formula = arenaFormulas.find((candidate) => candidate.id === select.value) || getSelectedFormula();
      await saveSelectedFormulaId(formula.id);
      const result = await scanOpponents(formula);
      if (!result) throw new Error("Scan is already running. Wait for the current scan to finish.");
      await saveArenaResult(result);

      setPanelStatus(status, resultStatusText(result, result.arenaKind === "team" ? "Best" : "Best win"), false);
    } finally {
      button.disabled = false;
      select.disabled = false;
    }
  }

  function resultStatusText(result, prefix) {
    if (!result) return "Scan is already running";
    const failed = result.failedCount ? `, ${result.failedCount} failed` : "";
    if (result.arenaKind === "team") {
      return result.bestName
        ? `${prefix}: ${result.bestName} (${ARENA.formatNumber(result.bestScore)})${failed}`
        : `Scanned ${result.opponentCount}${failed}`;
    }
    return result.bestName && Number.isFinite(result.bestWinRate)
      ? `${prefix}: ${result.bestName} (${formatPercent(result.bestWinRate)})${failed}`
      : `Scanned ${result.opponentCount}${failed}`;
  }

  function setPanelStatus(status, text, isError) {
    status.textContent = text;
    status.classList.toggle("glad-arena-status-error", Boolean(isError));
  }

  function boot() {
    window.clearTimeout(bootTimer);
    bootTimer = window.setTimeout(() => {
      if (!ARENA.isArenaPageUrl(window.location.href)) {
        removeArenaPanel();
        return;
      }

      loadFormulaState()
        .then(async () => {
          ensurePanel();
          subscribeToPassiveCacheChanges();
          await SCANNER.rememberCurrentListUrl(window.location.href);
          await annotateCachedResult();
        })
        .catch(() => {
          arenaFormulas = [ARENA.defaultArenaFormula()];
          selectedFormulaId = arenaFormulas[0].id;
          ensurePanel();
        });
    }, 150);
  }
  window.__GladiatusArenaContentBoot = boot;

  function scheduleCachedAnnotation() {
    window.clearTimeout(annotationTimer);
    annotationTimer = window.setTimeout(() => {
      annotateCachedResult().catch(() => {});
    }, 80);
  }

  function handleArenaContentMutation() {
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
    if (window.location.href !== lastObservedHref) lastObservedHref = window.location.href;
    boot();
  }

  const observer = new MutationObserver(handleArenaContentMutation);

  function subscribeToPassiveCacheChanges() {
    if (!chrome.storage?.onChanged || window.__GladiatusArenaPassiveCacheListener) return;

    window.__GladiatusArenaPassiveCacheListener = (changes, areaName) => {
      if (areaName !== "local" || !changes[ARENA.passiveScansStorageKey]) return;
      annotateCachedResult({ fromStorage: true }).catch(() => {});
    };
    chrome.storage.onChanged.addListener(window.__GladiatusArenaPassiveCacheListener);
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
})();
