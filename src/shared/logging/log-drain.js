// The log drain: the egress path that turns the buffered records into a file on
// disk via chrome.downloads. It depends ONLY on a buffer (something with
// readAll/clear) and a serialize(records) function — never on the logging
// facade. That boundary is deliberate: the entire logging setup above can be
// swapped without touching this, and this can be swapped (e.g. a future server
// POST) without touching the loggers. Runs in the popup, where Blob URLs exist.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusLogDrain) return;

  const DEFAULT_FILENAME = "gladiatus-dev-log.ndjson";

  function defaultSerialize(records) {
    const list = records || [];
    if (!list.length) return "";
    return list.map((record) => JSON.stringify(record)).join("\n") + "\n";
  }

  function toBase64(text) {
    if (typeof root.btoa === "function") return root.btoa(unescape(encodeURIComponent(text)));
    if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64");
    return "";
  }

  function createDrain(options = {}) {
    const buffer = options.buffer || root.GladiatusLogBuffer;
    const serialize = options.serialize || defaultSerialize;
    const filename = options.filename || DEFAULT_FILENAME;
    const download = options.download
      || ((opts) => root.chrome.downloads.download(opts));
    const makeBlob = options.makeBlob
      || ((text) => new root.Blob([text], { type: "application/x-ndjson" }));
    const createObjectUrl = options.createObjectURL
      || (root.URL && root.URL.createObjectURL ? (blob) => root.URL.createObjectURL(blob) : null);
    const revokeObjectUrl = options.revokeObjectURL
      || (root.URL && root.URL.revokeObjectURL ? (url) => root.URL.revokeObjectURL(url) : () => {});

    async function exportToFile(exportOptions = {}) {
      if (!buffer || typeof buffer.readAll !== "function") {
        throw new Error("Log buffer unavailable.");
      }
      const records = await buffer.readAll();
      const text = serialize(records);
      const name = exportOptions.filename || filename;

      let url = exportOptions.url;
      let createdUrl = null;
      if (!url) {
        if (createObjectUrl) {
          createdUrl = createObjectUrl(makeBlob(text));
          url = createdUrl;
        } else {
          url = "data:application/x-ndjson;base64," + toBase64(text);
        }
      }

      try {
        const downloadId = await download({
          url,
          filename: name,
          conflictAction: "overwrite",
          saveAs: false
        });
        return { ok: true, downloadId, count: records.length, filename: name };
      } finally {
        if (createdUrl) revokeObjectUrl(createdUrl);
      }
    }

    async function clear() {
      if (buffer && typeof buffer.clear === "function") await buffer.clear();
    }

    return { exportToFile, clear };
  }

  root.GladiatusLogDrain = Object.assign(createDrain(), {
    create: createDrain,
    defaultSerialize,
    DEFAULT_FILENAME
  });
})();
