// Shared URL/storage safety helpers. Fetch code should validate the live URL
// with parseAllowedGameforgeUrl and sanitize any copy before logging or saving.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusHelperSecurity) return;

  const CREDENTIAL_QUERY_KEYS = Object.freeze([
    "sh",
    "csrf_token",
    "token",
    "auth",
    "session"
  ]);
  const CREDENTIAL_KEY_FORMS = new Set([
    "sh",
    "csrftoken",
    "token",
    "authtoken",
    "accesstoken",
    "refreshtoken",
    "auth",
    "authorization",
    "session",
    "sessionid"
  ]);

  const KNOWN_STORAGE_KEYS = Object.freeze([
    "glad-ah-scan-archive-v1",
    "glad-ah-last-scan-v1",
    "glad-arena-last-scan-v1",
    "glad-arena-passive-scans-v1",
    "glad-arena-scan-status-v1",
    "glad-arena-self-profile-v1"
  ]);

  function normalizedCredentialKey(value) {
    return String(value || "").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
  }

  function isCredentialKey(value) {
    return CREDENTIAL_KEY_FORMS.has(normalizedCredentialKey(value));
  }

  function parseUrlShape(value) {
    const raw = String(value || "");
    if (/^https?:\/\//i.test(raw)) {
      try {
        return { url: new URL(raw), format: "absolute" };
      } catch (_error) {
        return null;
      }
    }
    if (raw.startsWith("//")) {
      try {
        return { url: new URL(`https:${raw}`), format: "protocol-relative" };
      } catch (_error) {
        return null;
      }
    }
    if (raw.startsWith("/") || raw.startsWith("?") || raw.startsWith("#")) {
      try {
        return { url: new URL(raw, "https://gladiatus.invalid/"), format: "relative", raw };
      } catch (_error) {
        return null;
      }
    }
    return null;
  }

  function serializeUrlShape(shape) {
    if (shape.format === "absolute") return shape.url.href;
    if (shape.format === "protocol-relative") {
      return `//${shape.url.host}${shape.url.pathname}${shape.url.search}${shape.url.hash}`;
    }
    if (shape.raw.startsWith("?")) return `${shape.url.search}${shape.url.hash}`;
    if (shape.raw.startsWith("#")) return shape.url.hash;
    return `${shape.url.pathname}${shape.url.search}${shape.url.hash}`;
  }

  function sanitizeUrl(value) {
    const shape = parseUrlShape(value);
    if (!shape) return String(value == null ? "" : value);
    for (const key of Array.from(shape.url.searchParams.keys())) {
      if (isCredentialKey(key)) shape.url.searchParams.delete(key);
    }
    shape.url.hash = "";
    return serializeUrlShape(shape);
  }

  function sanitizeText(value) {
    const raw = String(value == null ? "" : value);
    const whole = parseUrlShape(raw);
    if (whole) return sanitizeUrl(raw);

    let safe = raw.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
      const trailing = candidate.match(/[),.;!?]+$/)?.[0] || "";
      const body = trailing ? candidate.slice(0, -trailing.length) : candidate;
      return `${sanitizeUrl(body)}${trailing}`;
    });
    // Also protect malformed/truncated URL fragments that cannot be parsed.
    safe = safe.replace(
      /([?&](?:sh|csrf_token|token|auth|session)=)[^&#\s"'<>]*/gi,
      "$1[redacted]"
    );
    return safe;
  }

  function sanitizeValue(value, options = {}) {
    const maximumDepth = Number.isSafeInteger(options.maximumDepth)
      ? Math.max(0, options.maximumDepth)
      : 30;
    const credentialFields = options.credentialFields === "redact" ? "redact" : "remove";
    const seen = new WeakSet();

    function visit(current, depth) {
      if (typeof current === "string") return sanitizeText(current);
      if (current == null || typeof current !== "object") return current;
      if (depth > maximumDepth) return "[max-depth]";
      if (seen.has(current)) return "[circular]";
      seen.add(current);

      if (Array.isArray(current)) return current.map((entry) => visit(entry, depth + 1));
      const safe = {};
      for (const [key, entry] of Object.entries(current)) {
        if (isCredentialKey(key)) {
          if (credentialFields === "redact") safe[key] = "[redacted]";
          continue;
        }
        safe[key] = visit(entry, depth + 1);
      }
      return safe;
    }

    return visit(value, 0);
  }

  function sanitizeForStorage(value, options = {}) {
    return sanitizeValue(value, { ...options, credentialFields: "remove" });
  }

  function sanitizeForLog(value, options = {}) {
    return sanitizeValue(value, { ...options, credentialFields: "redact" });
  }

  function storageArea(options = {}) {
    const area = options.storageArea || root.chrome?.storage?.local;
    if (!area || typeof area.get !== "function" || typeof area.set !== "function") {
      throw new Error("chrome.storage.local is unavailable");
    }
    return area;
  }

  function stableJson(value) {
    try {
      return JSON.stringify(value);
    } catch (_error) {
      return "[unserializable]";
    }
  }

  async function sanitizeKnownStorage(options = {}) {
    const area = storageArea(options);
    const keys = Array.isArray(options.keys) ? options.keys : KNOWN_STORAGE_KEYS;
    const stored = await area.get(keys);
    const updates = {};
    const changedKeys = [];
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(stored || {}, key)) continue;
      const sanitized = sanitizeForStorage(stored[key], options);
      if (stableJson(sanitized) === stableJson(stored[key])) continue;
      updates[key] = sanitized;
      changedKeys.push(key);
    }
    if (changedKeys.length) await area.set(updates);
    return { scannedKeys: [...keys], changedKeys };
  }

  function parseAllowedGameforgeUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""));
    } catch (_error) {
      throw new TypeError("Invalid Gameforge URL");
    }
    const host = url.hostname.toLocaleLowerCase("en-US");
    const allowedHost = host.endsWith(".gladiatus.gameforge.com")
      && host !== "gladiatus.gameforge.com";
    const allowedPort = !url.port || url.port === "443";
    if (url.protocol !== "https:" || !allowedHost || !allowedPort || url.username || url.password) {
      throw new TypeError("URL must use HTTPS on a Gladiatus Gameforge host");
    }
    return url;
  }

  function isAllowedGameforgeUrl(value) {
    try {
      parseAllowedGameforgeUrl(value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  root.GladiatusHelperSecurity = Object.freeze({
    credentialQueryKeys: CREDENTIAL_QUERY_KEYS,
    knownStorageKeys: KNOWN_STORAGE_KEYS,
    isCredentialKey,
    sanitizeUrl,
    sanitizeText,
    sanitizeValue,
    sanitizeForStorage,
    sanitizeForLog,
    sanitizeKnownStorage,
    runStorageSanitizationMigration: sanitizeKnownStorage,
    parseAllowedGameforgeUrl,
    isAllowedGameforgeUrl
  });
})();
