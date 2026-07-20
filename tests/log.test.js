// Unit tests for the dev-logging modules (log-core, log-buffer, log-drain,
// log-setup). Kept separate from architecture.test.js so the logging layer can
// be verified in isolation. Run with: node log.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

// Values returned from the vm realm carry that realm's prototypes, which trips
// assert's strict deepEqual. Compare structure via JSON for cross-realm values.
function jsonEq(actual, expected, message) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

function loadModules(files, overrides = {}) {
  const context = { console, URL, Date, Math, ...overrides };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(repoFile(file), "utf8"), context, { filename: file });
  }
  return context;
}

// --- log-core: records, dispatch, level filtering ---
{
  const { GladiatusLog } = loadModules(["log-core.js"]);
  const captured = [];
  GladiatusLog.setSinks([{ minLevel: "debug", write: (record) => captured.push(record) }]);

  const logger = GladiatusLog.createLogger("test-src");
  logger.debug("hello", { a: 1 });
  logger.warn("careful");

  assert.equal(captured.length, 2);
  assert.equal(captured[0].source, "test-src");
  assert.equal(captured[0].level, "debug");
  assert.equal(captured[0].msg, "hello");
  assert.equal(JSON.stringify(captured[0].fields), JSON.stringify({ a: 1 }));
  assert.equal(captured[1].level, "warn");
  assert.equal(JSON.stringify(captured[1].fields), "{}", "missing fields default to {}");
  assert.ok(captured[1].seq > captured[0].seq, "seq is monotonic");
  assert.ok(typeof captured[0].ts === "string" && captured[0].ts.length > 0);
}

// --- log-core: per-sink level filtering ---
{
  const { GladiatusLog } = loadModules(["log-core.js"]);
  const lowAndUp = [];
  const warnAndUp = [];
  GladiatusLog.setSinks([
    { minLevel: "debug", write: (r) => lowAndUp.push(r.level) },
    { minLevel: "warn", write: (r) => warnAndUp.push(r.level) }
  ]);

  const logger = GladiatusLog.createLogger("s");
  logger.debug("a");
  logger.info("b");
  logger.warn("c");
  logger.error("d");

  assert.deepEqual(lowAndUp, ["debug", "info", "warn", "error"]);
  assert.deepEqual(warnAndUp, ["warn", "error"], "warn-level sink skips debug/info");
}

// --- log-core: consoleSink routes by level, forwardSink no-ops without send ---
{
  const calls = [];
  const fakeConsole = {
    debug: (...a) => calls.push(["debug", ...a]),
    info: (...a) => calls.push(["info", ...a]),
    warn: (...a) => calls.push(["warn", ...a]),
    error: (...a) => calls.push(["error", ...a]),
    log: (...a) => calls.push(["log", ...a])
  };
  const { GladiatusLog } = loadModules(["log-core.js"]);
  GladiatusLog.setSinks([GladiatusLog.consoleSink({ minLevel: "debug", console: fakeConsole })]);
  const logger = GladiatusLog.createLogger("src");
  logger.info("hi");
  logger.error("boom");
  assert.equal(calls[0][0], "info");
  assert.equal(calls[0][1], "[src]");
  assert.equal(calls[1][0], "error");

  // forwardSink without a function send must not throw.
  GladiatusLog.setSinks([GladiatusLog.forwardSink(undefined)]);
  assert.doesNotThrow(() => GladiatusLog.createLogger("x").debug("noop"));
}

// --- log-core: redaction scrubs the session token ---
{
  const { GladiatusLog } = loadModules(["log-core.js"]);
  const captured = [];
  GladiatusLog.setSinks([{ minLevel: "debug", write: (r) => captured.push(r) }]);
  GladiatusLog.createLogger("s").debug(
    "fetching https://x.gladiatus.gameforge.com/game/?mod=arena&sh=SECRET123&z=1",
    { url: "https://x/?sh=ANOTHER&a=2", sh: "RAWTOKEN", nested: { url: "https://y/?sh=DEEP" } }
  );
  const record = captured[0];
  assert.ok(!record.msg.includes("SECRET123"), "msg sh token scrubbed");
  assert.match(record.msg, /sh=\[redacted\]/);
  assert.ok(!record.fields.url.includes("ANOTHER"), "field url sh scrubbed");
  assert.equal(record.fields.sh, "[redacted]", "sh field value scrubbed");
  assert.ok(!record.fields.nested.url.includes("DEEP"), "nested url sh scrubbed");
}

