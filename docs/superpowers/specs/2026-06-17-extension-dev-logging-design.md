# Extension Dev Logging — Design

Date: 2026-06-17
Status: Approved design, pending implementation plan

## Problem

Debugging extension behavior currently means: add `console.log`, reproduce in the
browser, copy the service-worker console output by hand, and paste it back to
Claude. The relay is the slow part. We want logs to land in a **plain file Claude
can read directly**, triggered by a **single button in the popup** — no background
process to keep running.

The motivating case: the arena simulation always falls back to the simple
score-based evaluation and never shows simulation win/loss/draw percentages. The
diagnostics that would explain why already exist in
`arena-background-scan.js` (`simulateSingleOpponent` logs the exact
`simulationReadiness` failure), but they are suppressed by
`const VERBOSE_LOGGING = false`. We cannot see why the fallback happens.

## Goals

1. Application code emits **structured** logs through one small, formalized module.
2. Logs persist durably enough to survive MV3 service-worker restarts.
3. One popup button exports the buffered logs to a fixed local file Claude reads;
   one button clears the buffer.
4. The **drain** (buffer → file egress) is decoupled from the **logging approach**
   (how logs are produced/formatted/routed). Either side can be swapped without
   touching the other.
5. Console logging keeps working so DevTools is still usable.
6. Default behavior surfaces the currently-hidden simulation diagnostics.

## Non-goals (YAGNI)

- No localhost collector / external service (violates AGENTS.md "local-only").
- No third-party logging dependency (the runtime is plain `<script>` /
  `importScripts`, no bundler).
- No log rotation, multiple simultaneous drains, or remote transport. The sink
  interface leaves room for these later, but we do not build them now.
- No MAIN-world logging. The MAIN-world scripts (`auction-schema.js`,
  `auction-core.js`) do not log today and have no `chrome.runtime` access.

## Constraints (from AGENTS.md)

- MV3, no build step. Modules are IIFEs that attach to a `Gladiatus*` global, in
  the existing style. Syntax checked with `node --check`; logic checked in
  `architecture.test.js` under plain Node.
- Local-only: use `chrome.storage`; never send data off the machine.
- Keep `background.js` a thin bridge; keep parsing/scoring/UI separation intact.
- `chrome.runtime.sendMessage` is available in isolated content scripts, the
  popup, and the service worker — **not** in MAIN-world scripts.
- `URL.createObjectURL` / Blob URLs are unavailable in the service worker but
  available in the popup document. **The drain therefore runs in the popup.**

## Architecture

Four layers, each a separate module with a single responsibility. Arrows are
dependencies; note the drain depends only on the buffer, never on the logger.

```
  app code ──> log-core (facade + levels + sinks + formatter)
                   │ dispatches records to registered sinks
                   ├─ consoleSink ──> console.*
                   ├─ bufferSink ───> log-buffer (ring buffer in chrome.storage)
                   └─ forwardSink ──> chrome.runtime.sendMessage (content → bg)

  popup button ──> log-drain ──reads──> log-buffer ──> chrome.downloads (file)

  log-setup: per-context wiring (which sinks, which levels). Single change point.
```

The seam that satisfies the modularity requirement: **`log-drain` imports only
`log-buffer` and a `serialize(records)` function.** It knows nothing about how
records were produced. Swap the entire logging approach (different facade, sinks,
formats) and the drain is unaffected as long as the buffer still yields plain
record objects. Conversely, swap the drain (e.g. to a future server POST) without
touching the logging modules.

## Modules

### `log-core.js` → `GladiatusLog` (the formalized logging module)

- **Levels:** `TRACE < DEBUG < INFO < WARN < ERROR`, numeric for comparison.
- **Record shape:** `{ seq, ts, level, source, msg, fields }`
  - `seq`: monotonic counter (orders records across contexts after a merge).
  - `ts`: ISO-8601 string.
  - `level`: level name.
  - `source`: binding tag, e.g. `"background"`, `"arena-bg"`, `"auction-bg"`,
    `"arena-content"`.
  - `msg`: short string.
  - `fields`: structured object (the old `details` arg maps here verbatim).
