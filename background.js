importScripts("log-core.js", "log-buffer.js", "log-setup.js", "auction-schema.js", "auction-core.js", "score-model.js", "arena-core.js", "arena-sim.js", "arena-background-scan.js", "auction-background-scan.js");

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GLAD_DEV_LOG") {
    if (message.record && self.GladiatusLogBuffer) self.GladiatusLogBuffer.append(message.record);
    return false;
  }

  if (message?.type === "GLAD_AUCTION_FORCE_SCAN") {
    log("manual auction scan requested", { url: safeUrl(message.request?.sourceUrl) });
    auctionScanner().forceScan(message.request)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        log("manual auction scan failed", { url: safeUrl(message.request?.sourceUrl), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_AH_REPAIR_AUCTION_CONTENT") {
    repairAuctionContent(_sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message?.type === "GLAD_ARENA_PASSIVE_CHECK") {
    log("passive arena check requested", { url: safeUrl(message.url), delayMs: Number(message.delayMs) || 0, reason: message.reason || "" });
    arenaScanner().schedulePassiveCheck({
      url: message.url,
      preferredKind: message.preferredKind,
      force: Boolean(message.force),
      onlyPreferred: Boolean(message.onlyPreferred),
      delayMs: Number(message.delayMs) || 0,
      reason: message.reason || ""
    })
      .then((results) => sendResponse({ ok: true, results }))
      .catch((error) => {
        log("passive arena check failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_ENSURE_VISIBLE_SCAN") {
    log("visible arena scan ensure requested", { url: safeUrl(message.url), entries: message.entries?.length || 0 });
    arenaScanner().ensureVisibleScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        log("visible arena scan ensure failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FORCE_SCAN") {
    log("manual arena scan requested", { url: safeUrl(message.url), entries: message.entries?.length || 0 });
    arenaScanner().forceScan({
      url: message.url,
      entries: message.entries,
      formula: message.formula
    })
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => {
        log("manual arena scan failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FETCH_PROFILE") {
    log("profile fetch requested", { url: safeUrl(message.url) });
    arenaScanner().fetchProfileHtml(message.url)
      .then((html) => {
        log("profile fetch completed", { url: safeUrl(message.url), bytes: html.length });
        sendResponse({ ok: true, html });
      })
      .catch((error) => {
        log("profile fetch failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_REFRESH_SELF_PROFILE") {
    log("self profile refresh requested", { url: safeUrl(message.profileUrl), force: Boolean(message.force) });
    arenaScanner().refreshSelfProfile({
      profileUrl: message.profileUrl,
      force: Boolean(message.force)
    })
      .then((record) => {
        log("self profile refresh completed", { url: safeUrl(record?.profileUrl), ready: Boolean(record?.character?.combat?.ready) });
        sendResponse({ ok: true, record });
      })
      .catch((error) => {
        log("self profile refresh failed", { url: safeUrl(message.profileUrl), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  if (message?.type === "GLAD_ARENA_FETCH_LIST") {
    log("arena list fetch requested", { url: safeUrl(message.url) });
    arenaScanner().fetchArenaListHtml(message.url)
      .then((html) => {
        log("arena list fetch completed", { url: safeUrl(message.url), bytes: html.length });
        sendResponse({ ok: true, html });
      })
      .catch((error) => {
        log("arena list fetch failed", { url: safeUrl(message.url), error: error.message || String(error) });
        sendResponse({ ok: false, error: error.message || String(error) });
      });

    return true;
  }

  return false;
});

const AUCTION_CONTENT_FILES = [
  "auction-schema.js",
  "score-model.js",
  "auction-model.js",
  "auction-core.js",
  "arena-core.js",
  "arena-sim.js",
  "arena-scan.js",
  "arena-passive-content.js",
  "arena-fight.js",
  "arena-header-button.js",
  "arena-status-content.js",
  "auction-content.js",
  "arena-content.js"
];
const LOG_PREFIX = "[Gladiatus Background]";

async function repairAuctionContent(sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) throw new Error("Cannot repair auction content without a sender tab.");
  if (!chrome.scripting?.executeScript) throw new Error("chrome.scripting is not available.");

  await chrome.scripting.executeScript({
    target: { tabId },
    files: AUCTION_CONTENT_FILES
  });
}

function arenaScanner() {
  if (!self.GladiatusArenaBackgroundScanner) {
    throw new Error("Arena background scanner failed to load.");
  }
  return self.GladiatusArenaBackgroundScanner;
}

function auctionScanner() {
  if (!self.GladiatusAuctionBackgroundScanner) {
    throw new Error("Auction background scanner failed to load.");
  }
  return self.GladiatusAuctionBackgroundScanner;
}

const devLogger = self.GladiatusLog ? self.GladiatusLog.createLogger("background") : null;

function log(message, details = {}) {
  if (devLogger) devLogger.debug(message, details);
  else console.log(LOG_PREFIX, message, details);
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.searchParams.has("sh")) url.searchParams.set("sh", "[redacted]");
    return url.href;
  } catch {
    return String(value || "");
  }
}
