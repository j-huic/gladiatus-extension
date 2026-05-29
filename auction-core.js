(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const pageDocument = root.document || null;
  const CORE_VERSION = "auction-core-v3";
  const PAGE_BRIDGE_REQUEST_SOURCE = "glad-ah-extension-v3";
  const PAGE_BRIDGE_RESPONSE_SOURCE = "glad-ah-page-v3";
  const SCHEMA = root.GladiatusAuctionSchema;
  if (!SCHEMA) {
    if (!isAuctionPageUrl(root.document?.location?.href || root.location?.href || "")) return;
    throw new Error("GladiatusAuctionSchema must load before GladiatusAuctionCore.");
  }

  if (root.GladiatusAuctionCore?.version === CORE_VERSION) {
    if (shouldInstallPageBridge()) {
      installPageBridge(root.GladiatusAuctionCore);
    }
    return;
  }

  const CARD_SELECTOR = "form[id^='auctionForm']";
  const STAT_NAMES = SCHEMA.tooltipStatNames;
  const MAIN_SCAN_TYPES = SCHEMA.mainScanCategories;
  const MERCENARY_EQUIPMENT_SCAN_TYPES = SCHEMA.mercenaryEquipmentScanCategories;

  // Page and tooltip parsing
  function isAuctionPage(doc = pageDocument) {
    return isAuctionPageUrl(doc?.location?.href || root.location?.href || "");
  }

  function isAuctionPageUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "auction";
    } catch {
      return false;
    }
  }

  function keyForStat(name) {
    return SCHEMA.keyForTooltipStat(name);
  }

  function stripHtml(value, doc = pageDocument) {
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

  function parseInteger(value) {
    const normalized = String(value || "").replace(/[^\d-]/g, "");
    const parsed = Number.parseInt(normalized, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function primaryTooltipSegment(line) {
    return String(line || "").split(",")[0];
  }

  function parseSignedBonus(line) {
    const segment = primaryTooltipSegment(line);
    const parenthesized = segment.match(/\(([+-]?\d+)\)/g) || [];
    if (parenthesized.length) {
      return parenthesized.reduce((total, match) => total + (Number.parseInt(match.replace(/[()]/g, ""), 10) || 0), 0);
    }

    const directValues = segment.match(/[+-]\d+(?:\s*%)?/g) || [];
    return directValues
      .filter((match) => !/%/.test(match))
      .reduce((total, match) => total + (Number.parseInt(match, 10) || 0), 0);
  }

  function parseDamageRange(line) {
    const segment = primaryTooltipSegment(line);
    const rangePattern = /([+-]?\d+)\s*-\s*([+-]?\d+)/g;
    const total = { min: 0, max: 0, count: 0 };
    let match = rangePattern.exec(segment);

    while (match) {
      total.min += Number.parseInt(match[1], 10) || 0;
      total.max += Number.parseInt(match[2], 10) || 0;
      total.count += 1;
      match = rangePattern.exec(segment);
    }

    return total.count ? { min: total.min, max: total.max } : null;
  }

  function parseTooltipLines(icon, doc = icon.ownerDocument || pageDocument) {
    const raw = icon.dataset?.tooltip || icon.getAttribute("data-tooltip") || "";
    return parseTooltipLinesFromValue(raw, doc);
  }

  function parseTooltipLinesFromValue(raw, doc = pageDocument) {
    if (!raw) return [];

    try {
      const tooltip = JSON.parse(raw);
      const itemLines = Array.isArray(tooltip) && Array.isArray(tooltip[0]) ? tooltip[0] : [];
      return itemLines
        .map((entry) => stripHtml(Array.isArray(entry) ? entry[0] : entry, doc))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function parseStats(lines) {
    const stats = {};
    let level = 0;
    let itemValue = 0;

    for (const line of lines) {
      const foodHealing = parseFoodHealingText(line);
      if (foodHealing) {
        stats.foodHealing = (stats.foodHealing || 0) + foodHealing;
        continue;
      }

      const damageRange = line.match(/^Damage\s+(.+)/i);
      if (damageRange) {
        const range = parseDamageRange(damageRange[1]);
        if (range) {
          stats.damageMin = range.min;
          stats.damageMax = range.max;
          stats.damageAvg = (range.min + range.max) / 2;
        } else {
          stats.damageBonus = (stats.damageBonus || 0) + parseSignedBonus(damageRange[1]);
        }
        continue;
      }

      const usingBonus = line.match(/^Using:\s+(.+)$/i);
      if (usingBonus) {
        parseUsingBonus(usingBonus[1], stats);
        continue;
      }

      const levelMatch = line.match(/^Level\s+(\d+)/i);
      if (levelMatch) {
        level = Number.parseInt(levelMatch[1], 10) || 0;
        continue;
      }

      const valueMatch = line.match(/^Value\s+([\d.,]+)/i);
      if (valueMatch) {
        itemValue = parseInteger(valueMatch[1]);
        continue;
      }

      for (const statName of STAT_NAMES) {
        const statPattern = new RegExp(`^${escapeRegExp(statName)}\\b\\s*:?`, "i");
        if (statPattern.test(line)) {
          const key = keyForStat(statName);
          stats[key] = (stats[key] || 0) + parseStatValue(statName, line);
          break;
        }
      }
    }

    return { stats, level, itemValue };
  }

  function parseStatValue(statName, line) {
    const absolute = line.match(new RegExp(`^${escapeRegExp(statName)}\\s*:\\s*([+-]?\\d+)`, "i"));
    if (absolute) {
      return Number.parseInt(absolute[1], 10) || 0;
    }

    return parseSignedBonus(line);
  }

  function parseUsingBonus(text, stats) {
    const foodHealing = parseFoodHealingText(text);
    if (foodHealing) {
      stats.foodHealing = (stats.foodHealing || 0) + foodHealing;
      return;
    }

    for (const statName of STAT_NAMES) {
      const statPattern = new RegExp(`\\b${escapeRegExp(statName)}\\b`, "i");
      if (!statPattern.test(text)) continue;

      const key = statName.toLowerCase() === "damage" ? "damageBonus" : keyForStat(statName);
      stats[key] = (stats[key] || 0) + parseSignedBonus(text);
      return;
    }
  }

  function parseFoodHealingText(text) {
    const healingMatch = String(text || "").match(/^(?:Using:\s*)?Heals\s+([\d.,]+)\s+(?:of\s+)?life\b/i);
    return healingMatch ? parseInteger(healingMatch[1]) : 0;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getFilterForm(doc = pageDocument) {
    return Array.from(doc?.querySelectorAll?.("#content form, form") || [])
      .find((form) => form.querySelector("select[name='itemType']"));
  }

  function getAuctionId(form, fallbackIndex) {
    const input = form.querySelector("input[name='auctionid']");
    return input && input.value ? input.value : String(fallbackIndex);
  }

  function readSharedFilterValues(form) {
    const valueOf = (selector, fallback = "") => form.querySelector(selector)?.value ?? fallback;

    return {
      qry: valueOf("input[name='qry']"),
      itemLevel: valueOf("select[name='itemLevel']", "39"),
      itemQuality: valueOf("select[name='itemQuality']", "-1"),
      csrfToken: valueOf("input[name='csrf_token']")
    };
  }

  function readFormFields(form) {
    if (typeof FormData === "undefined") return [];
    return Array.from(new FormData(form).entries())
      .map(([name, value]) => [String(name), String(value)]);
  }

  function createAuctionScanRequest(doc = pageDocument) {
    if (!isAuctionPage(doc)) {
      throw new Error("Open a Gladiatus auction page before scanning.");
    }

    const filterForm = getFilterForm(doc);
    if (!filterForm) {
      throw new Error("Could not find the auction filter form.");
    }

    const sourceUrl = doc?.location?.href || root.location?.href || "";
    const sharedFilters = readSharedFilterValues(filterForm);
    const formFields = readFormFields(filterForm);

    return {
      sourceUrl,
      requestedAt: new Date().toISOString(),
      sharedFilters,
      formFields,
      sources: [
        {
          label: "Gladiator necessities",
          url: findAuctionTypeUrl(doc, /gladiator/i, "", sourceUrl),
          categories: MAIN_SCAN_TYPES
        },
        {
          label: "Mercenary necessities",
          url: findAuctionTypeUrl(doc, /mercenary/i, "3", sourceUrl),
          categories: MERCENARY_EQUIPMENT_SCAN_TYPES
        }
      ]
    };
  }

  function makeAuctionUrl(ttype, baseHref = root.location?.href || pageDocument?.location?.href || "") {
    const url = new URL(baseHref);
    url.searchParams.set("mod", "auction");
    url.searchParams.delete("submod");

    if (ttype) {
      url.searchParams.set("ttype", ttype);
    } else {
      url.searchParams.delete("ttype");
    }

    return url.href;
  }

  function findAuctionTypeUrl(doc, labelPattern, fallbackTtype, baseHref = doc?.location?.href || root.location?.href || "") {
    const links = Array.from(doc?.querySelectorAll?.("a[href]") || [])
      .map((link) => {
        try {
          return {
            href: new URL(link.getAttribute("href"), baseHref).href,
            text: stripHtml(link.textContent || "", doc)
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((link) => {
        try {
          return new URL(link.href).searchParams.get("mod") === "auction";
        } catch {
          return false;
        }
      });

    const labelled = links.find((link) => labelPattern.test(link.text));
    if (labelled) return labelled.href;

    const byTtype = links.find((link) => new URL(link.href).searchParams.get("ttype") === fallbackTtype);
    if (byTtype) return byTtype.href;

    return makeAuctionUrl(fallbackTtype || "", baseHref);
  }

  function isCurrentDocumentUrl(url) {
    try {
      const baseHref = root.location?.href || pageDocument?.location?.href || "";
      const current = new URL(baseHref);
      const candidate = new URL(url, baseHref);
      current.hash = "";
      candidate.hash = "";
      return current.href === candidate.href;
    } catch {
      return false;
    }
  }

  function makeFilterBody(form, itemType, sharedFilters) {
    const body = new URLSearchParams(new FormData(form));
    body.set("itemType", itemType);
    body.set("qry", sharedFilters.qry || "");
    body.set("itemLevel", sharedFilters.itemLevel || "39");
    body.set("itemQuality", sharedFilters.itemQuality || "-1");
    if (sharedFilters.csrfToken && !body.has("csrf_token")) {
      body.set("csrf_token", sharedFilters.csrfToken);
    }
    return body;
  }

  // Scan orchestration and page loading
  async function scanAllAuctionItems() {
    if (!isAuctionPage()) {
      throw new Error("Open a Gladiatus auction page before scanning.");
    }

    const filterForm = getFilterForm(pageDocument);
    if (!filterForm) {
      throw new Error("Could not find the auction filter form.");
    }

    const sharedFilters = readSharedFilterValues(filterForm);
    const items = [];
    const scannedCategories = [];
    const scannedCategoryIds = [];
    const scanWarnings = [];
    const scanSources = await resolveAuctionScanSources(scanWarnings);

    for (const source of scanSources) {
      if (!source.form) {
        scanWarnings.push(`Could not find ${source.label} filter form.`);
        continue;
      }

      for (const category of source.categories) {
        try {
          const doc = await loadFilteredAuctionDocument(source.url, source.form, category.itemType, sharedFilters);
          scannedCategories.push(category.label);
          scannedCategoryIds.push(category.id);
          items.push(...parseAuctionItemsFromDocument(doc, {
            categoryId: category.id
          }));
        } catch (error) {
          scanWarnings.push(`${category.label}: ${error.message || String(error)}`);
        }
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      parserVersion: CORE_VERSION,
      categoriesScanned: scannedCategories.length,
      categoryIdsScanned: scannedCategoryIds,
      scanWarnings,
      filterSummary: formatFilterSummary(sharedFilters),
      items: sortScannedItems(items)
    };
  }

  async function resolveAuctionScanSources(scanWarnings) {
    const mainUrl = findAuctionTypeUrl(pageDocument, /gladiator/i, "");
    const mercenaryUrl = findAuctionTypeUrl(pageDocument, /mercenary/i, "3");

    return [
      await resolveAuctionScanSource({
        label: "Gladiator necessities",
        url: mainUrl,
        categories: MAIN_SCAN_TYPES,
        scanWarnings
      }),
      await resolveAuctionScanSource({
        label: "Mercenary necessities",
        url: mercenaryUrl,
        categories: MERCENARY_EQUIPMENT_SCAN_TYPES,
        scanWarnings
      })
    ];
  }

  async function resolveAuctionScanSource({ label, url, categories, scanWarnings }) {
    try {
      const doc = isCurrentDocumentUrl(url) ? pageDocument : await loadAuctionDocument(url);
      return {
        label,
        url,
        categories,
        form: getFilterForm(doc)
      };
    } catch (error) {
      scanWarnings.push(`${label}: ${error.message || String(error)}`);
      return { label, url, categories, form: null };
    }
  }

  async function loadFilteredAuctionDocument(url, form, itemType, sharedFilters) {
    const body = makeFilterBody(form, itemType, sharedFilters);

    try {
      return await fetchDocument(url, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
    } catch {
      return await loadDocumentViaForm(url, body, "POST");
    }
  }

  async function loadAuctionDocument(url) {
    try {
      return await fetchDocument(url, { credentials: "same-origin" });
    } catch {
      return await loadDocumentViaFrame(url);
    }
  }

  async function fetchDocument(url, options) {
    if (typeof root.fetch !== "function" || typeof root.DOMParser !== "function") {
      throw new Error("Auction document loading needs a browser page context.");
    }

    const response = await root.fetch(url, options);
    if (!response.ok) {
      throw new Error(`Auction fetch failed with HTTP ${response.status}.`);
    }

    return new root.DOMParser().parseFromString(await response.text(), "text/html");
  }

  function loadDocumentViaFrame(url) {
    if (!pageDocument) return Promise.reject(new Error("Auction iframe loading needs a page document."));
    return new Promise((resolve, reject) => {
      const iframe = makeHiddenFrame();
      const timeout = root.setTimeout(() => {
        cleanupFrame(iframe);
        reject(new Error("Auction iframe load timed out."));
      }, 20000);

      iframe.addEventListener("load", () => {
        root.clearTimeout(timeout);
        try {
          resolve(copyFrameDocument(iframe));
        } catch (error) {
          reject(error);
        } finally {
          cleanupFrame(iframe);
        }
      }, { once: true });

      iframe.src = url;
      pageDocument.documentElement.append(iframe);
    });
  }

  function loadDocumentViaForm(url, body, method) {
    if (!pageDocument) return Promise.reject(new Error("Auction form loading needs a page document."));
    return new Promise((resolve, reject) => {
      const iframe = makeHiddenFrame();
      const form = pageDocument.createElement("form");
      const timeout = root.setTimeout(() => {
        cleanupFrame(iframe, form);
        reject(new Error("Auction form load timed out."));
      }, 20000);

      iframe.addEventListener("load", () => {
        root.clearTimeout(timeout);
        try {
          resolve(copyFrameDocument(iframe));
        } catch (error) {
          reject(error);
        } finally {
          cleanupFrame(iframe, form);
        }
      }, { once: true });

      form.method = method;
      form.action = url;
      form.target = iframe.name;
      form.style.display = "none";

      for (const [name, value] of body.entries()) {
        const input = pageDocument.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.append(input);
      }

      pageDocument.documentElement.append(iframe, form);
      form.submit();
    });
  }

  function makeHiddenFrame() {
    const iframe = pageDocument.createElement("iframe");
    iframe.name = `glad-ah-scan-frame-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    iframe.style.cssText = "display:none !important;width:0;height:0;border:0;";
    return iframe;
  }

  function copyFrameDocument(iframe) {
    const doc = iframe.contentDocument;
    if (!doc || !doc.documentElement) {
      throw new Error("Could not read the loaded auction document.");
    }

    return new root.DOMParser().parseFromString(doc.documentElement.outerHTML, "text/html");
  }

  function cleanupFrame(iframe, form) {
    iframe.remove();
    if (form) form.remove();
  }

  // DOM extraction and normalized item records
  function normalizeItemMeta(meta = {}) {
    const category = meta.categoryId
      ? SCHEMA.getScanCategory(meta.categoryId)
      : SCHEMA.getCategoryForItemType(meta.itemType, meta.ttype);
    const itemType = String(meta.itemType || category?.itemType || "");

    return {
      categoryId: String(meta.categoryId || category?.id || ""),
      viewId: String(meta.viewId || category?.viewId || SCHEMA.defaultViewIdForItemType(itemType)),
      category: String(meta.category || category?.label || ""),
      group: String(meta.group || category?.group || ""),
      itemType,
      ttype: String(meta.ttype || category?.ttype || "")
    };
  }

  function parseAuctionItemFromForm(form, index = 0, meta = {}) {
    const icon = form.querySelector("[data-tooltip]");
    if (!icon) return null;

    const itemMeta = normalizeItemMeta(meta);
    const lines = parseTooltipLines(icon, form.ownerDocument || icon.ownerDocument || pageDocument);
    const parsed = parseStats(lines);

    return {
      auctionId: getAuctionId(form, index),
      categoryId: itemMeta.categoryId,
      viewId: itemMeta.viewId,
      category: itemMeta.category,
      group: itemMeta.group,
      itemType: itemMeta.itemType,
      ttype: itemMeta.ttype,
      name: lines[0] || "Unknown item",
      priceGold: parseInteger(icon.dataset?.priceGold || icon.getAttribute("data-price-gold")),
      bidAmount: parseInteger(form.querySelector("input[name='bid_amount']")?.value),
      contentType: icon.getAttribute("data-content-type") || "",
      basis: icon.getAttribute("data-basis") || "",
      itemClass: icon.className || "",
      imageSrc: readIconImageSrc(icon),
      imageStyle: icon.getAttribute("style") || "",
      lines,
      parserVersion: CORE_VERSION,
      level: parsed.level,
      itemValue: parsed.itemValue,
      stats: parsed.stats
    };
  }

  function parseAuctionItemsFromDocument(doc, meta = {}) {
    return Array.from(doc.querySelectorAll(CARD_SELECTOR))
      .map((form, index) => parseAuctionItemFromForm(form, index, meta))
      .filter(Boolean);
  }

  function parseAuctionItemsFromHtml(html, meta = {}) {
    return readAuctionFormHtmls(html)
      .map((formHtml, index) => parseAuctionItemFromHtmlForm(formHtml, index, meta))
      .filter(Boolean);
  }

  function parseAuctionItemFromHtmlForm(formHtml, index = 0, meta = {}) {
    const iconTag = readFirstTagWithAttribute(formHtml, "data-tooltip");
    if (!iconTag) return null;

    const itemMeta = normalizeItemMeta(meta);
    const lines = parseTooltipLinesFromValue(readHtmlAttribute(iconTag, "data-tooltip"));
    const parsed = parseStats(lines);

    return {
      auctionId: readInputValueFromHtml(formHtml, "auctionid") || String(index),
      categoryId: itemMeta.categoryId,
      viewId: itemMeta.viewId,
      category: itemMeta.category,
      group: itemMeta.group,
      itemType: itemMeta.itemType,
      ttype: itemMeta.ttype,
      name: lines[0] || "Unknown item",
      priceGold: parseInteger(readHtmlAttribute(iconTag, "data-price-gold")),
      bidAmount: parseInteger(readInputValueFromHtml(formHtml, "bid_amount")),
      contentType: readHtmlAttribute(iconTag, "data-content-type"),
      basis: readHtmlAttribute(iconTag, "data-basis"),
      itemClass: readHtmlAttribute(iconTag, "class"),
      imageSrc: readIconImageSrcFromHtml(formHtml),
      imageStyle: readHtmlAttribute(iconTag, "style"),
      lines,
      parserVersion: CORE_VERSION,
      level: parsed.level,
      itemValue: parsed.itemValue,
      stats: parsed.stats
    };
  }

  function readIconImageSrc(icon) {
    const image = icon.querySelector("img");
    if (image?.src) return image.src;

    const style = icon.getAttribute("style") || "";
    const backgroundImage = style.match(/background-image\s*:\s*url\((['"]?)(.*?)\1\)/i);
    return backgroundImage?.[2] || "";
  }

  function readIconImageSrcFromHtml(formHtml) {
    const imageTag = String(formHtml || "").match(/<img\b[^>]*>/i)?.[0] || "";
    return readHtmlAttribute(imageTag, "src");
  }

  function readAuctionFormHtmls(html) {
    const forms = [];
    const pattern = /<form\b[^>]*\bid\s*=\s*(["'])auctionForm[^"']*\1[^>]*>[\s\S]*?<\/form>/gi;
    for (const match of String(html || "").matchAll(pattern)) {
      forms.push(match[0]);
    }
    return forms;
  }

  function readFirstTagWithAttribute(html, attribute) {
    const attrPattern = new RegExp(`\\b${escapeRegExp(attribute)}\\s*=`, "i");
    for (const tag of readHtmlTags(html)) {
      if (attrPattern.test(tag)) return tag;
    }
    return "";
  }

  function readHtmlTags(html) {
    const source = String(html || "");
    const tags = [];
    let index = 0;

    while (index < source.length) {
      const start = source.indexOf("<", index);
      if (start === -1) break;

      let quote = "";
      let end = start + 1;
      while (end < source.length) {
        const char = source[end];
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === "\"" || char === "'") {
          quote = char;
        } else if (char === ">") {
          end += 1;
          break;
        }
        end += 1;
      }

      tags.push(source.slice(start, end));
      index = end;
    }

    return tags;
  }

  function readInputValueFromHtml(html, name) {
    const inputPattern = /<input\b[^>]*>/gi;
    for (const match of String(html || "").matchAll(inputPattern)) {
      const tag = match[0];
      if (readHtmlAttribute(tag, "name") === name) return readHtmlAttribute(tag, "value");
    }
    return "";
  }

  function readHtmlAttribute(value, attribute) {
    const pattern = new RegExp(`${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
    const match = String(value || "").match(pattern);
    return decodeHtml(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
  }

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

  function sortScannedItems(items) {
    const categoryRank = new Map(
      [...MAIN_SCAN_TYPES, ...MERCENARY_EQUIPMENT_SCAN_TYPES]
        .map((category, index) => [category.id, index])
    );

    return items.sort((a, b) => {
      const categoryDiff = (categoryRank.get(a.categoryId) ?? 999) - (categoryRank.get(b.categoryId) ?? 999);
      if (categoryDiff) return categoryDiff;
      if (a.level !== b.level) return a.level - b.level;
      return a.name.localeCompare(b.name);
    });
  }

  function formatFilterSummary(filters) {
    const parts = [
      filters.qry ? `Name: ${filters.qry}` : "",
      filters.itemLevel ? `Minimum level: ${filters.itemLevel}+` : "",
      filters.itemQuality !== undefined ? `Quality: ${qualityLabel(filters.itemQuality)}` : ""
    ].filter(Boolean);

    return parts.length ? `Using current filters: ${parts.join(" | ")}` : "Using current auction filters.";
  }

  function qualityLabel(value) {
    const labels = {
      "-1": "Standard+",
      "0": "Ceres+",
      "1": "Neptune+",
      "2": "Mars+"
    };

    return labels[value] || value;
  }

  const api = {
    version: CORE_VERSION,
    constants: {
      statNames: STAT_NAMES,
      mainScanTypes: MAIN_SCAN_TYPES,
      mercenaryEquipmentScanTypes: MERCENARY_EQUIPMENT_SCAN_TYPES,
      pageBridgeRequestSource: PAGE_BRIDGE_REQUEST_SOURCE,
      pageBridgeResponseSource: PAGE_BRIDGE_RESPONSE_SOURCE
    },
    isAuctionPage,
    createAuctionScanRequest,
    formatFilterSummary,
    makeAuctionUrl,
    parseInteger,
    parseSignedBonus,
    parseDamageRange,
    parseTooltipLines,
    parseTooltipLinesFromValue,
    parseStats,
    normalizeItemMeta,
    parseAuctionItemFromForm,
    parseAuctionItemsFromDocument,
    parseAuctionItemsFromHtml,
    readSharedFilterValues,
    sortScannedItems,
    scanAllAuctionItems
  };

  root.GladiatusAuctionCore = api;

  if (shouldInstallPageBridge()) {
    installPageBridge(api);
  }

  // Page-world bridge
  function shouldInstallPageBridge() {
    if (!pageDocument || typeof root.addEventListener !== "function" || typeof root.postMessage !== "function") return false;
    const hasExtensionRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    return pageDocument.currentScript?.dataset.gladAuctionPageBridge === "1" || !hasExtensionRuntime;
  }

  function installPageBridge(coreApi) {
    if (root.__GladiatusAuctionCoreBridgeVersion === CORE_VERSION) return;
    root.__GladiatusAuctionCoreBridgeInstalled = true;
    root.__GladiatusAuctionCoreBridgeVersion = CORE_VERSION;

    root.addEventListener("message", async (event) => {
      if (event.source !== root || event.data?.source !== PAGE_BRIDGE_REQUEST_SOURCE || !event.data?.id) return;

      const { id, method, args = [] } = event.data;
      try {
        if (typeof coreApi[method] !== "function") {
          throw new Error(`Unknown GladiatusAuctionCore method: ${method}`);
        }

        const result = await coreApi[method](...args);
        root.postMessage({ source: PAGE_BRIDGE_RESPONSE_SOURCE, id, ok: true, result }, "*");
      } catch (error) {
        root.postMessage({ source: PAGE_BRIDGE_RESPONSE_SOURCE, id, ok: false, error: error.message || String(error) }, "*");
      }
    });

    root.postMessage({ source: PAGE_BRIDGE_RESPONSE_SOURCE, type: "ready", version: CORE_VERSION }, "*");
  }
})();