- **API:**
  - `createLogger(source)` → `{ trace, debug, info, warn, error }`, each
    `(msg, fields = {}) => void`. Builds a record and dispatches to all sinks.
  - `addSink(sink)`, `setSinks([...])`, `clearSinks()`.
  - Back-compat helper so existing call sites churn minimally: a logger's
    `debug`/`warn` cover today's `log(msg, details)` / `console.warn(...)` usage.
- **Sink contract:** `{ minLevel, write(record) }`. The dispatcher skips a sink
  when `record.level < sink.minLevel`. Per-sink level is deliberate: the console
  sink stays quiet (default `WARN`) while the buffer sink captures everything
  (default `DEBUG`). This reproduces the old "quiet console" feel while making the
  file verbose — solving the hidden-diagnostics problem without console spam.
- **Sinks (factories live here):**
  - `consoleSink({ minLevel = WARN })` → routes by level to
    `console.debug/info/warn/error`, formatted as `[source] msg`, fields.
  - `bufferSink(buffer, { minLevel = DEBUG })` → `buffer.append(record)`.
  - `forwardSink(send, { minLevel = DEBUG })` → `send(record)`; no-ops if `send`
    is unavailable (e.g. no `chrome.runtime`).
- **Formatter / serialize:** `toNdjsonLine(record)` and `serialize(records)`
  (newline-delimited JSON). Plain `JSON.stringify` over plain records — usable by
  the drain without importing anything else.
- **Redaction:** `redact(record)` scrubs the sensitive session token before a
  record leaves memory. Any string value containing `sh=<token>` (and the `sh`
  URL param) is replaced with `sh=[redacted]`, reusing the same rule as
  `background.js#safeUrl`. Applied on write in both console and buffer sinks so
  the exported file never carries the session token.
- Pure: no `chrome`/DOM dependency except `consoleSink` touching `console`.

### `log-buffer.js` → `GladiatusLogBuffer` (the durable store)

- Ring buffer over a configurable storage area, **default `chrome.storage.session`**.
  - Rationale: `session` survives service-worker restarts (the thing we need),
    auto-clears when the browser closes (no disk clutter, no stale logs, better
    privacy), and is readable by the popup + background by default. Content
    scripts never touch it (they forward). The storage area is injected, so
    switching to `chrome.storage.local` for cross-restart persistence is a
    one-line change — and is itself an example of the modularity goal.
- **API:** `append(record)`, `appendMany(records)`, `readAll()`, `clear()`.
- In-memory mirror + **debounced flush** (e.g. 250 ms) so high-frequency logging
  does not hammer storage. `readAll()` returns mirror ∪ persisted, deduped by
  `seq`.
- **Capacity cap** (e.g. 5000 records); oldest dropped first. Keeps us well under
  quota without needing `unlimitedStorage`.

### `log-drain.js` → `GladiatusLogDrain` (the isolated egress)

- Depends only on a buffer and an injected `serialize` (default = NDJSON of plain
  records). Does **not** import `log-core` internals.
- `exportToFile()`:
  1. `records = buffer.readAll()`.
  2. `text = serialize(records)`.
  3. Build a `Blob` + object URL (popup context).
  4. `chrome.downloads.download({ filename, conflictAction: "overwrite",
     saveAs: false })`.
  5. Revoke the object URL.
- `clear()` → `buffer.clear()`.
- **Output file:** `gladiatus-dev-log.ndjson` in the Downloads folder, overwritten
  each click → predictable absolute path Claude reads
  (`~/Downloads/gladiatus-dev-log.ndjson`).

### `log-setup.js` → `GladiatusLog.installFor(context)` (single wiring point)

Composes sinks/levels per context. The one place to change the whole approach.

| context      | sinks                                   | notes                              |
|--------------|-----------------------------------------|------------------------------------|
| `background` | `consoleSink(WARN)`, `bufferSink(DEBUG)`| owns the buffer; sole storage writer |
| `content`    | `consoleSink(WARN)`, `forwardSink(DEBUG)`| forwards records to background      |
| `popup`      | `consoleSink(WARN)`, `bufferSink(DEBUG)`| reads buffer for the drain          |

## Data flow

- **Service worker** (`arena-background-scan.js`, `auction-background-scan.js`,
  `background.js`): `createLogger(source).debug(...)` → `bufferSink` →
  `chrome.storage.session`. Simulation readiness diagnostics now land in the
  buffer at `DEBUG`.
