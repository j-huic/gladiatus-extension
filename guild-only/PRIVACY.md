# Privacy — Gladiatus Guild Market Helper

Gladiatus Guild Market Helper (Unofficial) runs locally in Chrome. It does not send data to the extension developer, analytics providers, advertising services, or unrelated third parties.

When enabled on a Gladiatus Guild Market page, the extension reads the item staged in the game's sell form so it can match Mini-Pumpkin and calculate a suggested stack price. Clicking **Apply suggested price** fills only the price field and asks the page to recalculate its displayed fee. The extension does not submit the form or list an item.

The extension does not fetch any pages. It uses the already-open `*.gladiatus.gameforge.com` Guild Market page and the browser's active Gameforge session only to provide its on-page interface.

The extension stores only its enabled state and the chosen Mini-Pumpkin unit price in `chrome.storage.local`. It does not store staged item details, account credentials, diagnostic logs, or browsing history. Uninstalling the extension removes its extension storage under Chrome's normal extension-data behavior.

Gladiatus Guild Market Helper is an unofficial community tool and is not affiliated with or endorsed by Gameforge.
