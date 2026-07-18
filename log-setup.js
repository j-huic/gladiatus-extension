// Single wiring point: decides which sinks each runtime context gets. This is
// the one place to change to alter the whole logging approach (levels, where
// records go) without touching call sites, the buffer, or the drain.
//
// - every context always has a quiet console sink (warn+);
// - only while Diagnostics is enabled, background adds the verbose buffer and
//   content/popup contexts forward records to that single storage writer.
// The popup reads the buffer directly for explicit user-generated export.
//
// Installs automatically for the detected context at load, and also exposes
// GladiatusLog.installFor(context, options) for explicit/overriding wiring.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const LOG = root.GladiatusLog;
  if (!LOG || LOG.installFor) return;

  const DEV_LOG_MESSAGE = "GLAD_DEV_LOG";

  function defaultSend(record) {
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({ type: DEV_LOG_MESSAGE, record }, () => {
          // Reading lastError swallows "no receiving end" when the worker is asleep.
          void chrome.runtime.lastError;
        });
      }
    } catch (_error) {
      // Logging must never throw into the caller.
    }
  }

  function detectContext() {
    if (typeof window === "undefined" || typeof document === "undefined") return "background";
    try {
      if (typeof location !== "undefined" && location.protocol === "chrome-extension:") return "popup";
    } catch (_error) {
      // Fall through to content.
    }
    return "content";
  }

  function installFor(context, options = {}) {
    const consoleMinLevel = options.consoleMinLevel || "warn";
    const bufferMinLevel = options.bufferMinLevel || "debug";
    const diagnosticsEnabled = options.diagnosticsEnabled === true;
    const sinks = [LOG.consoleSink({ minLevel: consoleMinLevel })];

    if (diagnosticsEnabled && context === "background") {
      const buffer = options.buffer || root.GladiatusLogBuffer;
      if (buffer) sinks.push(LOG.bufferSink(buffer, { minLevel: bufferMinLevel }));
    } else if (diagnosticsEnabled) {
      // content + popup forward to the background, the single buffer writer.
      const send = options.send || defaultSend;
      sinks.push(LOG.forwardSink(send, { minLevel: bufferMinLevel }));
    }

    LOG.setSinks(sinks);
    return sinks;
  }

  LOG.installFor = installFor;
  LOG.detectContext = detectContext;
  LOG.DEV_LOG_MESSAGE = DEV_LOG_MESSAGE;

  const context = detectContext();
  installFor(context, { diagnosticsEnabled: false });

  const settings = root.GladiatusFeatureSettings;
  // The service worker owns its startup migration ordering and calls
  // installFor explicitly from background.js. Other contexts can hydrate and
  // subscribe here without racing installation migration.
  if (context !== "background" && settings?.get) {
    settings.get()
      .then((value) => installFor(context, { diagnosticsEnabled: Boolean(value?.diagnostics?.enabled) }))
      .catch(() => {});
    settings.subscribe?.((value) => {
      installFor(context, { diagnosticsEnabled: Boolean(value?.diagnostics?.enabled) });
    });
  }
})();
