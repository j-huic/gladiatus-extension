(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const SCHEMA = root.GladiatusAuctionSchema;
  const CORE = root.GladiatusAuctionCore;

  if (!SCHEMA || !CORE || root.GladiatusAuctionBackgroundScanner) return;

  const LOG_PREFIX = "[Gladiatus Auction Background Scanner]";
  const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
  let activeScanPromise = null;

  async function forceScan(rawRequest = {}) {
    if (activeScanPromise) return activeScanPromise;

    activeScanPromise = runScan(rawRequest)
      .finally(() => {
        activeScanPromise = null;
      });
    return activeScanPromise;
  }

  async function runScan(rawRequest) {
    const request = normalizeScanRequest(rawRequest);
    log("manual auction scan starting", {
      sourceUrl: safeUrl(request.sourceUrl),
      sources: request.sources.map((source) => source.label)
    });

    const result = await scanRequest(request);
    await saveLastResult(result);
    log("manual auction scan finished", {
      items: result.items.length,
      categoriesScanned: result.categoriesScanned,
      warnings: result.scanWarnings.length
    });
    return result;
  }

  async function scanRequest(request) {
    const items = [];
    const scannedCategories = [];
    const scannedCategoryIds = [];
    const scanWarnings = [];
    const totalCategories = request.sources.reduce((total, source) => total + source.categories.length, 0);
    let completedCategories = 0;

    for (const source of request.sources) {
      for (const category of source.categories) {
        try {
          log("fetch auction category", {
            source: source.label,
            category: category.label,
            itemType: category.itemType,
            ttype: category.ttype,
            url: safeUrl(source.url)
          });
          const html = await fetchFilteredAuctionHtml(source.url, request.formFields, category.itemType, request.sharedFilters);
          const parsedItems = CORE.parseAuctionItemsFromHtml(html, { categoryId: category.id });
          items.push(...parsedItems);
          scannedCategories.push(category.label);
          scannedCategoryIds.push(category.id);
          completedCategories += 1;
          log("parsed auction category", {
            category: category.label,
            itemCount: parsedItems.length,
            progress: `${completedCategories}/${totalCategories}`
          });
        } catch (error) {
          completedCategories += 1;
          scanWarnings.push(`${category.label}: ${error.message || String(error)}`);
          log("auction category failed", {
            category: category.label,
            progress: `${completedCategories}/${totalCategories}`,
            error: error.message || String(error)
          });
        }
      }
    }

    return {
      scannedAt: new Date().toISOString(),
      parserVersion: CORE.version,
      sourceUrl: request.sourceUrl,
      categoriesScanned: scannedCategories.length,
      categoryIdsScanned: scannedCategoryIds,
      scanWarnings,
      filterSummary: CORE.formatFilterSummary(request.sharedFilters),
      items: CORE.sortScannedItems(items)
    };
  }

  async function fetchFilteredAuctionHtml(rawUrl, formFields, itemType, sharedFilters) {
    const url = normalizeAuctionUrl(rawUrl, "Auction category");
    const body = makeFilterBody(formFields, itemType, sharedFilters);
    let lastStatus = 0;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(url.href, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });
      if (response.ok) return response.text();

      lastStatus = response.status;
      if (!RETRYABLE_STATUSES.has(response.status) || attempt === 3) {
        throw new Error(`Auction fetch failed with HTTP ${response.status}.`);
      }

      await delay(500 * (attempt + 1));
    }

    throw new Error(`Auction fetch failed with HTTP ${lastStatus || "unknown"}.`);
  }

  function makeFilterBody(formFields, itemType, sharedFilters) {
    const body = new URLSearchParams(normalizeFormFields(formFields));
    body.set("itemType", String(itemType || ""));
    body.set("qry", sharedFilters.qry || "");
    body.set("itemLevel", sharedFilters.itemLevel || "39");
    body.set("itemQuality", sharedFilters.itemQuality || "-1");
    if (sharedFilters.csrfToken) body.set("csrf_token", sharedFilters.csrfToken);
    return body;
  }

  function normalizeScanRequest(rawRequest) {
    const sourceUrl = normalizeAuctionUrl(rawRequest?.sourceUrl, "Auction source").href;
    const sharedFilters = normalizeSharedFilters(rawRequest?.sharedFilters);
    const formFields = normalizeFormFields(rawRequest?.formFields);
    const sources = normalizeSources(rawRequest?.sources, sourceUrl);
    if (!sources.length) throw new Error("No auction scan sources were provided.");

    return {
      sourceUrl,
      sharedFilters,
      formFields,
      sources
    };
  }

  function normalizeSharedFilters(filters) {
    const source = filters && typeof filters === "object" ? filters : {};
    return {
      qry: String(source.qry || ""),
      itemLevel: String(source.itemLevel || "39"),
      itemQuality: String(source.itemQuality ?? "-1"),
      csrfToken: String(source.csrfToken || "")
    };
  }

  function normalizeFormFields(formFields) {
    return Array.isArray(formFields)
      ? formFields
        .filter((entry) => Array.isArray(entry) && entry.length >= 2)
        .map(([name, value]) => [String(name), String(value)])
      : [];
  }

  function normalizeSources(rawSources, sourceUrl) {
    const fallback = [
      {
        label: "Gladiator necessities",
        url: CORE.makeAuctionUrl("", sourceUrl),
        categories: SCHEMA.mainScanCategories
      },
      {
        label: "Mercenary necessities",
        url: CORE.makeAuctionUrl("3", sourceUrl),
        categories: SCHEMA.mercenaryEquipmentScanCategories
      }
    ];
    const sources = Array.isArray(rawSources) && rawSources.length ? rawSources : fallback;

    return sources
      .map((source) => ({
        label: String(source?.label || "Auction"),
        url: normalizeAuctionUrl(source?.url || sourceUrl, "Auction source").href,
        categories: normalizeCategories(source?.categories)
      }))
      .filter((source) => source.categories.length);
  }

  function normalizeCategories(categories) {
    return Array.isArray(categories)
      ? categories.map(normalizeCategory).filter(Boolean)
      : [];
  }

  function normalizeCategory(category) {
    const source = category && typeof category === "object" ? category : {};
    const byId = SCHEMA.getScanCategory(source.id);
    const resolved = byId || SCHEMA.getCategoryForItemType(source.itemType || source.value, source.ttype);
    if (!resolved) return null;
    return resolved;
  }

  function normalizeAuctionUrl(rawUrl, label) {
    const url = new URL(String(rawUrl || ""));
    if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
    if (!url.hostname.endsWith(".gladiatus.gameforge.com")) throw new Error(`${label} must be a Gladiatus URL.`);
    if (!url.pathname.endsWith("/game/index.php") || url.searchParams.get("mod") !== "auction") {
      throw new Error(`${label} must be an auction page.`);
    }
    return url;
  }

  async function saveLastResult(result) {
    if (!root.chrome?.storage?.local) return;
    await root.chrome.storage.local.set({ [SCHEMA.storageKeys.scanResult]: result });
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  const devLogger = root.GladiatusLog ? root.GladiatusLog.createLogger("auction-bg") : null;

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

  root.GladiatusAuctionBackgroundScanner = {
    fetchFilteredAuctionHtml,
    forceScan,
    makeFilterBody,
    normalizeScanRequest,
    scanRequest
  };
})();
