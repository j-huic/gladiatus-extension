# Guild Market auto-pricing investigation handoff

## Purpose and current status

This report records the unresolved Guild Market price-overwrite regression as of 2026-07-22.

The observed behaviour is consistent across several attempted fixes:

1. A supported item is staged on the Guild Market page.
2. The helper's intended total price appears briefly in `#preis`.
3. Within roughly 50–100 ms, another writer changes it back to the unwanted/default value.
4. The intended price does not visibly return.

The helper has not been live-reproduced during this session. The Chrome DevTools MCP browser was recovered from a stale process, but it had only an `about:blank` page and no logged-in Gladiatus tab. Do not assume that the current unit tests prove the real browser race is solved.

## Scope and safety constraints

- The helper may only change the native Guild Market price input (`#preis`) and call the native fee recalculation (`calcDues`).
- It must never submit/list an item, bid, purchase, log in, solve a CAPTCHA, or take another account-changing action.
- It must preserve a manual edit while the user is actively editing the price input.
- The standalone release is intentionally narrow. Its public manifest, popup, README, and privacy disclosure describe Mini-Pumpkin only.
- A hidden Meat Haunch substring rule was added solely to make local/manual testing possible. It is not a public feature or documented product capability.

## How the original working implementation behaved

The historical implementation is in commit `9a0b5e5e7313e2811806f89412175b9124135604`, file `guild-market-core.js` before the feature-isolation refactor.

It ran entirely in the page's MAIN world and directly wrapped `window.marketDrop`:

1. Call the game's original `marketDrop(to, amount)`.
2. Detect a Mini-Pumpkin from the tooltip.
3. Immediately assign `#preis.value = quantity * 100000` and call `calcDues()`.
4. Start a short guard:
   - `setInterval` every **50 ms**;
   - run for **1500 ms**;
   - look up `document.getElementById('preis')` fresh on every check;
   - if the value differs, restore it and call `calcDues()`;
   - stop only if the staged `sellid` changes or the price field has focus.

The original code explicitly documented the competing-helper race: another extension wrote `#preis` about 100 ms after a drop. This is the clearest available evidence that a bounded reassertion was intentional and previously effective.

Relevant old functions:

- `applyAutoPrice(to, amount)`
- `reassertIfClobbered(target, expectedSellid)`
- `guardPrice(target)`

## Structural changes that introduced the regression

### `007080e` — feature isolation and guarded bridges

The old direct pricing + guard implementation was replaced with a split architecture:

```text
MAIN world marketDrop wrapper
  -> postMessage(staged item)
  -> isolated content controller
  -> chrome.runtime message
  -> service worker
  -> chrome.scripting.executeScript in MAIN world
  -> fillPriceField()
```

The new MAIN-world module deliberately became inert until the feature was enabled. The old direct `applyAutoPrice`, `reassertIfClobbered`, and `guardPrice` functions were removed. At that point price filling was explicit/user-initiated rather than automatic.

This isolation was valid for Chrome Web Store safety and lifecycle control, but it removed the concurrency behaviour that defeated the other extension.

### `3a73122` — automatic pricing restored

Automatic filling was restored, but only as a single `fillPriceField()` call through the message/service-worker bridge. The code and tests explicitly stated that it would **not reassert** after another write.

### `7fd3ab3` — UI cleanup

The visible page panel/status UI was removed. This did not create the overwrite issue, but it removed the on-page indication that a request was sent or whether it failed.

## Current architecture

Current relevant files:

- `src/features/guild-market/guild-market-core.js` — MAIN-world bridge/wrapper/price write.
- `src/features/guild-market/guild-market-content.js` — isolated-world matching and request dispatch.
- `src/runtime/background.js` — full-build bridge to MAIN-world `fillPriceField`.
- `targets/guild-market/background.js` — equivalent standalone bridge.
- `tests/guild-market.test.js` — fake-DOM integration coverage.
- `tests/guild-market-build.test.js` — standalone package/background coverage.

The current flow is still asynchronous after `marketDrop`:

```text
game marketDrop
  -> wrapper captures staged state and posts a window message
  -> isolated content chooses a rule and asks the service worker to fill
  -> service worker executes fillPriceField in MAIN world
  -> fillPriceField writes #preis and starts the guard
```

This is materially different from the old implementation, which wrote and armed its guard synchronously inside the `marketDrop` wrapper.

## Changes attempted in this session

### 1. Initial bounded guard

First attempt added a 100 ms / 500 ms guard after `fillPriceField()`.

It was insufficient in live testing. Code review identified two possible self-cancellation paths:

- it retained the original input element rather than looking up `#preis` again, so an input replacement/re-render could make it write to a detached node;
- it cancelled for any `input` event, including a synthetic event dispatched by another extension.

### 2. Fresh field lookup, synthetic-event tolerance, and 1.5 s duration

The guard was changed to find `#preis` on every tick, ignore untrusted `input` events, and run for 1.5 seconds. It still did not work in the user's live test.

### 3. Controller version bumps

The MAIN controller changed from v5 to v6 and then v7; isolated content changed from v4 to v5. This prevents an already-open page from rejecting a new injected copy merely because it reports the previous version number.

