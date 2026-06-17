const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = __dirname;

function makeDocument(forms = []) {
  return {
    currentScript: null,
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    createElement() {
      let text = "";
      return {
        set innerHTML(value) {
          text = String(value || "")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ");
        },
        get textContent() {
          return text;
        },
        get innerText() {
          return text;
        }
      };
    },
    querySelectorAll(selector) {
      return selector === "form[id^='auctionForm']" ? forms : [];
    }
  };
}

function makeForm({ tooltipLines, auctionId = "auction-1", priceGold = "1.234", bidAmount = "222" }) {
  const ownerDocument = makeDocument();
  const tooltip = JSON.stringify([tooltipLines.map((line) => [line])]);
  const icon = {
    dataset: { tooltip, priceGold },
    className: "item-i-1",
    ownerDocument,
    getAttribute(name) {
      const attrs = {
        "data-tooltip": tooltip,
        "data-price-gold": priceGold,
        "data-content-type": "item",
        "data-basis": "test",
        style: "background-image:url(/cdn/item.png)"
      };
      return attrs[name] || "";
    },
    querySelector() {
      return null;
    }
  };

  return {
    ownerDocument,
    querySelector(selector) {
      if (selector === "[data-tooltip]") return icon;
      if (selector === "input[name='auctionid']") return { value: auctionId };
      if (selector === "input[name='bid_amount']") return { value: bidAmount };
      return null;
    }
  };
}

function loadGlobals() {
  const context = {
    console,
    URL,
    chrome: { runtime: { id: "test-extension" } },
    document: makeDocument(),
    DOMParser: class {
      parseFromString(html) {
        return makeParsedHtmlDocument(html);
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js", "arena-core.js", "arena-sim.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }

  return {
    schema: context.GladiatusAuctionSchema,
    score: context.GladiatusScoreModel,
    model: context.GladiatusAuctionModel,
    core: context.GladiatusAuctionCore,
    arena: context.GladiatusArenaCore,
    sim: context.GladiatusArenaSim
  };
}

function makeBackgroundScannerContext(options = {}) {
  const storage = options.storage || {};
  const setCalls = options.setCalls || [];
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    Date,
    Math,
    fetch: options.fetch || (async () => {
      throw new Error("Unexpected fetch in background scanner test.");
    }),
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, storage[key]]));
            }
            if (typeof keys === "string") return { [keys]: storage[keys] };
            if (keys && typeof keys === "object") {
              return Object.fromEntries(Object.keys(keys).map((key) => [key, storage[key] ?? keys[key]]));
            }
            return { ...storage };
          },
          async set(values) {
            setCalls.push(JSON.parse(JSON.stringify(values || {})));
            Object.assign(storage, values || {});
          }
        }
      }
    }
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ["score-model.js", "arena-core.js", "arena-sim.js", "arena-background-scan.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }

  return {
    arena: context.GladiatusArenaCore,
    sim: context.GladiatusArenaSim,
    scanner: context.GladiatusArenaBackgroundScanner,
    storage,
    setCalls
  };
}

function makeAuctionBackgroundScannerContext(options = {}) {
  const storage = options.storage || {};
  const setCalls = options.setCalls || [];
  const context = {
    console: { ...console, log() {}, warn() {} },
    URL,
    URLSearchParams,
    Date,
    Math,
    fetch: options.fetch || (async () => {
      throw new Error("Unexpected fetch in auction background scanner test.");
    }),
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, storage[key]]));
            }
            if (typeof keys === "string") return { [keys]: storage[keys] };
            if (keys && typeof keys === "object") {
              return Object.fromEntries(Object.keys(keys).map((key) => [key, storage[key] ?? keys[key]]));
            }
            return { ...storage };
          },
          async set(values) {
            setCalls.push(JSON.parse(JSON.stringify(values || {})));
            Object.assign(storage, values || {});
          }
        }
      }
    }
  };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);

  for (const file of ["auction-schema.js", "auction-core.js", "auction-background-scan.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }

  return {
    schema: context.GladiatusAuctionSchema,
    core: context.GladiatusAuctionCore,
    scanner: context.GladiatusAuctionBackgroundScanner,
    storage,
    setCalls
  };
}

function makeAuctionContentContext(listeners) {
  const context = {
    console: { ...console, error() {}, warn() {} },
    URL,
    clearTimeout() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    chrome: {
      runtime: {
        id: "test-extension",
        getURL(file) {
          return file;
        },
        onMessage: {
          addListener(listener) {
            listeners.push(listener);
          },
          removeListener(listener) {
            const index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
          }
        }
      },
      storage: {
        local: {
          async get() {
            return {};
          },
          async set() {}
        },
        onChanged: {
          addListener() {}
        }
      }
    },
    document: makeContentDocument(),
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {}
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {}
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  return context;
}

function makeContentDocument() {
  const documentElement = makeElement("html");
  const head = makeElement("head");
  return {
    currentScript: null,
    documentElement,
    head,
    readyState: "complete",
    location: { href: "https://s1.gladiatus.gameforge.com/game/index.php?mod=auction&itemType=2" },
    addEventListener() {},
    createDocumentFragment() {
      return makeElement("#fragment");
    },
    createElement: makeElement,
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
}

function makeParsedHtmlDocument(html) {
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  for (const match of String(html || "").matchAll(rowPattern)) {
    const rowHtml = match[1];
    const linkTagMatch = rowHtml.match(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/i);
    const attackTag = Array.from(rowHtml.matchAll(/<[^>]*>/g))
      .map((tagMatch) => tagMatch[0])
      .find((tag) => /\bclass\s*=\s*(["'])[^"']*\battack\b[^"']*\1/i.test(tag)) || "";
    const href = decodeHtml(linkTagMatch?.[2] || "");
    const linkText = stripHtml(linkTagMatch?.[3] || "");
    const onclick = decodeHtml(readHtmlAttribute(attackTag, "onclick"));
    const cells = Array.from(rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi))
      .map((cell) => ({ textContent: stripHtml(cell[1]) }));
    const link = {
      textContent: linkText,
      getAttribute(attribute) {
        return attribute === "href" ? href : "";
      }
    };
    const attack = {
      getAttribute(attribute) {
        return attribute === "onclick" ? onclick : "";
      }
    };
    rows.push({
      cells,
      querySelector(selector) {
        if (selector.startsWith("a[")) return href ? link : null;
        if (selector.startsWith(".attack")) return onclick ? attack : null;
        return null;
      }
    });
  }

  return {
    location: { href: "about:blank" },
    querySelectorAll(selector) {
      return selector === "#content tr" ? rows : [];
    }
  };
}

function readHtmlAttribute(tag, attribute) {
  const pattern = new RegExp(`${attribute}\\s*=\\s*("|')([\\s\\S]*?)\\1`, "i");
  return tag.match(pattern)?.[2] || "";
}

function stripHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, "").trim());
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function makeStatTooltip(rows) {
  return JSON.stringify([rows.map(([label, value]) => [[label, value], ["#DDDDDD", "#DDDDDD"]])]);
}

function makeItemTooltip(lines) {
  return JSON.stringify([lines.map((line) => Array.isArray(line) ? [line, ["#DDD", "#DDD"]] : [line, "#DDD"])]);
}

function sequenceRandom(values) {
  let index = 0;
  return () => {
    const value = values[index] ?? values[values.length - 1] ?? 0;
    index += 1;
    return value;
  };
}

function makeElement(tagName) {
  return {
    tagName: String(tagName || "").toUpperCase(),
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    id: "",
    style: {
      setProperty() {}
    },
    tBodies: [],
    append() {},
    appendChild() {},
    prepend() {},
    before() {},
    after() {},
    remove() {},
    replaceChildren() {},
    addEventListener() {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() {
        return false;
      }
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    set textContent(value) {
      this._textContent = String(value || "");
    },
    get textContent() {
      return this._textContent || "";
    },
    set innerHTML(value) {
      this._innerHTML = String(value || "");
      this._textContent = this._innerHTML.replace(/<[^>]+>/g, "");
    },
    get innerHTML() {
      return this._innerHTML || "";
    },
    get innerText() {
      return this.textContent;
    }
  };
}

const { schema, score, model, core, arena, sim } = loadGlobals();

{
  assert.equal(core.version, "auction-core-v3");
  assert.equal(core.constants.pageBridgeRequestSource, "glad-ah-extension-v3");
  assert.equal(core.constants.pageBridgeResponseSource, "glad-ah-page-v3");
}

{
  const base = {
    name: "A",
    level: 1,
    hp: 100,
    maxHp: 100,
    damageMin: 10,
    damageMax: 10,
    armour: 0,
    armourAbsorbMin: 0,
    armourAbsorbMax: 0,
    strength: 1,
    dexterity: 100,
    agility: 0,
    constitution: 1,
    charisma: 0,
    intelligence: 1,
    critChance: 0,
    blockChance: 0,
    critAvoidChance: 0
  };
  const miss = sim.simulateBattle(
    { ...base, dexterity: 0, damageMin: 0, damageMax: 0 },
    { ...base, name: "D", agility: 100, dexterity: 0, damageMin: 0, damageMax: 0 },
    { maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0.5, 0.5]) }
  );
  assert.equal(miss.rounds[0].strikes[0].result, "miss");

  const blockedCrit = sim.simulateBattle(
    { ...base, damageMin: 20, damageMax: 20, critChance: 50 },
    { ...base, name: "D", blockChance: 50, armourAbsorbMin: 5, armourAbsorbMax: 5, damageMin: 0, damageMax: 0 },
    { maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0, 0, 0, 0, 0, 0.99, 0.99]) }
  );
  assert.equal(blockedCrit.rounds[0].strikes[0].isCrit, true);
  assert.equal(blockedCrit.rounds[0].strikes[0].isBlocked, true);
  assert.equal(blockedCrit.rounds[0].strikes[0].finalDamage, 15);
  assert.equal(blockedCrit.rounds[0].strikes[0].defenderHpAfter, 85);

  const doubleHit = sim.simulateBattle(
    { ...base, damageMin: 5, damageMax: 5, charisma: 100 },
    { ...base, name: "D", agility: 1, intelligence: 1, damageMin: 0, damageMax: 0 },
    { maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0, 0, 0.99, 0.99, 0, 0, 0, 0.99, 0.99, 0, 0.99]) }
  );
  assert.equal(doubleHit.rounds[0].strikes.filter((strike) => strike.attacker === "A").length, 2);
  assert.equal(doubleHit.rounds[0].strikes[1].isSecondHalfOfDoubleHit, true);

  const knockout = sim.simulateBattle(
    { ...base, damageMin: 200, damageMax: 200 },
    { ...base, name: "D" },
    { maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0, 0, 0.99, 0.99, 0]) }
  );
  assert.equal(knockout.outcome, "attacker_wins");
  assert.equal(knockout.outcomeReason, "defender_killed");

  const exhausted = sim.simulateBattle(
    { ...base, damageMin: 10, damageMax: 10 },
    { ...base, name: "D", damageMin: 5, damageMax: 5 },
    { maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0, 0, 0.99, 0.99, 0, 0.99, 0, 0, 0.99, 0.99, 0, 0.99]) }
  );
  assert.equal(exhausted.outcome, "attacker_wins");
  assert.equal(exhausted.outcomeReason, "rounds_exhausted");

  const odds = sim.simulateOddsPvP(
    { ...base, damageMin: 200, damageMax: 200 },
    { ...base, name: "D" },
    { iterations: 3, maxRounds: 1, firstAttacker: "attacker", random: sequenceRandom([0.99]) }
  );
  assert.equal(odds.iterations, 3);
  assert.equal(odds.wins, 3);
  assert.equal(odds.losses, 0);
  assert.equal(odds.draws, 0);
  assert.equal(odds.winRate, 1);
}

