// Explicit, user-triggered Arena/Circus fight requests for the private full build.
// This module is UI-agnostic; arena-header-button.js owns the clickable controls.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || root.GladiatusArenaFight) return;

  const GAME_PATH = "/game/";

  function bestTargetFromResult(result) {
    if (!result || !Array.isArray(result.opponents) || !result.opponents.length) return null;

    const best = findOpponentByName(result.opponents, result.bestName);
    if (!best) return null;

    const opponent = best.opponent || {};
    const request = fightEndpoint(opponent, result.sourceUrl);
    if (!request) return null;

    const winRate = best.simulation?.ready
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

  function buildFightRequest(target, credentials) {
    if (!target?.request) throw new Error("No opponent selected to fight.");
    if (!credentials?.origin) throw new Error("Could not determine the game origin.");
    if (!isAllowedGameOrigin(credentials.origin)) throw new Error("Fight requests are limited to Gladiatus Gameforge pages.");
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

  function isAllowedGameOrigin(value) {
    try {
      const url = new URL(String(value || ""));
      return url.protocol === "https:"
        && url.port === ""
        && url.username === ""
        && url.password === ""
        && url.hostname.endsWith(".gladiatus.gameforge.com");
    } catch {
      return false;
    }
  }

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
      // Fall through to a signed page link.
    }
    const link = root.document?.querySelector?.('a[href*="sh="]');
    if (!link) return "";
    try {
      return new URL(link.getAttribute("href"), root.location?.href || "").searchParams.get("sh") || "";
    } catch {
      return "";
    }
  }

  function pageCsrfToken() {
    return root.document?.querySelector?.('meta[name="csrf-token"]')?.getAttribute("content") || "";
  }

  function reportsUrl(credentials = readPageCredentials()) {
    if (!credentials.origin || !credentials.sh || !isAllowedGameOrigin(credentials.origin)) return "";
    return `${credentials.origin}${GAME_PATH}index.php?mod=reports&sh=${encodeURIComponent(credentials.sh)}`;
  }

  function parseFightError(body) {
    const text = String(body || "");
    if (!/errorRow|errorText/.test(text)) return "";
    const match = text.match(/errorText'\)\.innerHTML\s*=\s*'([\s\S]*?)';/);
    const message = (match ? match[1] : "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\\'/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    return message || "The game rejected the fight (you may be on cooldown).";
  }

  function combatReportUrlFromResponse(body, credentials = readPageCredentials()) {
    if (!credentials.origin || !isAllowedGameOrigin(credentials.origin)) return "";
    const match = String(body || "").match(/location\.href\s*=\s*(['"])([^'"]*showCombatReport[^'"]*)\1/i);
    if (!match) return "";
    try {
      const url = new URL(match[2].replace(/&amp;/g, "&"), `${credentials.origin}${GAME_PATH}`);
      if (url.origin !== credentials.origin || !url.pathname.startsWith(GAME_PATH)) return "";
      if (credentials.sh && !url.searchParams.get("sh")) url.searchParams.set("sh", credentials.sh);
      return url.href;
    } catch {
      return "";
    }
  }

  async function fight(target, credentials = readPageCredentials()) {
    const { url, options } = buildFightRequest(target, credentials);
    const response = await root.fetch(url, options);
    if (!response.ok) throw new Error(`Fight request failed with HTTP ${response.status}.`);
    const body = await response.text();
    const error = parseFightError(body);
    if (error) throw new Error(error);

    const listUrl = reportsUrl(credentials);
    return {
      ok: true,
      name: target.name,
      body,
      reportUrl: combatReportUrlFromResponse(body, credentials) || listUrl,
      reportsUrl: listUrl
    };
  }

  async function loadBestTarget(kind) {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return null;
    const stored = await chrome.storage.local.get(ARENA.passiveScansStorageKey);
    const result = stored?.[ARENA.passiveScansStorageKey]?.[kind]?.result;
    return bestTargetFromResult(result);
  }

  root.GladiatusArenaFight = Object.freeze({
    bestTargetFromResult,
    fightEndpoint,
    buildFightRequest,
    readPageCredentials,
    reportsUrl,
    parseFightError,
    combatReportUrlFromResponse,
    fight,
    loadBestTarget
  });
})();
