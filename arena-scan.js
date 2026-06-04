(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
  if (root.__GladiatusArenaScannerFacadeLoaded) return;
  root.__GladiatusArenaScannerFacadeLoaded = true;

  const FULL_SCAN_QUIET_MS = 10 * 60 * 1000;

  function currentArenaKind() {
    return ARENA.isArenaPageUrl(root.location?.href || "") ? ARENA.arenaKindFromUrl(root.location.href) : "";
  }

  function readVisibleEntries() {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return [];
    return ARENA.readArenaOpponentEntries(root.document, root.location.href);
  }

  async function scanCurrentPage(rawFormula) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) {
      throw new Error("Open a Gladiatus arena page before scanning opponents.");
    }

    const entries = readVisibleEntries();
    if (!entries.length) throw new Error("Could not find arena opponent rows.");

    const response = await sendRuntimeMessage({
      type: "GLAD_ARENA_FORCE_SCAN",
      url: root.location.href,
      entries: serializeEntries(entries),
      formula: rawFormula || null
    });
    if (!response?.ok) throw new Error(response?.error || "Could not scan arena opponents.");
    if (!response.result) throw new Error("Scan is already running. Wait for the current scan to finish.");
    return response.result;
  }

  async function ensureScanForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    const entries = readVisibleEntries();
    const ensured = await ensureScanForEntries(entries, rawFormula, {
      ...options,
      url: root.location.href,
      scanSource: options.scanSource || "visible"
    });
    return ensured.result;
  }

  async function ensureScanForEntries(entries, rawFormula, options = {}) {
    const serialized = serializeEntries(entries);
    if (!serialized.length) return { result: null, skipped: "empty" };

    const response = await sendRuntimeMessage({
      type: options.force ? "GLAD_ARENA_FORCE_SCAN" : "GLAD_ARENA_ENSURE_VISIBLE_SCAN",
      url: options.url || options.listUrl || options.sourceUrl || root.location?.href || "",
      entries: serialized,
      formula: rawFormula || null
    });
    if (!response?.ok) throw new Error(response?.error || "Could not ensure arena scan.");
    return {
      result: response.result || null,
      scanned: Boolean(response.result),
      skipped: response.result ? "" : "locked"
    };
  }

  async function getCachedResultForCurrentPage(rawFormula, options = {}) {
    if (!ARENA.isArenaPageUrl(root.location?.href || "")) return null;
    return getCachedResultForEntries(readVisibleEntries(), rawFormula, options);
  }

  async function getCachedResultForEntries(entries, rawFormula, options = {}) {
    if (!chrome.storage?.local) return null;
    const serialized = serializeEntries(entries);
    if (!serialized.length) return null;

    const formula = ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula();
    const kind = options.kind || serialized[0]?.opponent?.arenaKind || currentArenaKind() || "single";
    const fingerprint = ARENA.arenaOpponentFingerprint(serialized);
    const formulaKey = arenaFormulaFingerprint(formula);
    const stored = await chrome.storage.local.get(ARENA.passiveScansStorageKey);
    const record = stored[ARENA.passiveScansStorageKey]?.[kind] || {};
    if (!record.result || record.fingerprint !== fingerprint || record.formulaFingerprint !== formulaKey) return null;

    if (options.updateLastResult !== false) {
      await chrome.storage.local.set({ [ARENA.resultsStorageKey]: record.result });
    }
    return record.result;
  }

  async function refreshSelfProfile(options = {}) {
    const profileUrl = deriveCurrentSelfProfileUrl();
    if (!profileUrl) throw new Error("Could not derive your Gladiatus profile URL from this page.");

    const response = await sendRuntimeMessage({
      type: "GLAD_ARENA_REFRESH_SELF_PROFILE",
      profileUrl,
      force: Boolean(options.force)
    });
    if (!response?.ok) throw new Error(response?.error || "Could not refresh self profile.");
    return response.record || null;
  }

  function deriveCurrentSelfProfileUrl() {
    return ARENA.deriveSelfProfileUrl(root.location?.href || "", {
      playerId: root.playerId || "",
      secureHash: root.secureHash || "",
      scripts: Array.from(root.document?.scripts || []).map((script) => script.textContent || "")
    });
  }

  function rememberCurrentListUrl(url = root.location?.href || "") {
    if (!ARENA.isArenaPageUrl(url)) return Promise.resolve("");
    return Promise.resolve(ARENA.arenaKindFromUrl(url));
  }

  function serializeEntries(entries) {
    return Array.isArray(entries)
      ? entries.map((entry, index) => ({
        opponent: {
          ...(entry?.opponent || entry || {}),
          rowIndex: ARENA.parseInteger(entry?.opponent?.rowIndex ?? entry?.rowIndex ?? index)
        }
      })).filter((entry) => entry.opponent.profileUrl)
      : [];
  }

  function arenaFormulaFingerprint(rawFormula) {
    return JSON.stringify(ARENA.normalizeArenaFormula(rawFormula) || ARENA.defaultArenaFormula());
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

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "GLAD_ARENA_REFRESH_SELF_PROFILE") return false;

      refreshSelfProfile({ force: Boolean(message.force) })
        .then((record) => sendResponse({ ok: true, record }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    });
  }

  root.GladiatusArenaScanner = {
    arenaFormulaFingerprint,
    deriveSelfProfileUrl: deriveCurrentSelfProfileUrl,
    fullScanQuietMs: FULL_SCAN_QUIET_MS,
    getCachedResultForCurrentPage,
    getCachedResultForEntries,
    ensureScanForCurrentPage,
    ensureScanForEntries,
    passiveScansStorageKey: ARENA.passiveScansStorageKey,
    scanStatusStorageKey: ARENA.scanStatusStorageKey,
    rememberCurrentListUrl,
    refreshSelfProfile,
    scanCurrentPage
  };
})();
