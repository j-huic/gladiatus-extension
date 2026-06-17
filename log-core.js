// Structured logging facade for the extension. Application code asks for a
// logger bound to a "source" and emits level-tagged records with structured
// fields. Records are redacted (session token scrubbed) and fanned out to the
// registered sinks. This module knows nothing about where logs end up — sinks
// own that — so the logging approach here can change without touching the
// buffer/drain that read the records back out.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  if (root.GladiatusLog) return;

  const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
  const DEFAULT_LEVEL = "debug";
  // The session hash (`sh`) is a credential. Never let it reach a sink.
  const SH_PATTERN = /([?&]sh=)[^&#\s"']+/g;

  let seq = 0;
  const sinks = [];

  function levelValue(level) {
    return LEVELS[level] || LEVELS[DEFAULT_LEVEL];
  }

  function nowIso() {
    try {
      return new Date().toISOString();
    } catch (_error) {
      return "";
    }
  }

  function makeRecord(level, source, msg, fields) {
    seq += 1;
    return {
      seq,
      ts: nowIso(),
      level: LEVELS[level] ? level : DEFAULT_LEVEL,
      source: String(source || "app"),
      msg: msg == null ? "" : String(msg),
      fields: fields && typeof fields === "object" ? fields : fields === undefined ? {} : { value: fields }
    };
  }

  function redactString(value) {
    return value.replace(SH_PATTERN, "$1[redacted]");
  }

  function redactValue(value, depth) {
    if (typeof value === "string") return redactString(value);
    if (!value || typeof value !== "object" || depth > 6) return value;
    if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = key === "sh" ? "[redacted]" : redactValue(value[key], depth + 1);
    }
    return out;
  }

  function redact(record) {
    return {
      ...record,
      msg: redactString(String(record.msg || "")),
      fields: redactValue(record.fields, 0)
    };
  }

  function dispatch(record) {
    const safe = redact(record);
    const value = levelValue(safe.level);
    for (const sink of sinks) {
      try {
        if (value >= levelValue(sink.minLevel)) sink.write(safe);
      } catch (_error) {
        // A failing sink must never break the caller's code path.
      }
    }
  }

  function createLogger(source) {
    const emit = (level) => (msg, fields) => dispatch(makeRecord(level, source, msg, fields));
    return {
      trace: emit("trace"),
      debug: emit("debug"),
      info: emit("info"),
      warn: emit("warn"),
      error: emit("error")
    };
  }

  function addSink(sink) {
    if (!sink || typeof sink.write !== "function") return sink;
    sinks.push({
      minLevel: sink.minLevel || DEFAULT_LEVEL,
      write: (record) => sink.write(record)
    });
    return sink;
  }

  function setSinks(list) {
    sinks.length = 0;
    for (const sink of list || []) addSink(sink);
  }

  function clearSinks() {
    sinks.length = 0;
  }

  // --- Sink factories. Each returns { minLevel, write(record) }. ---

  function consoleSink(options = {}) {
    const minLevel = options.minLevel || "warn";
    const target = options.console || root.console || console;
    return {
      minLevel,
      write(record) {
        const method = record.level === "error" ? "error"
          : record.level === "warn" ? "warn"
          : record.level === "info" ? "info"
          : "debug";
        const fn = typeof target[method] === "function" ? target[method] : target.log;
        if (typeof fn === "function") fn.call(target, `[${record.source}]`, record.msg, record.fields);
      }
    };
  }

  function bufferSink(buffer, options = {}) {
    return {
      minLevel: options.minLevel || "debug",
      write(record) {
        if (buffer && typeof buffer.append === "function") buffer.append(record);
      }
    };
  }

  function forwardSink(send, options = {}) {
    return {
      minLevel: options.minLevel || "debug",
      write(record) {
        if (typeof send === "function") send(record);
      }
    };
  }

  // --- Serialization. Plain records in, NDJSON out. ---

  function toNdjsonLine(record) {
    try {
      return JSON.stringify(record);
    } catch (_error) {
      return JSON.stringify({
        seq: record.seq,
        ts: record.ts,
        level: record.level,
        source: record.source,
        msg: record.msg,
        fields: { unserializable: true }
      });
    }
  }

  function serialize(records) {
    const list = records || [];
    if (!list.length) return "";
    return list.map(toNdjsonLine).join("\n") + "\n";
  }

  root.GladiatusLog = {
    LEVELS,
    createLogger,
    addSink,
    setSinks,
    clearSinks,
    consoleSink,
    bufferSink,
    forwardSink,
    redact,
    serialize,
    toNdjsonLine
  };
})();