{
  const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"));
  const backgroundSource = fs.readFileSync(path.join(rootDir, "background.js"), "utf8");
  const backgroundArenaSource = fs.readFileSync(path.join(rootDir, "arena-background-scan.js"), "utf8");
  const arenaScanSource = fs.readFileSync(path.join(rootDir, "arena-scan.js"), "utf8");
  const arenaPassiveContentSource = fs.readFileSync(path.join(rootDir, "arena-passive-content.js"), "utf8");
  const arenaStatusContentSource = fs.readFileSync(path.join(rootDir, "arena-status-content.js"), "utf8");
  const popupSource = fs.readFileSync(path.join(rootDir, "popup.js"), "utf8");
  const popupRuntimeSource = fs.readFileSync(path.join(rootDir, "popup/runtime.js"), "utf8");
  const mainEntry = manifest.content_scripts.find((entry) => entry.world === "MAIN");
  const isolatedEntries = manifest.content_scripts.filter((entry) => entry.world !== "MAIN");

  assert.equal(manifest.background.service_worker, "background.js");
  assert.match(backgroundSource, /importScripts\("auction-schema\.js", "auction-core\.js", "score-model\.js", "arena-core\.js", "arena-sim\.js", "arena-background-scan\.js", "auction-background-scan\.js"\);/);
  assert.ok(backgroundSource.indexOf("auction-schema.js") < backgroundSource.indexOf("auction-core.js"));
  assert.ok(backgroundSource.indexOf("auction-core.js") < backgroundSource.indexOf("score-model.js"));
  assert.ok(backgroundSource.indexOf("score-model.js") < backgroundSource.indexOf("arena-core.js"));
  assert.ok(backgroundSource.indexOf("arena-core.js") < backgroundSource.indexOf("arena-sim.js"));
  assert.ok(backgroundSource.indexOf("arena-sim.js") < backgroundSource.indexOf("arena-background-scan.js"));
  assert.ok(backgroundSource.indexOf("arena-background-scan.js") < backgroundSource.indexOf("auction-background-scan.js"));
  const repairFiles = backgroundSource.match(/const AUCTION_CONTENT_FILES = \[([\s\S]*?)\];/)?.[1] || "";
  assert.ok(repairFiles.indexOf("\"arena-sim.js\"") < repairFiles.indexOf("\"arena-scan.js\""));
  assert.ok(repairFiles.indexOf("\"arena-scan.js\"") < repairFiles.indexOf("\"arena-passive-content.js\""));
  assert.ok(repairFiles.indexOf("\"arena-passive-content.js\"") < repairFiles.indexOf("\"arena-fight.js\""));
  assert.ok(repairFiles.indexOf("\"arena-fight.js\"") < repairFiles.indexOf("\"arena-status-content.js\""));
  assert.ok(repairFiles.indexOf("\"arena-status-content.js\"") < repairFiles.indexOf("\"arena-content.js\""));
  assert.equal(repairFiles.includes("arena-background-scan.js"), false);
  assert.equal(repairFiles.includes("auction-background-scan.js"), false);
  assert.deepEqual(mainEntry.js, ["auction-schema.js", "auction-core.js"]);
  assert.equal(isolatedEntries.length, 1);
  assert.deepEqual(isolatedEntries[0].js, [
    "auction-schema.js",
    "score-model.js",
    "auction-model.js",
    "auction-core.js",
    "arena-core.js",
    "arena-sim.js",
    "arena-scan.js",
    "arena-passive-content.js",
    "arena-fight.js",
    "arena-status-content.js",
    "auction-content.js",
    "arena-content.js"
  ]);
  assert.ok(isolatedEntries[0].js.indexOf("arena-sim.js") < isolatedEntries[0].js.indexOf("arena-scan.js"));
  assert.ok(isolatedEntries[0].js.indexOf("arena-scan.js") < isolatedEntries[0].js.indexOf("arena-passive-content.js"));
  assert.ok(isolatedEntries[0].js.indexOf("arena-passive-content.js") < isolatedEntries[0].js.indexOf("arena-fight.js"));
  assert.ok(isolatedEntries[0].js.indexOf("arena-fight.js") < isolatedEntries[0].js.indexOf("arena-status-content.js"));
  assert.ok(isolatedEntries[0].js.indexOf("arena-status-content.js") < isolatedEntries[0].js.indexOf("arena-content.js"));
  assert.match(arenaScanSource, /GLAD_ARENA_REFRESH_SELF_PROFILE/);
  assert.match(backgroundSource, /GLAD_ARENA_REFRESH_SELF_PROFILE/);
  assert.match(popupRuntimeSource, /function refreshArenaSelfProfile/);
  assert.match(popupRuntimeSource, /ARENA_SIM/);
  assert.match(popupSource, /ARENA\.selfProfileStorageKey/);
  assert.doesNotMatch(arenaScanSource, /glad-arena-passive-status/);
  assert.doesNotMatch(arenaScanSource, /startFight|startGroupFight|startProvinciarumFight/);
  assert.doesNotMatch(arenaScanSource, /MutationObserver/);
  assert.doesNotMatch(arenaScanSource, /setInterval\(/);
  assert.doesNotMatch(arenaScanSource, /GLAD_ARENA_PASSIVE_CHECK/);
  assert.match(backgroundSource, /schedulePassiveCheck/);
  assert.match(backgroundArenaSource, /function schedulePassiveCheck/);
  assert.match(arenaPassiveContentSource, /GLAD_ARENA_PASSIVE_CHECK/);
  assert.match(arenaPassiveContentSource, /const FIGHT_CLICK_SCAN_DELAY_MS = 5 \* 1000/);
  assert.match(arenaPassiveContentSource, /delayMs: FIGHT_CLICK_SCAN_DELAY_MS/);
  assert.match(arenaPassiveContentSource, /delayMs: AFTER_FIGHT_CHECK_DELAY_MS/);
  assert.match(arenaPassiveContentSource, /function handleFightTriggerClick/);
  assert.doesNotMatch(arenaPassiveContentSource, /fightClickScanTimer|afterFightCheckTimer/);
  assert.doesNotMatch(arenaPassiveContentSource, /glad-arena-passive-status|glad-arena-score/);
  assert.doesNotMatch(arenaPassiveContentSource, /setInterval\(/);
  assert.match(arenaStatusContentSource, /const STATUS_BOX_ID = "glad-arena-passive-status"/);
  assert.match(arenaStatusContentSource, /chrome\.storage\.onChanged\.addListener/);
  assert.match(arenaStatusContentSource, /\.\.\.STATUS_KINDS\.map/);
  assert.doesNotMatch(arenaStatusContentSource, /GLAD_ARENA_PASSIVE_CHECK|GLAD_ARENA_FORCE_SCAN|GLAD_ARENA_ENSURE_VISIBLE_SCAN/);
  assert.match(arenaStatusContentSource, /GladiatusArenaFight/);
  assert.match(arenaStatusContentSource, /glad-arena-fight-button/);
  assert.match(arenaStatusContentSource, /outcome\.reportUrl/);
  const arenaFightSource = fs.readFileSync(path.join(rootDir, "arena-fight.js"), "utf8");
  assert.match(arenaFightSource, /root\.GladiatusArenaFight/);
  assert.match(arenaFightSource, /submod=doCombat/);
  assert.match(arenaFightSource, /doGroupFight\.php/);
  assert.match(arenaFightSource, /doArenaFight\.php/);
  assert.match(arenaFightSource, /X-CSRF-Token/);
  // The fight module must stay UI-agnostic so the button can be relocated freely.
  assert.doesNotMatch(arenaFightSource, /glad-arena-passive-status|glad-arena-fight-button|createElement|document\.body/);
  const arenaContentSource = fs.readFileSync(path.join(rootDir, "arena-content.js"), "utf8");
  assert.match(arenaContentSource, /__GladiatusArenaContentBootstrapped/);
  assert.match(arenaContentSource, /GLAD_ARENA_BOOT_V2/);
  assert.match(arenaContentSource, /function scheduleArenaBootForLocation/);
  assert.match(arenaContentSource, /function refreshVisibleScanInBackground/);
  assert.match(arenaContentSource, /function scheduleVisibleScanRetry/);
  assert.match(arenaContentSource, /function opponentIdentityKeys/);
  assert.match(arenaContentSource, /bestSimulationResult\(opponents\) \|\| bestScoreResult\(opponents\)/);
  assert.doesNotMatch(arenaContentSource, /Win \?/);
  assert.doesNotMatch(arenaContentSource, /glad-arena-passive-status|GLAD_ARENA_PASSIVE_CHECK|startFight|startGroupFight|startProvinciarumFight/);
  assert.match(backgroundArenaSource, /bestSimulationResult\(opponents\) \|\| bestScoreResult\(opponents\)/);
  assert.match(backgroundArenaSource, /single simulation readiness failed/);
  assert.match(backgroundArenaSource, /self simulation profile state/);
  assert.match(backgroundArenaSource, /single scan completed without win simulations/);
  assert.match(backgroundArenaSource, /console\.warn\(LOG_PREFIX/);
  assert.match(popupRuntimeSource, /ensureAuctionContentScript\(tab\.id\);\s+return sendTabMessage\(tab\.id, message\);/);
  assert.ok(popupRuntimeSource.indexOf("\"arena-scan.js\"") < popupRuntimeSource.indexOf("\"arena-passive-content.js\""));
  assert.ok(popupRuntimeSource.indexOf("\"arena-passive-content.js\"") < popupRuntimeSource.indexOf("\"arena-fight.js\""));
  assert.ok(popupRuntimeSource.indexOf("\"arena-fight.js\"") < popupRuntimeSource.indexOf("\"arena-status-content.js\""));
  assert.ok(popupRuntimeSource.indexOf("\"arena-status-content.js\"") < popupRuntimeSource.indexOf("\"arena-content.js\""));
  assert.equal(fs.existsSync(path.join(rootDir, "content.js")), false);

  const referencedFiles = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources || []),
    manifest.background.service_worker,
    "auction-background-scan.js",
    "arena-background-scan.js",
    "arena-sim.js",
    "arena-passive-content.js",
    "arena-status-content.js",
    "popup.js",
    "popup/runtime.js",
    "popup/store.js",
    "popup/auction-view.js",
    "popup/arena-view.js"
  ];
  for (const file of referencedFiles) {
    assert.equal(fs.existsSync(path.join(rootDir, file)), true, `${file} is referenced but missing`);
  }

  const popupHtml = fs.readFileSync(path.join(rootDir, "popup.html"), "utf8");
  assert.match(popupHtml, /<script\s+src="auction-core\.js"><\/script>/);
  assert.match(popupHtml, /<script\s+src="arena-sim\.js"><\/script>/);
  assert.match(popupHtml, /<script\s+type="module"\s+src="popup\.js"><\/script>/);
}

{
  const listeners = [];
  const context = makeAuctionContentContext(listeners);
  vm.runInContext(fs.readFileSync(path.join(rootDir, "auction-content.js"), "utf8"), context, { filename: "auction-content.js" });

  assert.equal(typeof context.__GladiatusAuctionMissingDependencyListener, "function");
  assert.equal(listeners.length, 1);

  for (const file of ["auction-schema.js", "score-model.js", "auction-model.js", "auction-core.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }
  vm.runInContext(fs.readFileSync(path.join(rootDir, "auction-content.js"), "utf8"), context, { filename: "auction-content.js" });

  assert.equal(context.__GladiatusAuctionMissingDependencyListener, undefined);
  assert.equal(listeners.length, 1);

  const responses = [];
  for (const listener of listeners) {
    listener({ type: "GLAD_AH_BOOT_V2" }, null, (response) => responses.push(response));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(responses)), [{
    ok: true,
    isAuctionPage: true,
    hasPanel: false,
    itemForms: 0,
    hasFilterForm: false
  }]);
}

{
  const parsed = core.parseStats([
    "Damage 56 - 71,+7 - 9",
    "Strength +11% (+5)",
    "Using: +10 Damage",
    "Using: Heals 798 of life",
    "Life points: 2130",
    "Healing +87,+11",
    "Intelligence +21",
    "Level 88",
    "Value 1.234"
  ]);

  assert.equal(parsed.stats.damageMin, 56);
  assert.equal(parsed.stats.damageMax, 71);
  assert.equal(parsed.stats.damageAvg, 63.5);
  assert.equal(parsed.stats.strength, 5);
  assert.equal(parsed.stats.damageBonus, 10);
  assert.equal(parsed.stats.foodHealing, 798);
  assert.equal(parsed.stats.lifepoints, 2130);
  assert.equal(parsed.stats.healing, 87);
  assert.equal(parsed.stats.intelligence, 21);
  assert.equal(parsed.level, 88);
  assert.equal(parsed.itemValue, 1234);
}

{
  assert.equal(core.parseSignedBonus("Agility +10% (+11)"), 11);
  assert.equal(core.parseSignedBonus("Agility +10%"), 0);
  assert.equal(core.parseSignedBonus("Dexterity +32% (+28),+4% (+4)"), 28);
}

{
  const parsed = core.parseStats([
    "Táliths Gladiator helmet of Martial Arts",
    "Damage +7",
    "Armour +813",
    "Strength +1",
    "Strength +20% (+9)",
    "Dexterity +20% (+18)",
    "Charisma +2",
    "Charisma +10% (+7)",
    "Critical attack value +7",
    "Level 64",
    "Value 4506"
  ]);
  const item = { viewId: "armor", stats: parsed.stats };
  const preset = model.getPreset("armor", "main").preset;

  assert.equal(parsed.stats.damageBonus, 7);
  assert.equal(parsed.stats.strength, 10);
  assert.equal(parsed.stats.dexterity, 18);
  assert.equal(parsed.stats.charisma, 9);
  assert.equal(parsed.stats.criticalattackvalue, 7);
  assert.equal(preset.score(item), 82);
}

{
  const parsed = core.parseStats([
    "Kerrannas Leather cap of Elimination",
    "Armour +443",
    "Strength +46% (+21)",
    "Dexterity +50% (+45)",
    "Agility +22% (+25)",
    "Charisma +4",
    "Critical attack value +10",
    "Level 67",
    "Value 4525"
  ]);
  const item = { viewId: "armor", stats: parsed.stats };
  const preset = model.getPreset("armor", "main").preset;

  assert.equal(parsed.stats.strength, 21);
  assert.equal(parsed.stats.dexterity, 45);
  assert.equal(parsed.stats.agility, 25);
  assert.equal(parsed.stats.charisma, 4);
  assert.equal(parsed.stats.criticalattackvalue, 10);
  assert.equal(preset.score(item), 86.8);
}

{
  const values = new Map([
    ["#char_level", "48"],
    ["#char_f0", "65"],
    ["#char_f1", "138"],
    ["#char_f2", "189"],
    ["#char_f3", "83"],
    ["#char_f4", "155"],
    ["#char_f5", "52"],
    ["#char_panzer", "3148"],
    ["#char_schaden", "108 - 125"],
    [".playername", "Ikarrus"]
  ]);
  const doc = {
    querySelector(selector) {
      return values.has(selector) ? { textContent: values.get(selector) } : null;
    }
  };
  const character = arena.parseCharacterFromDocument(doc, { id: "1185379", province: "60" });

  assert.equal(character.name, "Ikarrus");
  assert.equal(character.level, 48);
  assert.equal(character.stats.agility, 189);
  assert.equal(character.stats.damageAvg, 116.5);
  assert.equal(character.primaryStatSum, 682);
  assert.deepEqual(JSON.parse(JSON.stringify(arena.combatantReadiness(character))), {
    ready: false,
    missing: ["hp"],
    warnings: []
  });
}

{
  const tooltips = {
    life: makeStatTooltip([
      ["Life points:", "6111 / 6222"],
      ["Life on level 48:", "1200"],
      ["Through items:", "+222"],
      ["Through reinforcement:", "0"],
      ["Bonus through Constitution:", "+4800"],
      ["Regeneration:", "240 per hour"]
    ]),
    strength: makeStatTooltip([
      ["Strength:", 65],
      ["Basic:", 40],
      ["Maximum:", 112],
      ["Through items:", "+25 from +31"]
    ]),
    dexterity: makeStatTooltip([["Dexterity:", 138], ["Basic:", 80], ["Maximum:", 168], ["Through items:", "+58 from +70"]]),
    agility: makeStatTooltip([["Agility:", 189], ["Basic:", 90], ["Maximum:", 183], ["Through items:", "+99 from +101"]]),
    constitution: makeStatTooltip([["Constitution:", 83], ["Basic:", 50], ["Maximum:", 122], ["Through items:", "+33 from +33"]]),
    charisma: makeStatTooltip([["Charisma:", 155], ["Basic:", 90], ["Maximum:", 172], ["Through items:", "+65 from +77"]]),
    intelligence: makeStatTooltip([["Intelligence:", 52], ["Basic:", 52], ["Maximum:", 126], ["Through items:", "0 from 0"]]),
    armour: makeStatTooltip([
      ["Armour:", 3148],
      ["Absorbs damage:", "43 - 52"],
      ["Resilience:", 18],
      ["Through items:", 0],
      ["Through agility:", "+18"],
      ["Chance of avoiding critical hits:", "7 %"],
      ["Blocking value:", 9],
      ["Through items:", 2],
      ["Through strength:", "+7"],
      ["Chance to block a hit:", "3 %"]
    ]),
    damage: makeStatTooltip([
      ["Damage:", "108 - 125"],
      ["Basic:", "80 - 92"],
      ["Through items:", "+21"],
      ["Through strength:", "+6"],
      ["Through reinforcement:", 0],
      ["Critical damage:", 15],
      ["Through items:", 1],
      ["Through dexterity:", "+14"],
      ["Chance for critical damage:", "9 %"]
    ]),
    healing: makeStatTooltip([
      ["Healing:", 40],
      ["Through items:", 3],
      ["Through intelligence:", "+37"],
      ["Critical healing value:", 10],
      ["Chance for improved healing:", "2 %"]
    ])
  };
  const values = new Map([
    ["#char_level", "48"],
    ["#char_f0", "65"],
    ["#char_f1", "138"],
    ["#char_f2", "189"],
    ["#char_f3", "83"],
    ["#char_f4", "155"],
    ["#char_f5", "52"],
    ["#char_panzer", "3148"],
    ["#char_schaden", "108 - 125"],
    ["#char_healing", "40"],
    [".playername", "Ikarrus"]
  ]);
  const equipment = [{
    className: "item-i-1-8 ui-droppable",
    dataset: {
      basis: "1-8",
      contentType: "2",
      containerNumber: "3",
      level: "80",
      tooltip: makeItemTooltip([
        "Test sword",
        "Damage 80 - 92",
        "Armour +200",
        "Strength +24% (+22)",
        ["Damage +8", "+1"],
        "Level 80"
      ])
    },
    getAttribute(attribute) {
      const attrs = {
        "data-tooltip": this.dataset.tooltip,
        "data-basis": this.dataset.basis,
        "data-content-type": this.dataset.contentType,
        "data-container-number": this.dataset.containerNumber,
        "data-level": this.dataset.level
      };
      return attrs[attribute] || "";
    }
  }];
  const doc = {
    querySelector(selector) {
      if (values.has(selector)) return { textContent: values.get(selector) };
      const tooltipKey = Object.entries(arena.profileTooltipIds).find(([, id]) => selector === `#${id}`)?.[0];
      if (tooltipKey) {
        return {
          textContent: "",
          getAttribute(attribute) {
            return attribute === "data-tooltip" ? tooltips[tooltipKey] : "";
          }
        };
      }
      return null;
    },
    querySelectorAll(selector) {
      return selector === "#char [data-tooltip][data-basis]" ? equipment : [];
    }
  };
  const character = arena.parseCharacterFromDocument(doc, { id: "1185379", province: "60" });

  assert.equal(character.profile.life.max, 6222);
  assert.equal(character.profile.life.regenPerHour, 240);
  assert.equal(character.profile.primary.strength.basic, 40);
  assert.equal(character.profile.primary.strength.fromItemsRaw, 31);
  assert.equal(character.profile.armour.absorbMin, 43);
  assert.equal(character.profile.armour.blockChance, 3);
  assert.equal(character.profile.damage.basicMax, 92);
  assert.equal(character.profile.damage.critChance, 9);
  assert.equal(character.stats.lifeMax, 6222);
  assert.equal(character.stats.armourAbsorbMax, 52);
  assert.equal(character.stats.critChance, 9);
  assert.equal(character.equipment.length, 1);
  assert.equal(character.equipment[0].slot, "weapon");
  assert.equal(character.equipment[0].stats.damageMin, 80);
  assert.equal(character.equipment[0].stats.damageBonus, 9);
  assert.equal(character.equipment[0].stats.strength, 22);

  const combat = JSON.parse(JSON.stringify(character.toJSON().combat));
  assert.equal(combat.ready, true);
  assert.deepEqual(combat.missing, []);
  assert.deepEqual(combat.warnings, []);
  assert.deepEqual(combat.combatant, {
    name: "Ikarrus",
    level: 48,
    hp: 6222,
    maxHp: 6222,
    damageMin: 108,
    damageMax: 125,
    armour: 3148,
    armourAbsorbMin: 43,
    armourAbsorbMax: 52,
    strength: 65,
    dexterity: 138,
    agility: 189,
    constitution: 83,
    charisma: 155,
    intelligence: 52,
    critChance: 9,
    blockChance: 3,
    critAvoidChance: 7
  });
}

{
  const character = new arena.ArenaCharacter({
    name: "Clamp Tester",
    level: 10,
    stats: {
      lifeCurrent: 900,
      damageMin: 10,
      damageMax: 20,
      strength: 1,
      dexterity: 2,
      agility: 3,
      constitution: 4,
      charisma: 5,
      intelligence: 6,
      critChance: 75,
      blockChance: 99,
      critAvoidChance: 50
    }
  });
  const combat = JSON.parse(JSON.stringify(arena.combatProfile(character)));

  assert.equal(combat.ready, true);
  assert.deepEqual(combat.missing, []);
  assert.deepEqual(combat.warnings, [
    "lifeMax missing; using lifeCurrent",
    "critChance clamped to 50",
    "blockChance clamped to 50",
    "critAvoidChance clamped to 25"
  ]);
  assert.equal(combat.combatant.hp, 900);
  assert.equal(combat.combatant.maxHp, 900);
  assert.equal(combat.combatant.critChance, 50);
  assert.equal(combat.combatant.blockChance, 50);
  assert.equal(combat.combatant.critAvoidChance, 25);
}

{
  const form = makeForm({
    tooltipLines: ["Shield of Tests", "Damage +6", "Agility +12", "Level 40", "Value 999"]
  });
  const doc = makeDocument([form]);
  form.ownerDocument = doc;
  const [item] = core.parseAuctionItemsFromDocument(doc, { categoryId: "main:2" });

  assert.equal(item.auctionId, "auction-1");
  assert.equal(item.categoryId, "main:2");
  assert.equal(item.viewId, "armor");
  assert.equal(item.category, "Shields");
  assert.equal(item.itemType, "2");
  assert.equal(item.stats.damageBonus, 6);
  assert.equal(item.stats.agility, 12);
}

{
  const tooltip = JSON.stringify([[
    ["HTML Shield"],
    ["Damage +4"],
    ["Agility +7"],
    ["Level 41"],
    ["Value 1.500"]
  ]]);
  const html = `
    <form id="auctionForm-html">
      <input type="hidden" name="auctionid" value="auction-html">
      <input type="hidden" name="bid_amount" value="300">
      <div class="auction_item_div item-i-1" data-tooltip='${tooltip}' data-price-gold="9.999" data-content-type="item" data-basis="base" style="background-image:url(/cdn/html-item.png)"></div>
    </form>
  `;
  const [item] = core.parseAuctionItemsFromHtml(html, { categoryId: "main:2" });

  assert.equal(item.auctionId, "auction-html");
  assert.equal(item.name, "HTML Shield");
  assert.equal(item.bidAmount, 300);
  assert.equal(item.priceGold, 9999);
  assert.equal(item.itemValue, 1500);
  assert.equal(item.stats.damageBonus, 4);
  assert.equal(item.stats.agility, 7);
}

{
  const renamedLabelItem = {
    category: "Changed Human Label",
    viewId: "armor",
    stats: { damageBonus: 6 }
  };
  assert.equal(model.getView("armor").accepts(renamedLabelItem), true);
  assert.equal(model.getView("weapons").accepts(renamedLabelItem), false);
}

{
  const filters = model.normalizeAllFilterValues({ armor: { minDamageBonus: "5" } });
  assert.equal(schema.storageKeys.filterValues, "glad-ah-filter-values-v1");
  assert.equal(filters.armor.minDamageBonus, "5");
  assert.equal(model.filterValuesEqual(filters, { armor: { minDamageBonus: "5" } }), true);
  assert.equal(model.itemMatchesFilters({ viewId: "armor", stats: { damageBonus: 6 } }, "armor", filters.armor), true);
  assert.equal(model.itemMatchesFilters({ viewId: "armor", stats: { damageBonus: 4 } }, "armor", filters.armor), false);

  const [control] = model.getFilterControlDescriptors("armor", filters.armor);
  assert.equal(control.id, "minDamageBonus");
  assert.equal(control.value, "5");
}

{
  const resalePreset = model.getPreset("armor", "resaleValue").preset;
  const item = { viewId: "armor", itemValue: 1200, bidAmount: 300, priceGold: 99999, stats: {} };

  assert.equal(model.bidPrice(item), 300);
  assert.equal(model.resaleValueScore(item), 4);
  assert.equal(resalePreset.score(item), 4);
  assert.equal(resalePreset.display(item, resalePreset.score(item)), "Value / bid: 4");
}

{
  const customDefinition = model.normalizeCustomDefinition({
    id: "armor-dps",
    name: "Armor DPS",
    appliesTo: ["armor"],
    terms: [
      { stat: "agility", weight: 1 },
      { stat: "damageBonus", weight: 10 }
    ],
    constraints: [{ stat: "damageBonus", op: ">=", value: 5 }],
    enabled: true
  });
  const item = { viewId: "armor", stats: { agility: 12, damageBonus: 6 } };

  assert.equal(model.scoreCustomDefinition(item, customDefinition), 72);
  assert.equal(model.itemMatchesCustomDefinition(item, customDefinition), true);
  assert.equal(model.itemMatchesCustomDefinition({ viewId: "armor", stats: { damageBonus: 4 } }, customDefinition), false);
}

{
  const section = score.normalizeScoreSection({
    terms: [
      { stat: "agility", weight: 1 },
      { stat: "dexterity", weight: 1 },
      { stat: "damageAvg", weight: 10 }
    ]
  }, { statKeys: arena.statOrder });
  const character = { stats: { agility: 10, dexterity: 20, damageAvg: 3 } };

  assert.equal(score.score(character, section), 60);
}

{
  assert.equal(arena.parseRoleFromTooltipText("Dungeon Battle Quest: Direct attention to oneself"), "tank");
  assert.equal(arena.parseRoleFromTooltipText("Dungeon Battle Quest: Heal group members"), "healer");
  assert.equal(arena.parseRoleFromTooltipText("Samnit Quest: Dish out damage"), "damage");
  assert.equal(arena.parseRoleFromTooltipText("Standard Battle"), "duel");
}

{
  const formula = arena.normalizeArenaFormula({
    id: "test-team",
    name: "Test team",
    sections: {
      duel: { terms: [{ stat: "strength", weight: 1 }] },
      tank: { terms: [{ stat: "armour", weight: 0.01 }] },
      healer: { terms: [{ stat: "healing", weight: 1 }] },
      damage: { terms: [{ stat: "dexterity", weight: 1 }, { stat: "damageAvg", weight: 1 }] }
    }
  });
  const members = [
    { role: "tank", stats: { armour: 2000 } },
    { role: "healer", stats: { healing: 500 } },
    { role: "damage", stats: { dexterity: 100, damageAvg: 50 } },
    { role: "damage", stats: { dexterity: 80, damageAvg: 40 } },
    { role: "damage", stats: { dexterity: 70, damageAvg: 30 } }
  ];

  assert.equal(arena.scoreArenaTeam(members, formula).totalScore, 890);
}

{
  const formula = arena.normalizeArenaFormula({
    id: "empty-healer",
    name: "Empty healer",
    sections: {
      duel: { terms: [{ stat: "strength", weight: 1 }] },
      healer: { terms: [] }
    }
  });

  assert.equal(arena.scoreArenaCharacter({ role: "healer", stats: { strength: 999, healing: 500 } }, formula).score, 0);
  assert.equal(arena.scoreArenaCharacter({ role: "unknown", stats: { strength: 5 } }, formula).score, 5);
}

{
  const legacy = arena.normalizeArenaFormula({
    id: "legacy-standard",
    name: "Legacy standard",
    sections: {
      standard: { terms: [{ stat: "strength", weight: 2 }] }
    }
  });

  assert.equal(arena.scoreArenaCharacter({ role: "duel", stats: { strength: 4 } }, legacy).score, 8);
}

{
  const tabs = [
    { doll: 1, url: "doll1" },
    { doll: 2, url: "doll2" },
    { doll: 3, url: "doll3" },
    { doll: 4, url: "doll4" },
    { doll: 5, url: "doll5" },
    { doll: 6, url: "doll6" }
  ];

  assert.deepEqual(arena.teamDollTabs(tabs).map((tab) => tab.doll), [2, 3, 4, 5, 6]);
}

{
  assert.equal(arena.parseFightArgs("startGroupFight(this, 4078517)").arenaKind, "team");
  assert.equal(arena.parseFightArgs("startProvinciarumFight(this, 3, 219763, 55, 'en');").arenaKind, "team");
  assert.equal(arena.parseFightArgs("startProvinciarumFight(this, 2, 219763, 55, 'en');").arenaKind, "single");
}

{
  const makeRow = ({ href, name, onclick, cells }) => {
    const link = {
      textContent: name,
      getAttribute(attribute) {
        return attribute === "href" ? href : "";
      }
    };
    const attack = {
      getAttribute(attribute) {
        return attribute === "onclick" ? onclick : "";
      }
    };
    return {
      cells: cells.map((textContent) => ({ textContent })),
      querySelector(selector) {
        if (selector.startsWith("a[")) return link;
        if (selector.startsWith(".attack")) return attack;
        return null;
      }
    };
  };
  const rows = [
    makeRow({
      href: "https://s55-en.gladiatus.gameforge.com/game/index.php?mod=player&p=219763&language=en",
      name: "Morvisus",
      onclick: "startProvinciarumFight(this, 3, 219763, 55, 'en');",
      cells: ["Morvisus", "55", "55", ""]
    }),
    makeRow({
      href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=4078517&sh=test",
      name: "namsis",
      onclick: "startGroupFight(this, 4078517)",
      cells: ["10", "namsis", ""]
    })
  ];
  const doc = {
    location: { href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=3&sh=test" },
    querySelectorAll(selector) {
      return selector === "#content tr" ? rows : [];
    }
  };
  const entries = arena.readArenaOpponentEntries(doc);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].opponent.arenaKind, "team");
  assert.equal(entries[1].opponent.arenaKind, "team");
}

{
  const baseUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=2&sh=test";
  const html = `
    <div id="content">
      <table>
        <tr>
          <td><a href="/game/index.php?mod=player&amp;p=111&amp;sh=test">Alpha</a></td>
          <td>45</td>
          <td>47</td>
          <td><div class="attack" onclick="startProvinciarumFight(this, 2, 111, 47, 'en');"></div></td>
        </tr>
        <tr>
          <td><a href="/game/index.php?mod=player&amp;p=222&amp;sh=test">Beta</a></td>
          <td>46</td>
          <td>47</td>
          <td><div class="attack" onclick="startProvinciarumFight(this, 2, 222, 47, 'en');"></div></td>
        </tr>
      </table>
    </div>
  `;
  const entries = arena.readArenaOpponentEntriesFromHtml(html, baseUrl);
  const fingerprint = arena.arenaOpponentFingerprint(entries);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].opponent.arenaKind, "single");
  assert.equal(entries[0].opponent.profileUrl, "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=111&sh=test");
  assert.equal(fingerprint, arena.arenaOpponentFingerprint(entries.map((entry) => entry.opponent)));
  assert.equal(fingerprint, arena.arenaOpponentFingerprint(entries.map((entry) => ({
    opponent: {
      ...entry.opponent,
      profileUrl: entry.opponent.profileUrl.replace("sh=test", "sh=other")
    }
  }))));
  assert.equal(fingerprint, arena.arenaOpponentFingerprint(entries.slice().reverse()));
}