This was necessary for extension reload/reinjection scenarios, but did not resolve the reported live behaviour.

### 4. Restore the old guard criteria as closely as possible

The current dirty implementation uses the historical shape again:

- 50 ms interval;
- 1500 ms lifetime;
- fresh `#preis` lookup each time;
- continue through repeated staging calls as long as the `sellid` is unchanged;
- skip reassertion only while the input is focused;
- clear when stopped or when the `sellid` changes.

This is currently in `src/features/guild-market/guild-market-core.js` as `startPriceGuard`, `reassertGuardedPrice`, and `clearPriceGuard`.

Despite this, the user reports the same flash-then-wrong-value outcome. Treat the guard as **not proven to be running/effective in the real page**.

## Testing added and its limitations

Current fake-DOM tests cover:

- the original automatic price fill;
- a delayed value overwrite being restored;
- a replacement `#preis` element being found and corrected;
- a focused field not being fought while the user types;
- a repeated `marketDrop` call for the same item not cancelling the guard;
- a Meat Haunch variant matching its internal substring rule;
- standalone background validation for that internal test rule.

`npm test`, `npm run build`, manifest parsing, and `git diff --check` passed after the latest changes.

Important limitation: the fake timer harness invokes callbacks manually. It does not model Chromium extension execution worlds, service-worker lifecycle timing, page-specific event dispatch, jQuery/game code, DOM replacement timing, or the competing extension. A passing test only proves the code's internal branch logic.

## Current hypotheses

The remaining likely explanations are, in priority order:

1. **The updated MAIN-world code is not the code running in the tested tab.**
   The user may be loading a different unpacked target, a stale `dist/` directory, or an older installed extension. Reloading an extension alone is not enough in all cases; the Guild Market page needs a refresh after loading/reloading the correct target.

2. **The guard never starts in the live flow.**
   The initial flash proves some price write happened, but does not prove the latest `fillPriceField()` invoked the intended `startPriceGuard()` implementation. A stale controller, a different extension with the same observable behaviour, or a bridge execution mismatch could explain this.

3. **The competing extension writes continuously for longer than the guard window.**
   If it writes every 50 ms, or continues beyond 1.5 seconds, a bounded guard can still end on the wrong value. The old comment assumed one delayed write at roughly 100 ms; that assumption must be verified against the current competing extension.

4. **The game/other extension changes the staging identity before the check.**
   The current guard only keys to `sellid`, matching the old approach, but a real DOM inspection is needed to confirm whether the hidden sell id changes or disappears during the flash.

5. **The page is in a different frame/markup path than the code expects.**
   `#preis` may not be the surviving/visible input in the live page or could be recreated in a way not represented by the fake DOM.

6. **The competing code focuses the input.**
   The guard intentionally yields while `document.activeElement === #preis`. If another helper focuses the field and leaves focus there, the old-compatible guard will skip every check. This is testable with live instrumentation.

## Recommended next investigation (do this before more rewrites)

1. Use a logged-in Gladiatus Guild Market page through Chrome DevTools MCP. Do not bid, buy, list, log in, or otherwise mutate the account.

2. Verify the actual code/runtime state immediately after refreshing the page:

   ```js
   (() => ({
     coreVersion: globalThis.GladiatusGuildMarket?.version,
     contentVersion: globalThis.GladiatusGuildMarketController?.version,
     coreStatus: globalThis.GladiatusGuildMarket?.getStatus?.(),
     price: document.getElementById('preis')?.value,
     sellId: document.querySelector('#sellForm [name="sellid"]')?.value,
     activeId: document.activeElement?.id
   }))()
   ```

3. Add temporary, local-only diagnostic instrumentation to the guard (not to the Chrome Store release): log guard creation, every tick, current price, expected price, sell id, active element id, and whether the field is connected. Record timestamps with `performance.now()`.

4. Stage a harmless test item only. Capture the first 2 seconds of logs. This distinguishes:

   - no guard ticks at all;
   - ticks occurring but skipped because of focus/sell id;
   - ticks restoring the price but another writer immediately winning again;
   - a different current input/DOM path.

5. If another writer is continuous, decide explicitly between:

   - a longer bounded interval (for example 3–5 seconds), still yielding while the user focuses the field;
   - a temporary property-setter/event interception strategy in the MAIN world;
   - a user-clicked Apply action instead of automatic filling;
   - disabling compatibility with the competing extension.

Do not choose a permanent interception strategy without confirming the exact writer and considering its effect on a user's manual price edit.

## Current dirty-worktree notes

Guild Market changes in this session are intentionally uncommitted. The repository also contains unrelated user changes, notably the Smelting feature and popup files. Preserve those changes when continuing.

Relevant historical commits:

- `1e632ca` — initial 100k stack-price helper.
- `9a0b5e5` — known old guard implementation, including the competing-extension rationale.
- `007080e` — lifecycle/isolation refactor that removed the old guard.
- `3a73122` — automatic fill restored without reassertion.
- `7fd3ab3` — page UI cleanup; guard still absent at that point.

