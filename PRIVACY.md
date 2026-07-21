# Privacy

Gladiatus Helper (Unofficial) runs locally in Chrome. It does not send data to the extension developer, analytics providers, advertising services, or unrelated third parties.

When its features are enabled, the extension reads Gladiatus page content and may request other `*.gladiatus.gameforge.com` pages with the browser's active Gameforge session. This is used for auction scans and arena opponent/profile insights. It does not submit bids, purchases, or guild-market listings. In the private full build, enabling Quick-fight adds Arena and Circus shortcuts that send a fight request only after the user explicitly clicks one. The public guild-market build contains no fight code.

The extension stores feature settings, pricing and ranking rules, scan results, and profile-derived statistics in `chrome.storage.local`. Optional diagnostic logs use extension storage and are disabled by default. Known authentication parameters such as `sh` and CSRF tokens are removed before records are stored or exported.

Users can disable features without deleting their preferences, clear individual feature caches, or clear all extension data from the popup settings. Uninstalling the extension also removes its extension storage under Chrome's normal extension-data behavior.

Gladiatus Helper is an unofficial community tool and is not affiliated with or endorsed by Gameforge.