{
  assert.equal(arena.passiveScansStorageKey, "glad-arena-passive-scans-v1");
  assert.equal(arena.scanStatusStorageKey, "glad-arena-scan-status-v1");
  assert.equal(arena.selfProfileStorageKey, "glad-arena-self-profile-v1");
  assert.equal(arena.selfProfileMaxAgeMs, 6 * 60 * 60 * 1000);
}

{
  const overviewUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=overview&sh=test";
  assert.equal(
    arena.deriveSelfProfileUrl(overviewUrl, {
      scripts: ['var secureHash = "script-hash"; var playerId = "3946776";']
    }),
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=3946776&doll=1&sh=test"
  );
  assert.equal(
    arena.deriveSelfProfileUrl("https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=3946776&sh=test"),
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=3946776&doll=1&sh=test"
  );
  assert.equal(
    arena.deriveSelfProfileUrl("https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=111&sh=test", {
      scripts: ["var playerId = 3946776;"]
    }),
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=3946776&doll=1&sh=test"
  );
}

function arenaListFixture({ aType = "2", players = [] } = {}) {
  return `
    <div id="content">
      <table>
        ${players.map((player) => `
          <tr>
            <td><a href="/game/index.php?mod=player&amp;p=${player.id}&amp;sh=test">${player.name}</a></td>
            <td>${player.level || 50}</td>
            <td>${player.province || 47}</td>
            <td><div class="attack" onclick="startProvinciarumFight(this, ${aType}, ${player.id}, ${player.province || 47}, 'en');"></div></td>
          </tr>
        `).join("")}
      </table>
    </div>
  `;
}

