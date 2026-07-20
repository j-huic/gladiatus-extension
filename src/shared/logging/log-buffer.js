// Durable ring buffer for log records. The MV3 service worker is killed when
// idle, so logs must survive a restart to still be there when the popup exports
// them. We persist into a chrome.storage area (session by default: survives
// worker restarts, auto-clears on browser close, never hits disk) behind a tiny
// interface. The drain depends only on this interface — swap the storage area
// or the whole logging approach above without touching it.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusLogBuffer) return;

  const STORAGE_KEY = "glad-dev-log-v1";
  const MAX_RECORDS = 5000;
  const FLUSH_DELAY_MS = 250;

  function resolveArea() {
    const storage = typeof chrome !== "undefined" && chrome.storage
      ? chrome.storage
      : root.chrome && root.chrome.storage;
    if (!storage) return null;
    return storage.session || storage.local || null;
  }

  function createBuffer(options = {}) {
    const area = options.area || resolveArea();
    const key = options.key || STORAGE_KEY;
    const maxRecords = options.maxRecords || MAX_RECORDS;
    const flushDelayMs = options.flushDelayMs != null ? options.flushDelayMs : FLUSH_DELAY_MS;
    const setTimeoutFn = options.setTimeout || (typeof setTimeout !== "undefined" ? setTimeout : null);
    const clearTimeoutFn = options.clearTimeout || (typeof clearTimeout !== "undefined" ? clearTimeout : null);

    let mirror = [];
    let loaded = false;
    let loadPromise = null;
    let flushTimer = null;

    function cap() {
      if (mirror.length > maxRecords) mirror = mirror.slice(mirror.length - maxRecords);
    }

    // Merge anything already in storage (e.g. logs from before a worker restart)
    // into the in-memory mirror exactly once. After this the mirror is the
    // single source of truth, so flushing never clobbers earlier history.
    async function ensureLoaded() {
      if (loaded) return;
      if (!loadPromise) {
        loadPromise = (async () => {
          if (area && area.get) {
            try {
              const data = await area.get(key);
              const stored = data && Array.isArray(data[key]) ? data[key] : [];
              mirror = stored.concat(mirror);
              cap();
            } catch (_error) {
              // Storage unavailable — keep whatever is in memory.
            }
          }
          loaded = true;
        })();
      }
      await loadPromise;
    }

    async function flush() {
      flushTimer = null;
      if (!area || !area.set) return;
      await ensureLoaded();
      try {
        await area.set({ [key]: mirror });
      } catch (_error) {
        // Best-effort: dropping a flush is preferable to throwing into a logger.
      }
    }

    function scheduleFlush() {
      if (!area || !area.set) return;
      if (flushTimer != null) return;
      if (!setTimeoutFn || flushDelayMs <= 0) {
        flush();
        return;
      }
      flushTimer = setTimeoutFn(() => flush(), flushDelayMs);
    }

    function append(record) {
      mirror.push(record);
      cap();
      scheduleFlush();
    }

    function appendMany(records) {
      for (const record of records || []) mirror.push(record);
      cap();
      scheduleFlush();
    }

    async function readAll() {
      await ensureLoaded();
      return mirror.slice();
    }

    async function clear() {
      mirror = [];
      loaded = true;
      if (flushTimer != null && clearTimeoutFn) {
        clearTimeoutFn(flushTimer);
        flushTimer = null;
      }
      if (area && area.set) {
        try {
          await area.set({ [key]: [] });
        } catch (_error) {
          // Ignore — the in-memory buffer is already cleared.
        }
      }
    }

    return { append, appendMany, readAll, clear, flush, key, maxRecords };
  }

  root.GladiatusLogBuffer = Object.assign(createBuffer(), {
    create: createBuffer,
    STORAGE_KEY,
    MAX_RECORDS
  });
})();
