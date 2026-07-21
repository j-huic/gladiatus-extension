# Gladiatus Helper (Unofficial)

A local Chrome MV3 extension with three independently optional Gladiatus helpers:

- auction page sorting, ranking rules, and multi-category scans;
- arena opponent insights, profile scans, simulations, and optional user-clicked quick-fight shortcuts;
- automatic guild-market price filling for matching rules, without submitting listings.

It reads the visible auction item tooltip data from `data-tooltip`, parses stat lines such as `Strength +11% (+5)` or `Damage 50 - 62`, and reorders the current auction page in the browser. It works across auction item types because the parser reads the item tooltip data for each visible listing instead of assuming weapons, shields, helmets, or any other category.

The extension does not bid, buy, submit market listings, or contact developer-owned or unrelated third-party services. Enabled scanners request Gladiatus Gameforge pages with the active browser session. In the private full build, the optional Arena/Circus ⚔ shortcut sends a fight request only after the user explicitly clicks it. The guild-market release contains no fight code. Settings, rules, and scan caches remain in local extension storage. Stored and exported records remove known session and CSRF parameters.

On a fresh installation all three features are off until they are selected in onboarding. They can be enabled, configured, or disabled independently from the popup. Disabling a feature keeps its settings and cached data until the user clears them.

## Build And Load In Chrome

Build both Chrome-loadable targets from the repository root:

```sh
npm run build
```

Then open `chrome://extensions`, enable Developer mode, click **Load unpacked**, and select one of:

- `dist/full/` for the private three-feature development build;
- `dist/guild-market/` for the single-purpose Guild Market release candidate.

The repository root is source and tooling, not a loadable extension package.

## Project Layout

```text
src/
  features/          auction, arena, and guild-market feature code
  shared/            settings, security, parsing, styles, and logging
  runtime/           full-build background worker and feature runtime
  popup/             full-build popup shell and views
targets/
  full/              full extension manifest
  guild-market/      narrow release manifest and dedicated shell
scripts/             deterministic target builders
tests/               lifecycle, boundary, safety, and build tests
dist/                generated Chrome-loadable artifacts
```

## Guild-Market-Only Release

The public release can be built as a physically separate, single-purpose extension. This artifact contains only automatic Mini-Pumpkin Guild Market pricing; it does not package the auction, arena, scanner, simulation, diagnostics, or generic popup modules.

```sh
npm run build:guild-market
```

The command creates:

- `dist/guild-market/` for **Load unpacked** testing;
- `dist/gladiatus-guild-market-1.0.0.zip` as the reproducible release-code ZIP.

The guild-only popup has one enable switch and one unit-price field. Fresh installs default to off. If this package updates the full extension under the same extension ID, it imports only the existing Mini-Pumpkin enabled state and unit price into the dedicated `glad-guild-market-settings-v1` record. Other stored feature data is left untouched but no code capable of using it is included in the artifact.

Verify the allowlisted package boundary with:

```sh
npm run test:guild-market-build
```

The release-specific privacy text is in `targets/guild-market/PRIVACY.md`. The 128×128 extension icon is included in the allowlisted package; store listing screenshots and promotional imagery still need to be prepared before submission.

## Notes