function profileFixture(name, options = {}) {
  return `
    <html>
      <body>
        <span class="playername">${name}</span>
        <span id="char_level">${options.level || 50}</span>
        <span id="char_f0">${options.strength || 60}</span>
        <span id="char_f1">${options.dexterity || 70}</span>
        <span id="char_f2">${options.agility || 80}</span>
        <span id="char_f3">${options.constitution || 90}</span>
        <span id="char_f4">${options.charisma || 100}</span>
        <span id="char_f5">${options.intelligence || 110}</span>
        <span id="char_panzer">${options.armour || 1200}</span>
        <span id="char_schaden">${options.damage || "30 - 50"}</span>
        <span id="char_healing">${options.healing || 400}</span>
        ${options.tabs || ""}
      </body>
    </html>
  `;
}

function readyProfileFixture(name, options = {}) {
  const level = options.level || 50;
  const strength = options.strength || 60;
  const dexterity = options.dexterity || 70;
  const agility = options.agility || 80;
  const constitution = options.constitution || 90;
  const charisma = options.charisma || 100;
  const intelligence = options.intelligence || 110;
  const armour = options.armour || 1200;
  const damage = options.damage || "30 - 50";
  const healing = options.healing || 400;
  const life = options.life || 2000;
  return `
    <html>
      <body>
        <span class="playername">${name}</span>
        <span id="char_level">${level}</span>
        <span id="char_f0">${strength}</span>
        <span id="char_f1">${dexterity}</span>
        <span id="char_f2">${agility}</span>
        <span id="char_f3">${constitution}</span>
        <span id="char_f4">${charisma}</span>
        <span id="char_f5">${intelligence}</span>
        <span id="char_panzer">${armour}</span>
        <span id="char_schaden">${damage}</span>
        <span id="char_healing">${healing}</span>
        <span id="char_leben_tt" data-tooltip='${makeStatTooltip([["Life points:", `${life} / ${life}`]])}'></span>
        ${options.tabs || ""}
      </body>
    </html>
  `;
}

