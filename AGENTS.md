# Agent Notes

This repo contains source and deterministic build targets for a local Chrome MV3 extension. Keep changes small, inspect the current code first, and preserve the separation between parsing, scoring, page injection, and popup UI.

## Live Browser Work

- Use Chrome DevTools MCP for live Gladiatus inspection. The in-app/browser-use browser does not share the logged-in game session reliably.
- If DevTools MCP reports a closed selected page, ask for an MCP/app reset instead of guessing from stale state.
- Before a full app reset, try MCP-level recovery (`list_pages`, `select_page`, `new_page`, `navigate_page`). If every call fails with the closed-page error, inspect local processes and restart only the Chrome child owned by `chrome-devtools-mcp` rather than the user's normal Chrome. It uses a separate profile under `~/.cache/chrome-devtools-mcp/chrome-profile` and can get stuck on a closed target after tabs are closed.
- Prefer inspecting the real DOM and network behavior before changing scraper logic. The game is stateful and the auction markup can differ between Gladiator and Mercenary necessities.
- Do not use live-browser tooling to trigger bids, purchases, login, CAPTCHA, fights, or other account-changing actions during inspection.
- The private full build may implement an explicitly user-clicked Arena/Circus fight shortcut. Keep that code isolated to `src/features/arena/` and ensure it is never packaged in the guild-market target.

## Website Facts

- Auction pages are under `https://*.gladiatus.gameforge.com/game/index.php?mod=auction`.
- The main auction group is `Gladiator necessities`; the mercenary equipment group is `Mercenary necessities` and uses `ttype=3`.
- Current known item type values:
  - Main: `1` weapons, `2` shields, `3` chest, `4` helmets, `5` gloves, `8` shoes, `6` rings, `9` amulets, `7` usable/food, `11` reinforcements, `12` upgrades, `15` mercenary contracts.
  - Mercenary equipment: `1`, `2`, `3`, `4`, `5`, `8`, `6`, `9` with `ttype=3`.
- Auction item data lives in `.auction_item_div` forms. The actual item icon has `data-tooltip`, `data-price-gold`, icon class/style, and sometimes image data.
- Tooltip JSON is the source of truth for item names and stats. Examples include `Damage 56 - 71`, `Damage +6`, `Strength +11% (+5)`, `Using: +10 Damage`, and `Using: Heals 798 of life`.
- Percentage stat lines usually include the effective value in parentheses. Use that parenthesized value; do not treat a bare `+10%` as `+10` stat points.
- POSTing auction filters needs the live page form's `csrf_token`. Documents parsed from fetched HTML may not include that token because game JS adds it.
- Arena opponent pages expose profile links in rows with `.attack` controls. Do not click the attack divs.
- Public player profile pages expose character stats through stable ids: `#char_f0` through `#char_f5`, `#char_panzer`, `#char_schaden`, and `#char_level`.
- Arena pages can list opponents from another province, so content-script fetches may hit cross-origin/CORS limits. Use the extension background fetch bridge for profile HTML.

## Architecture

- `src/features/auction/` owns auction contracts, parsing/scanning, scoring, content UI, and its background scan handler.
- `src/features/arena/` owns arena parsing, simulation, scans, annotations, passive/status controllers, and its background scan handler.
- `src/features/guild-market/` owns the inert MAIN-world bridge and isolated automatic price-fill controller.
- `src/shared/` owns settings, security, tooltip parsing, score primitives, feature-scoped page styles, and the diagnostics layer under `src/shared/logging/`.
- `src/runtime/` owns the full build's background worker and feature lifecycle coordinator.
- `src/popup/` owns the full build's popup shell, state, and feature views.
- `targets/full/manifest.json` describes the private three-feature build. `targets/guild-market/` is a deliberately self-contained, narrow release shell.
- `scripts/build-full.js` and `scripts/build-guild-market.js` are allowlisted builders. Chrome-loadable output belongs only under `dist/`.
- The full manifest loads page-world parsers/bridges in the MAIN world, then deterministic isolated controllers that remain inert until the runtime enables them.

## Design Principles

- Keep parser/scanner logic reusable from DevTools and from the extension popup. If a behavior is hard to test in DevTools, move it behind a small public API instead of duplicating it.
- Keep built-in presets code-defined and custom filters storage-defined. Custom filters are structured linear combinations plus simple constraints, not free-text expressions.
- Scanned items should carry stable `categoryId`, `viewId`, `group`, `itemType`, and `ttype` metadata so UI labels can change without breaking filtering.
- Favor adding small helpers to schema/model/core over leaking game-specific selectors or scoring formulas into popup/content UI code.
- Preserve local-only behavior: use the logged-in game tab/session and `chrome.storage.local`; do not send data to external services.
- Keep arena and auction feature paths separate unless a shared contract genuinely belongs in schema or storage.

## Verification

Run these after changes:

```sh
npm test
npm run build
node -e "for (const file of ['targets/full/manifest.json', 'targets/guild-market/manifest.json']) JSON.parse(require('fs').readFileSync(file, 'utf8')); console.log('manifests ok')"
git diff --check
```

For browser checks, load or reload `dist/full/` or `dist/guild-market/` in `chrome://extensions`, refresh the relevant Gladiatus page, then inspect with Chrome DevTools MCP.