- **Isolated content scripts** (`arena-content.js`, `arena-passive-content.js`,
  …): `createLogger(source).debug(...)` → `forwardSink` →
  `chrome.runtime.sendMessage({ type: "GLAD_DEV_LOG", record })`. `background.js`
  handles `GLAD_DEV_LOG` → `buffer.append(record)` (single writer, no storage
  race).
- **Popup**: button → `GladiatusLogDrain.exportToFile()` → reads buffer →
  downloads file. Second button → `clear()`.

## File changes

New files:
- `log-core.js`, `log-buffer.js`, `log-drain.js`, `log-setup.js`
- `popup/dev-log-view.js` (small view module: wires the two buttons to the drain,
  matching the existing `createArenaView` / `createAuctionView` pattern)

Modified:
- `manifest.json`
  - add `"downloads"` permission;
  - prepend `log-core.js`, `log-setup.js` to the isolated `content_scripts` js
    list. Content scripts need only the facade + wiring; they forward records and
    never touch the buffer, so `log-buffer.js`/`log-drain.js` stay out of the
    content list.
- `background.js`
  - `importScripts(... "log-core.js", "log-buffer.js", "log-setup.js" ...)`;
  - `GladiatusLog.installFor("background")`;
  - replace local `log()` with a `createLogger("background")` delegate;
  - add `GLAD_DEV_LOG` handler → `buffer.append(message.record)`.
- `arena-background-scan.js`
  - remove the `VERBOSE_LOGGING` gate; route `log()`/warn through
    `createLogger("arena-bg")` (debug/warn). Console behavior for warnings is
    preserved by `consoleSink` (which calls `console.warn` at `WARN`).
- `auction-background-scan.js` — same, `source = "auction-bg"`.
- `arena-content.js`, `arena-passive-content.js` (and any other content scripts
  using `console.*`) — `installFor("content")` + replace `console.*` with a
  `createLogger(source)` so page-side logs are captured.
- `popup.html` — add `<script>` tags for `log-core.js`, `log-buffer.js`,
  `log-drain.js`, `log-setup.js` (before `popup.js`); add the two buttons.
- `popup.js` — `installFor("popup")`; instantiate `createDevLogView()`.
- `architecture.test.js` — update the assertion at line ~604
  (`/console\.warn\(LOG_PREFIX/`) to the new logger shape; add tests for the new
  modules (below); add the new files to the `node --check` enumeration.
- `AGENTS.md` — document the new modules and add them to the verification loop.

## Testing

Pure-logic, runnable under Node by loading each IIFE against a fake `root` and a
fake `chrome` (the existing test harness already loads sources this way):

- **log-core:** record shape & `seq` monotonicity; level filtering per sink;
  dispatch to multiple sinks; `forwardSink` no-ops without `send`; `redact`
  scrubs `sh=` tokens in `msg`/`fields`/URL strings; `serialize` round-trips
  (`JSON.parse` each line).
- **log-buffer:** `append`/`readAll` round-trip; capacity cap drops oldest;
  `clear` empties; survives a simulated "restart" by reloading from the fake
  storage area.
- **log-drain:** `exportToFile` calls the injected `download` with the expected
  filename and a body equal to `serialize(buffer.readAll())`; `clear` delegates to
  the buffer. Inject fake `download`/`Blob`/URL so it runs headless.
- **regression:** assert warn-level still reaches `console.warn` via `consoleSink`
  (replaces the old literal-string assertion).

## Verification

Per AGENTS.md, after changes (the `for` loop reuses the existing AGENTS.md file
list with the new files appended):
```sh
for file in auction-schema.js score-model.js auction-core.js auction-model.js auction-content.js arena-core.js arena-content.js background.js popup.js popup/*.js architecture.test.js \
            log-core.js log-buffer.js log-drain.js log-setup.js popup/dev-log-view.js; do node --check "$file"; done
node architecture.test.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
git diff --check
```
Then load the unpacked extension, run an arena scan, click **Download debug log**,
and read `~/Downloads/gladiatus-dev-log.ndjson`.

## Payoff: the arena-sim debugging loop

Once this lands, the immediate next step is not part of this design but is the
reason for it: reproduce one arena scan, click the button, read the file, and
inspect the `arena-bg` `single simulation readiness failed` records to see the
exact `missing` reasons (stale self profile? opponent combat data not parsed?) —
then fix the real `simulationReadiness` issue.