function teamTabsFixture(playerId) {
  const roles = [
    ["tank", "Dungeon Battle Quest: Direct attention to oneself"],
    ["healer", "Dungeon Battle Quest: Heal group members"],
    ["damage", "Samnit Quest: Dish out damage"],
    ["damage", "Samnit Quest: Dish out damage"],
    ["damage", "Samnit Quest: Dish out damage"]
  ];
  return roles.map(([role, tooltip], index) => {
    const doll = index + 2;
    const active = index === 0 ? " active" : "";
    return `
      <div class="charmercsel ${role}${active}" onclick="selectDoll('/game/index.php?mod=player&amp;p=${playerId}&amp;doll=${doll}&amp;sh=test')">
        <span data-tooltip='["${tooltip}"]'></span>
      </div>
    `;
  }).join("");
}

function backgroundFetchFixture({ singleList, teamList, profileHtmls, calls }) {
  return async (rawUrl) => {
    const url = new URL(String(rawUrl));
    calls.push(url.href);
    let html = "";
    if (url.searchParams.get("mod") === "arena") {
      html = url.searchParams.get("aType") === "3" || url.searchParams.get("submod") === "grouparena"
        ? teamList
        : singleList;
    } else if (url.searchParams.get("mod") === "player") {
      html = profileHtmls[url.searchParams.get("p")] || profileHtmls.default;
    }
    return {
      ok: true,
      status: 200,
      async text() {
        return html;
      }
    };
  };
}

