const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { repoFile } = require("./test-paths.js");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

async function testFightRequests() {
  const storageKey = "glad-arena-passive-scans-v1";
  const storedResult = {
    arenaKind: "single",
    sourceUrl: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena",
    bestName: "Target",
    opponents: [{ displayName: "Target", opponent: { id: "88", name: "Target", arenaKind: "single" } }]
  };
  let fetchRequest = null;
  const context = {
    console,
    URL,
    Date,
    Math,
    Promise,
    GladiatusArenaCore: { passiveScansStorageKey: storageKey },
    location: {
      origin: "https://s47-en.gladiatus.gameforge.com",
      href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=overview&sh=ABC"
    },
    document: {
      querySelector(selector) {
        if (selector === 'meta[name="csrf-token"]') return { getAttribute: () => "CSRF" };
        return null;
      }
    },
    chrome: {
      storage: {
        local: {
          async get() {
            return { [storageKey]: { single: { result: storedResult } } };
          }
        }
      }
    },
    async fetch(url, options) {
      fetchRequest = { url, options };
      return {
        ok: true,
        async text() {
          return "document.location.href='index.php?mod=reports&submod=showCombatReport&reportId=12';";
        }
      };
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(repoFile("arena-fight.js"), "utf8"), context, { filename: "arena-fight.js" });

  const fight = context.GladiatusArenaFight;
  assert.ok(fight);
  const server = fight.fightEndpoint(
    { id: "219126", province: "306", language: "en", arenaKind: "team" },
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=serverArena&aType=3"
  );
  assert.equal(server.path, "ajax.php");
  assert.match(server.data, /submod=doCombat/);
  assert.match(server.data, /aType=3/);
  assert.equal(fight.fightEndpoint(
    { id: "777" },
    "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=arena&submod=grouparena"
  ).path, "ajax/doGroupFight.php");
  assert.equal(fight.fightEndpoint({ id: "888" }, storedResult.sourceUrl).path, "ajax/doArenaFight.php");

  const target = plain(fight.bestTargetFromResult(storedResult));
  assert.equal(target.name, "Target");
  assert.equal(target.opponentId, "88");
  const built = fight.buildFightRequest(target, {
    origin: context.location.origin,
    sh: "ABC",
    csrfToken: "CSRF"
  });
  assert.match(built.url, /^https:\/\/s47-en\.gladiatus\.gameforge\.com\/game\/ajax\/doArenaFight\.php\?/);
  assert.equal(built.options.headers["X-CSRF-Token"], "CSRF");
  assert.throws(
    () => fight.buildFightRequest(target, { origin: "https://example.com", sh: "ABC", csrfToken: "CSRF" }),
    /limited to Gladiatus/
  );
  assert.throws(
    () => fight.buildFightRequest(target, { origin: context.location.origin, sh: "", csrfToken: "CSRF" }),
    /secure hash/
  );

  const rejection = "document.getElementById('errorRow').style.display='block';"
    + "document.getElementById('errorText').innerHTML = 'Wait <b>15 minutes</b>.';";
  assert.equal(fight.parseFightError(rejection), "Wait 15 minutes .");
  const loaded = await fight.loadBestTarget("single");
  assert.equal(loaded.opponentId, "88");
  const outcome = await fight.fight(loaded);
  assert.match(fetchRequest.url, /doArenaFight\.php/);
  assert.equal(fetchRequest.options.credentials, "include");
  assert.match(outcome.reportUrl, /showCombatReport/);
  assert.match(outcome.reportUrl, /sh=ABC/);
}

function makeHeaderHarness() {
  const buttons = [];
  const ranks = new Map();
  const observers = [];
  const timers = new Map();
  let timerId = 0;
  let fights = 0;

  function makeClassList(element) {
    const values = new Set();
    return {
      add(...names) { for (const name of names) values.add(name); },
      remove(...names) { for (const name of names) values.delete(name); },
      contains(name) { return values.has(name); }
    };
  }

  function makeButton() {
    const listeners = new Map();
    const button = {
      dataset: {},
      className: "",
      disabled: false,
      isConnected: false,
      classList: null,
      setAttribute(name, value) { this[name] = value; },
      addEventListener(type, listener) { listeners.set(type, listener); },
      remove() {
        this.isConnected = false;
        const index = buttons.indexOf(this);
        if (index >= 0) buttons.splice(index, 1);
      },
      click() {
        listeners.get("click")?.({ preventDefault() {}, stopPropagation() {} });
      }
    };
    button.classList = makeClassList(button);
    return button;
  }

  for (const id of ["arenaPlace", "grouparenaPlace"]) {
    ranks.set(id, {
      after(button) {
        button.isConnected = true;
        buttons.push(button);
      }
    });
  }

  const document = {
    documentElement: {},
    getElementById(id) { return ranks.get(id) || null; },
    createElement() { return makeButton(); },
    querySelector(selector) {
      const kind = selector.match(/data-kind="([^"]+)"/)?.[1];
      return buttons.find((button) => button.dataset.kind === kind) || null;
    },
    querySelectorAll(selector) {
      return selector.includes("glad-arena-header-button") ? buttons.slice() : [];
    }
  };

  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe() { this.observing = true; }
    disconnect() { this.observing = false; }
  }

  const context = {
    console,
    URL,
    Promise,
    document,
    MutationObserver,
    location: {
      href: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=overview"
    },
    setTimeout(callback) {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); },
    GladiatusArenaFight: {
      async loadBestTarget(kind) { return { kind, name: "Target" }; },
      async fight() {
        fights += 1;
        return { reportUrl: "https://s47-en.gladiatus.gameforge.com/game/index.php?mod=reports" };
      }
    }
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(repoFile("arena-header-button.js"), "utf8"), context, { filename: "arena-header-button.js" });
  return { context, buttons, observers, timers, fights: () => fights };
}

async function testHeaderLifecycle() {
  const harness = makeHeaderHarness();
  const controller = harness.context.GladiatusArenaHeaderButtonFeature;
  assert.ok(controller);
  assert.equal(harness.buttons.length, 0, "loading is inert");

  await controller.start({ enabled: false, quickFight: true });
  await controller.start({ enabled: true, quickFight: false });
  assert.equal(harness.buttons.length, 0);

  const enabled = { enabled: true, quickFight: true };
  await controller.start(enabled);
  await controller.start(enabled);
  await controller.update(enabled);
  assert.equal(harness.buttons.length, 2, "repeated lifecycle calls do not duplicate controls");
  assert.equal(harness.observers.filter((observer) => observer.observing).length, 1);

  harness.buttons.find((button) => button.dataset.kind === "single").click();
  await settle();
  assert.equal(harness.fights(), 1);
  assert.match(harness.context.location.href, /mod=reports/);

  await controller.stop();
  await controller.stop();
  assert.equal(harness.buttons.length, 0);
  assert.equal(harness.observers.some((observer) => observer.observing), false);
  assert.equal(harness.timers.size, 0);
  assert.equal(controller.getStatus().active, false);
}

async function main() {
  await testFightRequests();
  await testHeaderLifecycle();
  console.log("arena quick-fight tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
