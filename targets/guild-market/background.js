// Narrow service worker for the standalone Guild Market helper. It has no
// network-request path and only relays lifecycle and explicit price-fill requests to the
// already-loaded MAIN-world bridge on the matching tab.
importScripts("settings.js");

const SETTINGS = self.GladiatusGuildMarketSettings;

chrome.runtime.onInstalled.addListener(() => {
  SETTINGS.get().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isKnownMessage(message)) return false;
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse(errorResponse(error)));
  return true;
});

function isKnownMessage(message) {
  return message?.type === "GLAD_GUILD_MARKET_CONTROL"
    || message?.type === "GLAD_GUILD_MARKET_APPLY";
}

async function getSettings() {
  return SETTINGS.get();
}

async function requireEnabled() {
  const settings = await getSettings();
  if (settings.enabled === true) return settings;
  const error = new Error("Guild Market price suggestions are disabled.");
  error.code = "FEATURE_DISABLED";
  throw error;
}

function validateGuildMarketSender(sender) {
  let parsed;
  try {
    parsed = new URL(sender?.tab?.url || "");
  } catch (_error) {
    parsed = null;
  }
  if (!parsed
    || parsed.protocol !== "https:"
    || !parsed.hostname.endsWith(".gladiatus.gameforge.com")
    || parsed.pathname !== "/game/index.php"
    || parsed.searchParams.get("mod") !== "guildMarket"
    || !Number.isInteger(sender?.tab?.id)) {
    const error = new Error("Guild Market requests must come from the matching Gladiatus page.");
    error.code = "INVALID_SENDER";
    throw error;
  }
  return sender.tab.id;
}

function normalizeApplyRequest(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    requestId: String(raw.requestId || "").slice(0, 100),
    stageId: String(raw.stageId || "").slice(0, 100),
    itemName: String(raw.itemName || "").trim().replace(/\s+/g, " ").slice(0, 200),
    quantity: Number(raw.quantity),
    unitPrice: Number(raw.unitPrice),
    price: Number(raw.price),
    ruleId: String(raw.ruleId || "").slice(0, 100)
  };
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizedItemName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function validateApplyRequest(value, settings) {
  const request = normalizeApplyRequest(value);
  if (!request.requestId || !request.stageId) {
    const error = new Error("The price-fill request is missing its staged-item identity.");
    error.code = "INVALID_REQUEST";
    throw error;
  }
  if (request.ruleId !== "mini-pumpkin"
    || normalizedItemName(request.itemName) !== normalizedItemName(SETTINGS.itemName)) {
    const error = new Error("This release only suggests prices for Mini-Pumpkin.");
    error.code = "INVALID_ITEM";
    throw error;
  }

  const quantity = positiveSafeInteger(request.quantity);
  const unitPrice = positiveSafeInteger(request.unitPrice);
  const price = positiveSafeInteger(request.price);
  const expectedUnitPrice = positiveSafeInteger(settings?.pricePerUnit);
  const expectedTotal = quantity !== null && unitPrice !== null ? quantity * unitPrice : NaN;
  if (quantity === null
    || unitPrice === null
    || price === null
    || expectedUnitPrice === null
    || unitPrice !== expectedUnitPrice
    || !Number.isSafeInteger(expectedTotal)
    || expectedTotal !== price) {
    const error = new Error("The Mini-Pumpkin suggestion no longer matches the saved unit price.");
    error.code = "INVALID_PRICE";
    throw error;
  }
  return request;
}

async function stopAndRethrowDisabled(tabId, expectedUnitPrice = null) {
  let settings;
  try {
    settings = await requireEnabled();
  } catch (error) {
    await runInMain(tabId, "stop", []).catch(() => {});
    throw error;
  }
  if (expectedUnitPrice !== null && settings.pricePerUnit !== expectedUnitPrice) {
    const error = new Error("The saved Mini-Pumpkin unit price changed. Stage the item again.");
    error.code = "STALE_SETTING";
    throw error;
  }
  return settings;
}

async function handleMessage(message, sender) {
  const tabId = validateGuildMarketSender(sender);
  if (message.type === "GLAD_GUILD_MARKET_CONTROL") {
    const action = String(message.action || "");
    if (!["start", "update", "stop"].includes(action)) {
      const error = new Error("Unknown Guild Market lifecycle action.");
      error.code = "INVALID_REQUEST";
      throw error;
    }
    if (action !== "stop") await requireEnabled();
    const result = await runInMain(tabId, action, action === "stop" ? [] : [{ enabled: true }]);
    if (action !== "stop") await stopAndRethrowDisabled(tabId);
    return { ok: true, result };
  }

  if (message.type !== "GLAD_GUILD_MARKET_APPLY") {
    const error = new Error("Unknown extension message.");
    error.code = "UNKNOWN_MESSAGE";
    throw error;
  }
  const settings = await requireEnabled();
  const request = validateApplyRequest(message.request, settings);
  const result = await runInMain(tabId, "applySuggestedPrice", [request]);
  await stopAndRethrowDisabled(tabId, request.unitPrice);
  return { ok: true, result };
}

async function runInMain(tabId, method, args) {
  if (!chrome.scripting?.executeScript) {
    const error = new Error("The Guild Market page bridge is unavailable.");
    error.code = "BRIDGE_UNAVAILABLE";
    throw error;
  }
  const executions = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (methodName, methodArgs) => {
      const api = globalThis.GladiatusGuildMarket;
      if (!api || typeof api[methodName] !== "function") {
        return { ok: false, code: "BRIDGE_UNAVAILABLE", error: "The Guild Market page bridge is unavailable." };
      }
      try {
        return { ok: true, result: api[methodName](...(Array.isArray(methodArgs) ? methodArgs : [])) };
      } catch (error) {
        return { ok: false, code: "BRIDGE_ERROR", error: error?.message || String(error) };
      }
    },
    args: [method, args]
  });
  const payload = executions?.[0]?.result;
  if (payload?.ok) return payload.result;
  const error = new Error(payload?.error || "The Guild Market page bridge did not respond.");
  error.code = payload?.code || "BRIDGE_UNAVAILABLE";
  throw error;
}

function errorResponse(error) {
  return {
    ok: false,
    code: error?.code || "EXTENSION_ERROR",
    error: error?.message || String(error)
  };
}

self.GladiatusGuildMarketBackground = Object.freeze({
  handleMessage,
  isKnownMessage,
  validateGuildMarketSender,
  normalizeApplyRequest,
  validateApplyRequest
});