function isProfileFetch(url) {
  return new URL(url).searchParams.get("mod") === "player";
}

function auctionHtmlFixture({ auctionId = "auction-1", name = "Auction Shield", bid = 250, price = 9000, value = 1250 } = {}) {
  const tooltip = JSON.stringify([[
    [name],
    ["Damage +5"],
    ["Agility +9"],
    ["Level 42"],
    [`Value ${value}`]
  ]]);
  return `
    <html>
      <body>
        <form id="auctionForm-${auctionId}">
          <input type="hidden" name="auctionid" value="${auctionId}">
          <input type="hidden" name="bid_amount" value="${bid}">
          <div class="auction_item_div item-i-1" data-tooltip='${tooltip}' data-price-gold="${price}"></div>
        </form>
      </body>
    </html>
  `;
}

async function runAuctionBackgroundScannerTests() {
  const auctionUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=auction&sh=test";
  const calls = [];
  const { schema, scanner, storage } = makeAuctionBackgroundScannerContext({
    fetch: async (rawUrl, options) => {
      calls.push({
        url: String(rawUrl),
        method: options.method,
        body: options.body.toString()
      });
      return {
        ok: true,
        status: 200,
        async text() {
          return auctionHtmlFixture();
        }
      };
    }
  });

  const result = await scanner.forceScan({
    sourceUrl: auctionUrl,
    sharedFilters: {
      qry: "",
      itemLevel: "39",
      itemQuality: "-1",
      csrfToken: "csrf-test"
    },
    formFields: [
      ["qry", ""],
      ["itemLevel", "1"],
      ["itemQuality", "-1"],
      ["csrf_token", "old-token"]
    ],
    sources: [{
      label: "Gladiator necessities",
      url: auctionUrl,
      categories: [schema.getScanCategory("main:2")]
    }]
  });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].categoryId, "main:2");
  assert.equal(result.items[0].bidAmount, 250);
  assert.equal(result.items[0].itemValue, 1250);
  assert.equal(result.categoriesScanned, 1);
  assert.equal(storage[schema.storageKeys.scanResult].items[0].auctionId, "auction-1");

  const body = new URLSearchParams(calls[0].body);
  assert.equal(calls[0].method, "POST");
  assert.equal(body.get("itemType"), "2");
  assert.equal(body.get("itemLevel"), "39");
  assert.equal(body.get("csrf_token"), "csrf-test");
}

