(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || root.GladiatusArenaFight) return;

  const GAME_PATH = "/game/";

  // --- Picking the best opponent from a stored scan result (pure) ---------

  function bestTargetFromResult(result) {
    if (!result || !Array.isArray(result.opponents) || !result.opponents.length) return null;

    const best = findOpponentByName(result.opponents, result.bestName) || null;
    if (!best) return null;

    const opponent = best.opponent || {};
    const request = fightEndpoint(opponent, result.sourceUrl);
    if (!request) return null;

    const winRate = best.simulation && best.simulation.ready
      ? best.simulation.winRate
      : (Number.isFinite(result.bestWinRate) && result.bestWinRate > 0 ? result.bestWinRate : null);

    return {
      kind: result.arenaKind || opponent.arenaKind || "single",
      name: best.displayName || opponent.name || "",
      winRate,
      score: Number.isFinite(best.score) ? best.score : null,
      opponentId: request.opponentId,
      sourceUrl: result.sourceUrl || "",
      request
    };
  }

  function findOpponentByName(opponents, name) {
    const key = normalizeName(name);
    if (!key) return null;
    return opponents.find((entry) => normalizeName(entry?.displayName) === key)
      || opponents.find((entry) => normalizeName(entry?.opponent?.name) === key)
      || null;
  }

  function normalizeName(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // --- Mapping an opponent to its fight request (pure) --------------------
  // Mirrors the game's own attack handlers:
  //   serverArena -> startProvinciarumFight -> ajax.php?...&submod=doCombat
  //   grouparena  -> startGroupFight        -> ajax/doGroupFight.php?did=
  //   plain arena -> startFight             -> ajax/doArenaFight.php?did=

  function fightEndpoint(opponent, sourceUrl) {
    if (!opponent) return null;
    const id = String(opponent.id || "");
    if (!id) return null;

    const submod = arenaSubmod(sourceUrl);

    if (submod === "serverArena") {
      const aType = arenaType(sourceUrl) || (opponent.arenaKind === "team" ? "3" : "2");
      const data = [
        "mod=arena",
        "submod=doCombat",
        `aType=${encodeURIComponent(aType)}`,
        `opponentId=${encodeURIComponent(id)}`,
        `serverId=${encodeURIComponent(String(opponent.province || ""))}`,
        `country=${encodeURIComponent(String(opponent.language || ""))}`
      ].join("&");
      return { path: "ajax.php", data, opponentId: id };
    }

    if (submod === "grouparena") {
      return { path: "ajax/doGroupFight.php", data: `did=${encodeURIComponent(id)}`, opponentId: id };
    }

    return { path: "ajax/doArenaFight.php", data: `did=${encodeURIComponent(id)}`, opponentId: id };
  }

  function arenaSubmod(sourceUrl) {
    try {
      return new URL(String(sourceUrl || "")).searchParams.get("submod") || "";
    } catch {
      return "";
    }
  }

  function arenaType(sourceUrl) {
    try {
      return new URL(String(sourceUrl || "")).searchParams.get("aType") || "";
    } catch {
      return "";
    }
  }

  // --- Building the HTTP request (pure) -----------------------------------

  function buildFightRequest(target, credentials) {
    if (!target || !target.request) throw new Error("No opponent selected to fight.");
    if (!credentials || !credentials.origin) throw new Error("Could not determine the game origin.");
    if (!credentials.sh) throw new Error("Could not read the secure hash (sh) from this page.");
    if (!credentials.csrfToken) throw new Error("Could not read the CSRF token from this page.");

    const url = `${credentials.origin}${GAME_PATH}${target.request.path}`
      + `?${target.request.data}&a=${Date.now()}&sh=${encodeURIComponent(credentials.sh)}`;

    return {
      url,
      options: {
        method: "GET",
        credentials: "include",
        headers: {
          "X-CSRF-Token": credentials.csrfToken,
          "X-Requested-With": "XMLHttpRequest"
        }
      }
    };
  }

  // --- Reading per-page credentials (page environment) --------------------

  function readPageCredentials() {
    return {
      origin: root.location?.origin || "",
      sh: pageSecureHash(),
      csrfToken: pageCsrfToken()
    };
  }

  function pageSecureHash() {
    try {
      const fromUrl = new URL(root.location?.href || "").searchParams.get("sh");
      if (fromUrl) return fromUrl;
    } catch {
      // fall through to scraping a link
    }
    const link = root.document?.querySelector?.('a[href*="sh="]');
    if (link) {
      try {
        return new URL(link.getAttribute("href"), root.location?.href || "").searchParams.get("sh") || "";
      } catch {
        return "";
      }
    }
    return "";
  }

  function pageCsrfToken() {
    return root.document?.querySelector?.('meta[name="csrf-token"]')?.getAttribute("content") || "";
  }

  function reportsUrl(credentials = readPageCredentials()) {
    if (!credentials.origin || !credentials.sh) return "";
    return `${credentials.origin}${GAME_PATH}index.php?mod=reports&sh=${encodeURIComponent(credentials.sh)}`;
  }

  // --- Firing the fight (page environment) --------------------------------

  async function fight(target, credentials = readPageCredentials()) {
    const { url, options } = buildFightRequest(target, credentials);
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`Fight request failed with HTTP ${response.status}.`);
    const body = await response.text();
    return {
      ok: true,
      name: target.name,
      body,
      reportsUrl: reportsUrl(credentials)
    };
  }

  async function loadBestTarget(kind) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
    const stored = await chrome.storage.local.get(ARENA.passiveScansStorageKey);
    const result = stored?.[ARENA.passiveScansStorageKey]?.[kind]?.result;
    return bestTargetFromResult(result);
  }

  root.GladiatusArenaFight = {
    bestTargetFromResult,
    fightEndpoint,
    buildFightRequest,
    readPageCredentials,
    reportsUrl,
    fight,
    loadBestTarget
  };
})();