// --- log-core: all credential forms are scrubbed and deep objects are cut off ---
{
  const { GladiatusLog } = loadModules(["log-core.js"]);
  const captured = [];
  GladiatusLog.setSinks([{ minLevel: "debug", write: (r) => captured.push(r) }]);
  GladiatusLog.createLogger("safety").debug(
    "https://x/?CsRf_ToKeN=ONE&SESSION=TWO",
    {
      access_token: "THREE",
      nested: {
        a: { b: { c: { d: { e: { f: { secret: "must-not-survive" } } } } } }
      }
    }
  );
  const serialized = JSON.stringify(captured[0]);
  assert.ok(!serialized.includes("ONE"), "mixed-case CSRF query token scrubbed");
  assert.ok(!serialized.includes("TWO"), "session query token scrubbed");
  assert.ok(!serialized.includes("THREE"), "credential-like object field scrubbed");
  assert.ok(!serialized.includes("must-not-survive"), "objects past maximum depth are not returned raw");
  assert.ok(serialized.includes("[max-depth]"), "maximum-depth marker is emitted");
}

// --- log-core: shared sanitizer removes URL credentials and fragments when loaded ---
{
  const { GladiatusLog } = loadModules(["helper-security.js", "log-core.js"]);
  const captured = [];
  GladiatusLog.setSinks([{ minLevel: "debug", write: (r) => captured.push(r) }]);
  GladiatusLog.createLogger("shared-safety").debug("request", {
    url: "https://s1-en.gladiatus.gameforge.com/game/?mod=arena&sh=SECRET#private"
  });
  assert.equal(
    captured[0].fields.url,
    "https://s1-en.gladiatus.gameforge.com/game/?mod=arena",
    "shared sanitizer strips credentials and fragments"
  );
}

// --- log-core: serialize / toNdjsonLine round-trip ---
{
  const { GladiatusLog } = loadModules(["log-core.js"]);
  const records = [
    { seq: 1, ts: "t1", level: "debug", source: "a", msg: "one", fields: { x: 1 } },
    { seq: 2, ts: "t2", level: "warn", source: "b", msg: "two", fields: {} }
  ];
  const text = GladiatusLog.serialize(records);
  const lines = text.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), records[0]);
  assert.deepEqual(JSON.parse(lines[1]), records[1]);
  assert.equal(GladiatusLog.serialize([]), "", "empty records serialize to empty string");
}

function makeFakeArea() {
  const store = {};
  return {
    async get(key) {
      return { [key]: store[key] };
    },
    async set(obj) {
      Object.assign(store, obj || {});
    },
    _store: store
  };
}

const immediateTimers = {
  setTimeout: (cb) => {
    cb();
    return 1;
  },
  clearTimeout: () => {}
};