async function runBackgroundScannerTests() {
  const singleArenaUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=2&sh=test";
  const teamArenaUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=3&sh=test";
  const singleList = arenaListFixture({ aType: "2", players: [{ id: "111", name: "Alpha" }] });
  const changedSingleList = arenaListFixture({ aType: "2", players: [{ id: "333", name: "Gamma" }] });
  const teamList = arenaListFixture({ aType: "3", players: [{ id: "222", name: "Bravo" }] });
  const profileHtmls = {
    111: profileFixture("Alpha"),
    222: profileFixture("Bravo", { tabs: teamTabsFixture("222") }),
    333: profileFixture("Gamma", { dexterity: 130 }),
    999: readyProfileFixture("Self", { level: 83 }),
    default: profileFixture("Fallback")
  };
  const calls = [];
  const setCalls = [];
  const { arena: backgroundArena, scanner, storage } = makeBackgroundScannerContext({
    setCalls,
    fetch: backgroundFetchFixture({ singleList, teamList, profileHtmls, calls })
  });

  const parsedEntries = scanner.readArenaOpponentEntriesFromHtml(singleList, singleArenaUrl);
  assert.equal(parsedEntries.length, 1);
  assert.equal(parsedEntries[0].opponent.id, "111");
  assert.equal(parsedEntries[0].opponent.arenaKind, "single");

  const parsedCharacter = scanner.parseCharacterFromHtml(profileHtmls[111], { id: "111" });
  assert.equal(parsedCharacter.name, "Alpha");
  assert.equal(parsedCharacter.stats.dexterity, 70);
  assert.equal(parsedCharacter.stats.damageAvg, 40);
  assert.deepEqual(JSON.parse(JSON.stringify(parsedCharacter.combat?.missing)), ["hp"]);

  const selfProfileUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=999&doll=1&sh=test";
  const selfProfileKey = backgroundArena.selfProfileStorageKey;
  storage[selfProfileKey] = {
    scannedAt: new Date().toISOString(),
    profileUrl: selfProfileUrl,
    playerId: "999",
    cacheKey: "s47-en.gladiatus.gameforge.com:999:1",
    character: { name: "Cached Self", combat: { ready: true } }
  };
  const callsBeforeCachedSelf = calls.length;
  const cachedSelf = await scanner.refreshSelfProfile({ profileUrl: selfProfileUrl });
  assert.equal(cachedSelf.character.name, "Cached Self");
  assert.equal(calls.length, callsBeforeCachedSelf);

  storage[selfProfileKey].scannedAt = new Date(Date.now() - backgroundArena.selfProfileMaxAgeMs - 1000).toISOString();
  const callsBeforeStaleSelf = calls.length;
  const staleSelf = await scanner.refreshSelfProfile({ profileUrl: selfProfileUrl });
  assert.ok(calls.length > callsBeforeStaleSelf);
  assert.equal(staleSelf.character.name, "Self");
  assert.ok(staleSelf.character.combat);
  assert.equal(storage[selfProfileKey].playerId, "999");

  const callsBeforeForcedSelf = calls.length;
  await scanner.refreshSelfProfile({ profileUrl: selfProfileUrl, force: true });
  assert.ok(calls.length > callsBeforeForcedSelf);

  const tabs = scanner.readProfileDollTabsFromHtml(profileHtmls[222], "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=222&sh=test");
  assert.equal(tabs.length, 5);
  assert.equal(tabs[0].doll, 2);
  assert.equal(tabs[0].role, "tank");
  assert.equal(tabs[1].role, "healer");

  const singleEntries = scanner.readArenaOpponentEntriesFromHtml(singleList, singleArenaUrl);
  const teamEntries = scanner.readArenaOpponentEntriesFromHtml(teamList, teamArenaUrl);
  await scanner.forceScan({ url: singleArenaUrl, entries: singleEntries });
  await scanner.forceScan({ url: teamArenaUrl, entries: teamEntries });

  const cacheKey = backgroundArena.passiveScansStorageKey;
  const statusKey = backgroundArena.scanStatusStorageKey;
  assert.equal(storage[cacheKey].single.result.arenaKind, "single");
  assert.equal(storage[cacheKey].team.result.arenaKind, "team");
  assert.equal(storage[cacheKey].single.result.opponents[0].opponent.id, "111");
  assert.equal(storage[cacheKey].team.result.opponents[0].opponent.id, "222");
  assert.equal(storage[cacheKey].single.result.opponents[0].character.doll, 1);
  assert.equal(storage[cacheKey].single.result.opponents[0].simulation.ready, false);
  assert.deepEqual(JSON.parse(JSON.stringify(storage[cacheKey].single.result.opponents[0].simulation.missing)), ["opponent hp"]);
  assert.equal(storage[cacheKey].single.result.bestName, "Alpha");
  assert.equal(storage[cacheKey].single.result.bestScore, storage[cacheKey].single.result.opponents[0].score);
  assert.equal(storage[cacheKey].team.result.bestName, "Bravo");
  assert.equal(storage[cacheKey].team.result.bestScore, storage[cacheKey].team.result.opponents[0].score);
  assert.equal(storage[cacheKey].team.result.bestWinRate, 0);
  assert.equal(storage[cacheKey].team.result.opponents[0].simulation.ready, false);
  assert.deepEqual(JSON.parse(JSON.stringify(storage[cacheKey].team.result.opponents[0].simulation.missing)), ["team simulation not supported"]);
  assert.equal(storage[statusKey].single.state, "ready");
  assert.equal(storage[statusKey].team.state, "ready");
  assert.equal(storage[statusKey].single.profileTotal, 1);
  assert.equal(storage[statusKey].team.profileTotal, 6);

  const singleProfileFetch = calls
    .filter((url) => isProfileFetch(url))
    .map((url) => new URL(url))
    .find((url) => url.searchParams.get("p") === "111");
  assert.ok(singleProfileFetch);
  assert.equal(singleProfileFetch.searchParams.get("doll"), "1");

  const teamProgressWrites = setCalls
    .map((call) => call[statusKey]?.team)
    .filter((record) => record?.state === "scanning");
  assert.ok(teamProgressWrites.some((record) => record.opponentTotal === 1 && record.profileTotal === 6 && record.profileDone > 0));
  assert.ok(teamProgressWrites.some((record) => /opponents \d+\/1/.test(record.message)));

  const quiet = await scanner.passiveCheck({ url: singleArenaUrl, preferredKind: "single" });
  assert.equal(quiet.find((result) => result.kind === "single").skipped, "quiet");
  assert.equal(storage[statusKey].single.message, "Ready");

  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  storage[cacheKey].single.scannedAt = old;
  storage[cacheKey].single.checkedAt = old;
  storage[cacheKey].single.result.scannedAt = old;
  const profileCallsBeforeUnchanged = calls.filter(isProfileFetch).length;
  const unchanged = await scanner.passiveCheck({ url: singleArenaUrl, preferredKind: "single" });
  assert.equal(unchanged.find((result) => result.kind === "single").skipped, "unchanged");
  assert.equal(calls.filter(isProfileFetch).length, profileCallsBeforeUnchanged);
  assert.equal(storage[statusKey].single.message, "Ready");

  const fresh = await scanner.passiveCheck({ url: singleArenaUrl, preferredKind: "single" });
  assert.equal(fresh.find((result) => result.kind === "single").skipped, "fresh");
  assert.equal(storage[statusKey].single.message, "Ready");

  {
    const reportUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=reports&submod=showCombatReport&t=2&reportId=31712867&sh=test";
    const reportCalls = [];
    const reportContext = makeBackgroundScannerContext({
      fetch: backgroundFetchFixture({
        singleList,
        teamList,
        profileHtmls,
        calls: reportCalls
      })
    });
    const reportResult = await reportContext.scanner.passiveCheck({
      url: reportUrl,
      preferredKind: "single",
      force: true,
      onlyPreferred: true
    });
    assert.equal(reportResult.map((result) => result.kind).join(","), "single");
    assert.equal(reportContext.storage[reportContext.arena.resultsStorageKey].arenaKind, "single");
    assert.equal(reportContext.storage[reportContext.arena.passiveScansStorageKey].single.result.opponents[0].opponent.id, "111");
    assert.equal(reportCalls.filter((url) => new URL(url).searchParams.get("aType") === "3").length, 0);
  }

  {
    let quietList = singleList;
    const quietCalls = [];
    const quietStorage = {};
    const quietContext = makeBackgroundScannerContext({
      storage: quietStorage,
      fetch: async (rawUrl) => backgroundFetchFixture({
        singleList: quietList,
        teamList: "",
        profileHtmls,
        calls: quietCalls
      })(rawUrl)
    });
    const quietEntries = quietContext.scanner.readArenaOpponentEntriesFromHtml(singleList, singleArenaUrl);
    await quietContext.scanner.forceScan({ url: singleArenaUrl, entries: quietEntries });
    const quietCacheKey = quietContext.arena.passiveScansStorageKey;
    const quietStatusKey = quietContext.arena.scanStatusStorageKey;
    quietStorage[quietCacheKey].single.checkedAt = new Date(Date.now() - quietContext.scanner.listCheckIntervalMs - 1000).toISOString();
    quietList = changedSingleList;

    const quietProfileCallsBefore = quietCalls.filter(isProfileFetch).length;
    const quietChanged = await quietContext.scanner.passiveCheck({ url: singleArenaUrl, preferredKind: "single" });
    assert.equal(quietChanged.find((result) => result.kind === "single").scanned, true);
    assert.ok(quietCalls.filter(isProfileFetch).length > quietProfileCallsBefore);
    assert.equal(quietStorage[quietCacheKey].single.result.opponents[0].opponent.id, "333");
    assert.equal(quietStorage[quietStatusKey].single.state, "ready");
  }

  const changedEntries = scanner.readArenaOpponentEntriesFromHtml(changedSingleList, singleArenaUrl);
  const profileCallsBeforeVisible = calls.filter(isProfileFetch).length;
  await scanner.ensureVisibleScan({ url: singleArenaUrl, entries: changedEntries });
  assert.ok(calls.filter(isProfileFetch).length > profileCallsBeforeVisible);
  assert.equal(storage[cacheKey].single.result.opponents[0].opponent.id, "333");

  const readyList = arenaListFixture({ aType: "2", players: [{ id: "444", name: "Delta" }] });
  const readyProfileHtmls = {
    444: readyProfileFixture("Delta", { life: 1700, damage: "20 - 30" }),
    999: readyProfileFixture("Self", { life: 2200, damage: "40 - 60" }),
    default: profileFixture("Fallback")
  };
  const readyCalls = [];
  const readyContext = makeBackgroundScannerContext({
    fetch: backgroundFetchFixture({
      singleList: readyList,
      teamList: "",
      profileHtmls: readyProfileHtmls,
      calls: readyCalls
    })
  });
  const readySelfUrl = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=player&p=999&doll=1&sh=test";
  readyContext.storage[readyContext.arena.selfProfileStorageKey] = {
    scannedAt: new Date().toISOString(),
    profileUrl: readySelfUrl,
    playerId: "999",
    cacheKey: "s47-en.gladiatus.gameforge.com:999:1",
    character: readyContext.scanner.parseCharacterFromHtml(readyProfileHtmls[999], {
      id: "999",
      profileUrl: readySelfUrl,
      doll: 1
    })
  };
  const readyEntries = readyContext.scanner.readArenaOpponentEntriesFromHtml(readyList, singleArenaUrl);
  const readyResult = await readyContext.scanner.forceScan({ url: singleArenaUrl, entries: readyEntries });
  const readySimulation = readyResult.opponents[0].simulation;
  assert.equal(readySimulation.ready, true);
  assert.equal(readySimulation.iterations, 500);
  assert.equal(readySimulation.wins + readySimulation.losses + readySimulation.draws, 500);
  assert.equal(readyResult.bestName, "Delta");
  assert.equal(readyResult.bestWinRate, readySimulation.winRate);
  assert.equal(Object.hasOwn(readySimulation, "rounds"), false);
  assert.equal(Object.hasOwn(readySimulation, "logs"), false);

  readyContext.storage[readyContext.arena.selfProfileStorageKey].scannedAt = new Date(Date.now() - readyContext.arena.selfProfileMaxAgeMs - 1000).toISOString();
  const staleSimulationResult = await readyContext.scanner.forceScan({ url: singleArenaUrl, entries: readyEntries });
  assert.equal(staleSimulationResult.opponents[0].simulation.ready, false);
  assert.deepEqual(JSON.parse(JSON.stringify(staleSimulationResult.opponents[0].simulation.missing)), ["self profile stale"]);

  const errorStorage = {
    [cacheKey]: {
      single: {
        listUrl: singleArenaUrl,
        checkedAt: old,
        scannedAt: old,
        fingerprint: "old",
        formulaFingerprint: "old",
        result: { scannedAt: old, opponentCount: 1 }
      },
      team: {}
    }
  };
  const errorContext = makeBackgroundScannerContext({
    storage: errorStorage,
    fetch: async () => ({
      ok: false,
      status: 503,
      async text() {
        return "";
      }
    })
  });
  await errorContext.scanner.passiveCheck({ url: singleArenaUrl, preferredKind: "single" });
  assert.equal(errorStorage[statusKey].single.state, "error");
  assert.equal(errorStorage[statusKey].single.message, "Error fetching list");
}