- Open the extension popup on an auction page and click `Scan auction` to fetch all auction categories with your current name, minimum-level, and quality filters.
- Open the extension popup on an arena page and click `Scan opponents` to fetch the visible opponent profiles, sum their six primary stats, and show the score next to each arena row.
- Arena profile fetching is handled by the extension background worker because opponents may be on another Gladiatus province/subdomain.
- The scanner attempts both auction groups from one button by using the auction-page links for Gladiator necessities and Mercenary necessities.
- A successful auction scan replaces the current cached item list. The previous scan is compacted into a bounded local archive in extension storage for later debugging/comparison.
- The auction popup separates scan results from `Ranking rules`; ranking rules define scoring, while page filters narrow visible items.
- Popup tabs group results into Weapons, Armor, Food, Upgrades, and Mercenaries. Each tab keeps its own selected sort preset.
- Browsing cached results never changes the live auction page. Applying a popup ranking to the page is a separate, optional action.
- Popup item rows show thumbnails when the game exposes an image URL or inline icon background style in the auction markup.
- Default popup sorting is average weapon damage, food healing per gold, armor main-character score, upgrade damage, and mercenary agility.
- The in-page auction sorter uses those same defaults for each auction item type, then remembers manual sort changes per item type.
- The in-page sort dropdown only shows preset scores for the current item group; generic stat and field sorts remain available everywhere.
- Enabled custom filters are saved in `chrome.storage.local` under `glad-ah-custom-definitions-v1` and appear as group-specific custom score presets.
- Popup and in-page filter values are shared in `chrome.storage.local` under `glad-ah-filter-values-v1`.
- Armor has a configurable `Min bonus damage` filter. It defaults to `0`, so it only filters once raised.
- Armor main-character score is `agility + dexterity + ((damage bonus + strength / 10) * 8)`.
- Sorting affects only the currently visible auction page.
- Use the game filter first for item type, level, and quality, then sort the visible results by Strength, Dexterity, Agility, Constitution, Charisma, Intelligence, Life points, Health, Armour, Damage bonus, weapon damage, Block value, Healing, and related values.
- `High first` is the default for stats. `Immediate gold` defaults to low first.
- The selected sort stat and sort direction are persisted across auction filter reloads.
- If you change files while the extension is already loaded, click the extension reload button on `chrome://extensions`, then refresh the Gladiatus page.
- Diagnostics are off by default. When enabled, debug records can be exported explicitly from Settings and contain redacted Gameforge URLs.

## DevTools API

The shared schema and scanner/parser are exposed on the auction page as:

```js
window.GladiatusAuctionSchema
window.GladiatusAuctionCore
```

Useful calls:

```js
await window.GladiatusAuctionCore.scanAllAuctionItems()
window.GladiatusAuctionCore.parseStats(["Healing +87,+11", "Intelligence +21"])
```

The schema owns stat keys, display labels, stable auction category ids, and storage keys. The same core parser contract is loaded in the page, isolated content-script, popup, and background contexts; full popup scans run through the gated background worker. The DevTools scan API can still run directly in the page, first trying normal page fetches and falling back to hidden same-origin iframe/form loads when fetches are blocked.

## Architecture Checks

```sh
npm test
npm run build
git diff --check
```

## Adding Presets And Filters

Auction groups, score formulas, and filters are isolated in `src/features/auction/auction-model.js`. Stable stat/category/storage contracts are isolated in `src/features/auction/auction-schema.js`. The popup and auction content script consume those definitions instead of duplicating formulas.

Custom filters created in the popup use this shape:

```js
{
  id: "armor-dps",
  name: "Armor DPS",
  appliesTo: ["armor"],
  terms: [
    { stat: "agility", weight: 1 },
    { stat: "dexterity", weight: 1 },
    { stat: "damageBonus", weight: 10 }
  ],
  constraints: [
    { stat: "damageBonus", op: ">=", value: 6 }
  ],
  enabled: true
}
```

The score is the sum of each stat multiplied by its weight. Constraints support `>=` and `<=`; all constraints must pass for an item to remain visible when that custom preset is selected.

To add a numeric minimum filter to a group, add it to that view:

```js
filters: [
  defineMinimumStatFilter({
    id: "minDamageBonus",
    label: "Min bonus damage",
    statKey: "damageBonus"
  })
]
```

Score presets use the same pattern:

```js
defineScorePreset({
  id: "main",
  label: "Main: Agi/Dex + dmg x8",
  score: mainCharacterScore
})
```

## Parsed Tooltip Formats

- Equippable weapons: `Damage 56 - 71` and compound durability lines like `Damage 56 - 71,+7 - 9`; the base range before the comma is used for sorting.
- Non-weapon equipment: flat damage lines like `Damage +7`, `Damage +5,0`, and `Damage +8,+1`; the base value before the comma is used for sorting.
- Upgrades: usage lines like `Using: +10 Damage` or `Using: +6 Charisma`.
- Food: usage lines like `Using: Heals 798 of life`; only the first healed-life number is counted, so intelligence/vitality breakdown numbers in the same sentence are ignored.
- Mercenary contracts: absolute stat lines like `Life points: 2130` and `Strength: 98`.
- Mercenary equipment: regular equipment stats plus fields like `Threat`, `Block value`, `Healing`, and critical values.
