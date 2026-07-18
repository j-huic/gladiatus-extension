// Neutral Gladiatus tooltip decoding shared by auction and guild-market code.
// Load this module before any feature core that consumes tooltip data.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const VERSION = "tooltip-parser-v1";

  if (root.GladiatusTooltipParser?.version === VERSION) return;

  function decodeHtml(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code) || 0));
  }

  function stripHtml(value, doc = root.document || null) {
    if (doc?.createElement) {
      const scratch = doc.createElement("div");
      scratch.innerHTML = String(value || "");
      return (scratch.textContent || scratch.innerText || "").replace(/\s+/g, " ").trim();
    }

    return decodeHtml(String(value || "")
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseItemTooltipFromValue(raw) {
    if (!raw) return [];

    try {
      const tooltip = JSON.parse(raw);
      return Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
    } catch (_error) {
      return [];
    }
  }

  function parseTooltipLinesFromValue(raw, doc = root.document || null) {
    return parseItemTooltipFromValue(raw)
      .map((entry) => stripHtml(Array.isArray(entry) ? entry[0] : entry, doc))
      .filter(Boolean);
  }

  root.GladiatusTooltipParser = Object.freeze({
    version: VERSION,
    decodeHtml,
    stripHtml,
    parseItemTooltipFromValue,
    parseTooltipLinesFromValue,
    parseLinesFromValue: parseTooltipLinesFromValue
  });
})();