{
  // arena-fight.js: fight-request construction, isolated from any UI.
  const context = {
    console,
    URL,
    Date,
    Math,
    chrome: { runtime: { id: "test" } }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ["score-model.js", "arena-core.js", "arena-fight.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootDir, file), "utf8"), context, { filename: file });
  }
  const fight = context.GladiatusArenaFight;
  assert.ok(fight, "GladiatusArenaFight should be defined");

  const circusSource = "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=3&sh=ABC";
  const circusEndpoint = fight.fightEndpoint({ id: "219126", province: "306", language: "en", arenaKind: "team" }, circusSource);
  assert.equal(circusEndpoint.path, "ajax.php");
  assert.equal(circusEndpoint.opponentId, "219126");
  assert.ok(circusEndpoint.data.includes("submod=doCombat"));
  assert.ok(circusEndpoint.data.includes("aType=3"));
  assert.ok(circusEndpoint.data.includes("opponentId=219126"));
  assert.ok(circusEndpoint.data.includes("serverId=306"));
  assert.ok(circusEndpoint.data.includes("country=en"));

  const arenaEndpoint = fight.fightEndpoint(
    { id: "555", province: "47", language: "en", arenaKind: "single" },
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=2&sh=ABC"
  );
  assert.ok(arenaEndpoint.data.includes("aType=2"));

  const groupEndpoint = fight.fightEndpoint(
    { id: "777", arenaKind: "team" },
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=grouparena&sh=ABC"
  );
  assert.equal(groupEndpoint.path, "ajax/doGroupFight.php");
  assert.equal(groupEndpoint.data, "did=777");

  const plainEndpoint = fight.fightEndpoint(
    { id: "888", arenaKind: "single" },
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&sh=ABC"
  );
  assert.equal(plainEndpoint.path, "ajax/doArenaFight.php");
  assert.equal(plainEndpoint.data, "did=888");
  assert.equal(fight.fightEndpoint({ id: "" }, circusSource), null);

  // Best target comes from the stored result's bestName.
  const result = {
    arenaKind: "team",
    sourceUrl: circusSource,
    bestName: "AedileAulus",
    opponents: [
      { displayName: "Erudito", score: 50, opponent: { id: "31675", name: "Erudito", province: "306", language: "en", arenaKind: "team" } },
      { displayName: "AedileAulus", score: 40, opponent: { id: "219126", name: "AedileAulus", province: "306", language: "en", arenaKind: "team" } }
    ]
  };
  const target = fight.bestTargetFromResult(result);
  assert.equal(target.name, "AedileAulus");
  assert.equal(target.opponentId, "219126");
  assert.ok(target.request.data.includes("opponentId=219126"));
  assert.equal(fight.bestTargetFromResult({ opponents: [] }), null);
  assert.equal(fight.bestTargetFromResult(null), null);

  // buildFightRequest assembles the URL + headers and requires both tokens.
  const built = fight.buildFightRequest(target, { origin: "https://s47-en.gladiatus.gameforge.com", sh: "ABC", csrfToken: "CSRF" });
  assert.ok(built.url.startsWith("https://s47-en.gladiatus.gameforge.com/game/ajax.php?"));
  assert.ok(built.url.includes("submod=doCombat"));
  assert.ok(built.url.includes("&sh=ABC"));
  assert.equal(built.options.method, "GET");
  assert.equal(built.options.headers["X-CSRF-Token"], "CSRF");
  assert.throws(() => fight.buildFightRequest(target, { origin: "https://x", sh: "ABC", csrfToken: "" }), /CSRF/);
  assert.throws(() => fight.buildFightRequest(target, { origin: "https://x", sh: "", csrfToken: "C" }), /secure hash/);

  // parseFightError surfaces the game's rejection message (e.g. cooldown) instead of faking success.
  const creds = { origin: "https://s47-en.gladiatus.gameforge.com", sh: "ABC", csrfToken: "C" };
  const errorBody = "document.getElementById('errorRow').style.display = 'block';\n"
    + "document.getElementById('errorText').innerHTML = 'You can only challenge an opponent every 15 <a href=\"x\">(Centurion)</a> minutes.';";
  const message = fight.parseFightError(errorBody);
  assert.ok(/You can only challenge an opponent every 15/.test(message));
  assert.doesNotMatch(message, /<a /);
  assert.equal(fight.parseFightError("setData('<div>report</div>');"), "");

  // combatReportUrlFromResponse follows the success redirect to the exact report.
  const successBody = "document.location.href='index.php?mod=reports&submod=showCombatReport&t=2&reportId=31964876&sh=ZZ';";
  const reportUrl = fight.combatReportUrlFromResponse(successBody, creds);
  assert.ok(reportUrl.includes("submod=showCombatReport"));
  assert.ok(reportUrl.includes("reportId=31964876"));
  assert.ok(reportUrl.includes("t=2"));
  assert.ok(reportUrl.startsWith("https://s47-en.gladiatus.gameforge.com/game/index.php?"));
  assert.ok(fight.combatReportUrlFromResponse("document.location.href='index.php?submod=showCombatReport&reportId=99';", creds).includes("sh=ABC"));
  assert.equal(fight.combatReportUrlFromResponse("document.location.href='index.php?mod=overview';", creds), "");
  assert.equal(fight.combatReportUrlFromResponse("no redirect here", creds), "");
}

async function runAsyncTests() {
  await runAuctionBackgroundScannerTests();
  await runBackgroundScannerTests();
}

runAsyncTests()
  .then(() => {
    console.log("architecture tests passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