async function runAsyncTests() {
  // --- log-buffer: append / readAll round-trip + persistence ---
  {
    const { GladiatusLogBuffer } = loadModules(["log-buffer.js"]);
    const area = makeFakeArea();
    const buffer = GladiatusLogBuffer.create({ area, flushDelayMs: 0, ...immediateTimers });
    buffer.append({ seq: 1, msg: "a" });
    buffer.append({ seq: 2, msg: "b" });
    await buffer.flush();
    jsonEq((await buffer.readAll()).map((r) => r.msg), ["a", "b"]);
    jsonEq(area._store["glad-dev-log-v1"].map((r) => r.msg), ["a", "b"]);
  }

  // --- log-buffer: capacity cap drops oldest ---
  {
    const { GladiatusLogBuffer } = loadModules(["log-buffer.js"]);
    const buffer = GladiatusLogBuffer.create({ area: makeFakeArea(), maxRecords: 3, flushDelayMs: 0, ...immediateTimers });
    for (let i = 1; i <= 5; i += 1) buffer.append({ seq: i, msg: String(i) });
    jsonEq((await buffer.readAll()).map((r) => r.msg), ["3", "4", "5"]);
  }

  // --- log-buffer: survives a simulated worker restart ---
  {
    const { GladiatusLogBuffer } = loadModules(["log-buffer.js"]);
    const area = makeFakeArea();
    const first = GladiatusLogBuffer.create({ area, flushDelayMs: 0, ...immediateTimers });
    first.append({ seq: 1, msg: "before-restart" });
    await first.flush();

    // A brand new buffer instance over the same storage area = post-restart.
    const second = GladiatusLogBuffer.create({ area, flushDelayMs: 0, ...immediateTimers });
    second.append({ seq: 1, msg: "after-restart" });
    const all = (await second.readAll()).map((r) => r.msg);
    assert.ok(all.includes("before-restart"), "history survives restart");
    assert.ok(all.includes("after-restart"), "new records kept after restart");
  }

  // --- log-buffer: clear empties memory and storage ---
  {
    const { GladiatusLogBuffer } = loadModules(["log-buffer.js"]);
    const area = makeFakeArea();
    const buffer = GladiatusLogBuffer.create({ area, flushDelayMs: 0, ...immediateTimers });
    buffer.append({ seq: 1, msg: "a" });
    await buffer.flush();
    await buffer.clear();
    jsonEq(await buffer.readAll(), []);
    jsonEq(area._store["glad-dev-log-v1"], []);
  }

  // --- log-drain: exportToFile serializes and downloads ---
  {
    const { GladiatusLogDrain } = loadModules(["log-drain.js"]);
    const records = [{ seq: 1, msg: "x" }, { seq: 2, msg: "y" }];
    let downloaded = null;
    let blobText = null;
    let cleared = false;
    const drain = GladiatusLogDrain.create({
      buffer: { readAll: async () => records, clear: async () => { cleared = true; } },
      serialize: (recs) => recs.map((r) => r.msg).join("|"),
      makeBlob: (text) => ({ text }),
      createObjectURL: (blob) => { blobText = blob.text; return "blob:fake"; },
      revokeObjectURL: () => {},
      download: async (opts) => { downloaded = opts; return 7; }
    });

    const result = await drain.exportToFile();
    assert.equal(downloaded.filename, "gladiatus-dev-log.ndjson");
    assert.equal(downloaded.conflictAction, "overwrite");
    assert.equal(downloaded.url, "blob:fake");
    assert.equal(blobText, "x|y", "serialized body matches buffer contents");
    assert.equal(result.count, 2);
    assert.equal(result.downloadId, 7);

    await drain.clear();
    assert.equal(cleared, true);
  }

  // --- log-drain: default serialize is self-contained NDJSON ---
  {
    const { GladiatusLogDrain } = loadModules(["log-drain.js"]);
    assert.equal(GladiatusLogDrain.defaultSerialize([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
    assert.equal(GladiatusLogDrain.defaultSerialize([]), "");
  }

  // --- log-setup: installFor wires the right sinks per context ---
  {
    const context = loadModules(["log-core.js", "log-setup.js"]);
    const LOG = context.GladiatusLog;
    const forwarded = [];
    LOG.installFor("content", { diagnosticsEnabled: true, send: (record) => forwarded.push(record) });
    LOG.createLogger("c").debug("from-content");
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].msg, "from-content");

    const buffered = [];
    LOG.installFor("background", { diagnosticsEnabled: true, buffer: { append: (record) => buffered.push(record) } });
    LOG.createLogger("bg").info("from-bg");
    assert.equal(buffered.length, 1);
    assert.equal(buffered[0].msg, "from-bg");

    LOG.installFor("content", { diagnosticsEnabled: false, send: (record) => forwarded.push(record) });
    LOG.createLogger("quiet").debug("not-forwarded");
    assert.equal(forwarded.length, 1, "disabled diagnostics do not forward records");
  }
}

runAsyncTests()
  .then(() => {
    console.log("log tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
