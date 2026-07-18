// Popup controls for the dev log drain. Keeps the popup's wiring out of the
// main popup.js, matching the createArenaView / createAuctionView pattern. The
// drain itself (window.GladiatusLogDrain) is loaded as a classic script before
// this module runs.
export function createDevLogView(options = {}) {
  const defaultDrain = typeof window !== "undefined" ? window.GladiatusLogDrain : null;
  const drain = options.drain || (defaultDrain?.create
    ? defaultDrain.create({ download: triggerBrowserDownload })
    : defaultDrain);
  const setStatus = options.setStatus || (() => {});
  const downloadButton = document.getElementById("dev-log-download");
  const clearButton = document.getElementById("dev-log-clear");

  if (downloadButton) downloadButton.addEventListener("click", onDownload);
  if (clearButton) clearButton.addEventListener("click", onClear);

  async function onDownload() {
    if (!drain) {
      setStatus("Logging is unavailable.");
      return;
    }
    try {
      const result = await drain.exportToFile();
      setStatus(`Saved ${result.count} log entr${result.count === 1 ? "y" : "ies"} to ${result.filename}.`);
    } catch (error) {
      setStatus(`Could not export logs: ${error?.message || error}`);
    }
  }

  async function onClear() {
    if (!drain) return;
    try {
      await drain.clear();
      setStatus("Debug log cleared.");
    } catch (error) {
      setStatus(`Could not clear logs: ${error?.message || error}`);
    }
  }

  return { onDownload, onClear };
}

// A download initiated directly from the popup button does not need the broad
// chrome.downloads permission. The log drain still owns serialization and Blob
// lifecycle; this adapter only performs the user-initiated browser download.
function triggerBrowserDownload({ url, filename }) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "gladiatus-dev-log.ndjson";
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  return new Promise((resolve) => setTimeout(resolve, 0));
}
