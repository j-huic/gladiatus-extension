const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const relativeByBasename = Object.freeze({
  "helper-security.js": "src/shared/helper-security.js",
  "helper-settings.js": "src/shared/helper-settings.js",
  "tooltip-parser.js": "src/shared/tooltip-parser.js",
  "score-model.js": "src/shared/score-model.js",
  "styles.css": "src/shared/styles.css",
  "log-core.js": "src/shared/logging/log-core.js",
  "log-buffer.js": "src/shared/logging/log-buffer.js",
  "log-drain.js": "src/shared/logging/log-drain.js",
  "log-setup.js": "src/shared/logging/log-setup.js",
  "auction-schema.js": "src/features/auction/auction-schema.js",
  "auction-core.js": "src/features/auction/auction-core.js",
  "auction-model.js": "src/features/auction/auction-model.js",
  "auction-content.js": "src/features/auction/auction-content.js",
  "auction-background-scan.js": "src/features/auction/auction-background-scan.js",
  "arena-core.js": "src/features/arena/arena-core.js",
  "arena-sim.js": "src/features/arena/arena-sim.js",
  "arena-scan.js": "src/features/arena/arena-scan.js",
  "arena-passive-content.js": "src/features/arena/arena-passive-content.js",
  "arena-fight.js": "src/features/arena/arena-fight.js",
  "arena-header-button.js": "src/features/arena/arena-header-button.js",
  "arena-status-content.js": "src/features/arena/arena-status-content.js",
  "arena-content.js": "src/features/arena/arena-content.js",
  "arena-background-scan.js": "src/features/arena/arena-background-scan.js",
  "guild-market-core.js": "src/features/guild-market/guild-market-core.js",
  "guild-market-content.js": "src/features/guild-market/guild-market-content.js",
  "background.js": "src/runtime/background.js",
  "feature-runtime.js": "src/runtime/feature-runtime.js",
  "popup.html": "src/popup/popup.html",
  "popup.css": "src/popup/popup.css",
  "popup.js": "src/popup/popup.js"
});

function repoFile(file) {
  const value = String(file || "");
  if (path.isAbsolute(value)) return value;
  return path.join(rootDir, relativeByBasename[value] || value);
}

module.exports = Object.freeze({ rootDir, relativeByBasename, repoFile });
