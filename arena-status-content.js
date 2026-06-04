(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || typeof chrome === "undefined" || !chrome.storage?.local) return;

  if (root.__GladiatusArenaStatusContentLoaded) {
    root.__GladiatusArenaStatusContentBoot?.();
    return;
  }
  root.__GladiatusArenaStatusContentLoaded = true;

  const STATUS_BOX_ID = "glad-arena-passive-status";
  const STATUS_KINDS = ["single", "team"];
  let restoreTimer = 0;

  function isGladiatusGamePage(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.startsWith("/game/");
    } catch {
      return false;
    }
  }

  function bootStatusContent() {
    if (!shouldRenderStatusBox()) {
      removeStatusBox();
      return;
    }

    const boot = () => {
      ensureStatusBox();
      subscribeToStatusChanges();
      refreshStatusBox().catch(() => {});
      observeStatusHost();
    };

    if (root.document?.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
      root.setTimeout(boot, 0);
    }
  }
  root.__GladiatusArenaStatusContentBoot = bootStatusContent;

  function shouldRenderStatusBox(url = root.location?.href || "") {
    return isGladiatusGamePage(url);
  }

  function removeStatusBox() {
    root.document?.getElementById?.(STATUS_BOX_ID)?.remove();
  }

  async function refreshStatusBox() {
    if (!shouldRenderStatusBox()) {
      removeStatusBox();
      return;
    }
    const stored = await chrome.storage.local.get(ARENA.scanStatusStorageKey);
    renderStatusBox(stored[ARENA.scanStatusStorageKey]);
  }

  function ensureStatusBox() {
    if (!shouldRenderStatusBox()) {
      removeStatusBox();
      return null;
    }
    const existing = root.document?.getElementById?.(STATUS_BOX_ID);
    if (existing) return existing;

    const panel = root.document.createElement("div");
    panel.id = STATUS_BOX_ID;
    panel.setAttribute("aria-live", "polite");
    panel.setAttribute("aria-label", "Arena and Circus scan status");
    insertStatusBox(panel);
    return panel;
  }

  function insertStatusBox(panel) {
    const menu = findMenuAnchor();
    if (menu?.parentElement) {
      menu.after(panel);
      return;
    }

    const content = root.document.getElementById("content") || root.document.querySelector("#content");
    if (content?.parentElement) {
      content.before(panel);
      return;
    }

    root.document.body?.prepend(panel);
  }

  function findMenuAnchor() {
    const byText = findMenuAnchorByText();
    if (byText) return byText;

    const selectors = ["#mainmenu", ".mainmenu", "#menu", ".menu", "nav", "#submenu", ".submenu"];
    for (const selector of selectors) {
      const element = root.document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  function findMenuAnchorByText() {
    const candidates = Array.from(root.document.querySelectorAll("div, td, nav, ul"));
    return candidates
      .filter((element) => menuScore(element) >= 3)
      .sort((a, b) => a.textContent.length - b.textContent.length)[0] || null;
  }

  function menuScore(element) {
    const text = String(element?.textContent || "").replace(/\s+/g, " ").toLowerCase();
    return ["overview", "pantheon", "guild", "high score", "recruiting"]
      .reduce((score, label) => score + (text.includes(label) ? 1 : 0), 0);
  }

  function subscribeToStatusChanges() {
    if (!chrome.storage?.onChanged || root.__GladiatusArenaStatusBoxListener) return;
    root.__GladiatusArenaStatusBoxListener = (changes, areaName) => {
      if (areaName !== "local" || !changes[ARENA.scanStatusStorageKey]) return;
      renderStatusBox(changes[ARENA.scanStatusStorageKey].newValue);
    };
    chrome.storage.onChanged.addListener(root.__GladiatusArenaStatusBoxListener);
  }

  function observeStatusHost() {
    if (!root.MutationObserver || !root.document?.documentElement || root.__GladiatusArenaStatusRestoreObserver) return;
    root.__GladiatusArenaStatusRestoreObserver = new root.MutationObserver(() => {
      if (root.document?.getElementById?.(STATUS_BOX_ID)) return;
      scheduleStatusRestore();
    });
    root.__GladiatusArenaStatusRestoreObserver.observe(root.document.documentElement, { childList: true, subtree: true });
  }

  function scheduleStatusRestore() {
    root.clearTimeout(restoreTimer);
    restoreTimer = root.setTimeout(() => {
      refreshStatusBox().catch(() => {});
    }, 150);
  }

  function renderStatusBox(rawStatus) {
    if (!shouldRenderStatusBox()) {
      removeStatusBox();
      return;
    }
    const panel = ensureStatusBox();
    if (!panel) return;

    const status = normalizeStatusCache(rawStatus);
    panel.replaceChildren(...STATUS_KINDS.map((kind) => renderStatusRow(kind, status[kind])));
  }

  function renderStatusRow(kind, record) {
    const row = root.document.createElement("div");
    row.className = `glad-arena-passive-status-row glad-arena-passive-status-${record.state}`;

    const label = root.document.createElement("strong");
    label.textContent = kind === "team" ? "Circus" : "Arena";

    const badge = root.document.createElement("span");
    badge.className = "glad-arena-passive-status-badge";
    badge.textContent = statusBadgeText(record);

    const text = root.document.createElement("span");
    text.className = "glad-arena-passive-status-message";
    text.textContent = statusText(kind, record);

    row.append(label, badge, text);
    return row;
  }

  function normalizeStatusCache(status) {
    const source = status && typeof status === "object" ? status : {};
    return {
      single: normalizeStatusRecord(source.single, "single"),
      team: normalizeStatusRecord(source.team, "team")
    };
  }

  function normalizeStatusRecord(record, kind) {
    const source = record && typeof record === "object" ? record : {};
    return {
      kind,
      state: String(source.state || "unknown"),
      message: String(source.message || ""),
      updatedAt: String(source.updatedAt || ""),
      checkedAt: String(source.checkedAt || ""),
      scannedAt: String(source.scannedAt || ""),
      opponentDone: ARENA.parseInteger(source.opponentDone),
      opponentTotal: ARENA.parseInteger(source.opponentTotal),
      profileDone: ARENA.parseInteger(source.profileDone),
      profileTotal: ARENA.parseInteger(source.profileTotal),
      lastError: String(source.lastError || "")
    };
  }

  function statusText(kind, record) {
    if (record.state === "scanning") {
      if (isStaleStatus(record)) return "Previous scan stale - next trigger will retry";
      if (record.profileTotal) {
        return `Profiles ${record.profileDone}/${record.profileTotal} - opponents ${record.opponentDone}/${record.opponentTotal}`;
      }
      return cleanStatusMessage(record.message || "Scan in progress");
    }

    if (record.state === "checking") return cleanStatusMessage(record.message || "Checking opponent list");

    if (record.state === "ready") {
      const age = formatAge(record.scannedAt);
      const message = cleanStatusMessage(record.message || "Ready");
      if (!age) return message;
      return age === "just now" ? `${message} - scanned just now` : `${message} - scanned ${age} ago`;
    }

    if (record.state === "error") {
      return record.lastError
        ? `${cleanStatusMessage(record.message || "Error")} - ${shortError(record.lastError)}`
        : cleanStatusMessage(record.message || "Error");
    }

    if (record.state === "skipped") return cleanStatusMessage(record.message || "Skipped");

    return kind === "team" ? "No Circus list URL yet" : "No Arena list URL yet";
  }

  function statusBadgeText(record) {
    if (record.state === "ready") return "Ready";
    if (record.state === "checking") return "Check";
    if (record.state === "scanning") return "Run";
    if (record.state === "error") return "Error";
    if (record.state === "skipped") return "Skip";
    return "Idle";
  }

  function cleanStatusMessage(message) {
    return String(message || "")
      .replace(/^Ready,\s*/i, "")
      .replace(/^Checked opponent list:\s*/i, "List: ")
      .replace(/^Checking Arena scan cache$/i, "Checking cache")
      .replace(/^Checking Circus scan cache$/i, "Checking cache")
      .replace(/^Scan already running$/i, "Scan in progress")
      .trim() || "Ready";
  }

  function isStaleStatus(record) {
    if (record.state !== "scanning") return false;
    const timestamp = Date.parse(record.updatedAt || "");
    return Number.isFinite(timestamp) && Date.now() - timestamp > 5 * 60 * 1000;
  }

  function formatAge(isoDate) {
    const timestamp = Date.parse(isoDate || "");
    if (!Number.isFinite(timestamp)) return "";
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  function shortError(message) {
    const text = String(message || "").replace(/\s+/g, " ").trim();
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  }

  bootStatusContent();
})();
