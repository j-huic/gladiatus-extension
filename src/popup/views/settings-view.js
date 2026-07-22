import { FEATURE_SETTINGS, featureModules, nodes, setStatus } from "../runtime.js";
import { state } from "../store.js";

const FEATURE_DEFINITIONS = [
  {
    id: "auction",
    title: "Auction tools",
    description: "Rank the current page or scan auction categories into a separate cached list.",
    capabilities: [
      ["pageSorter", "Current-page ranking", "Reorder visible auction items only after you press Apply."],
      ["fullScan", "Full auction scan", "Fetch configured auction categories and cache the results."],
      ["scoreBadges", "Score badges", "Show ranking information next to auction items."],
      ["applyRankingToPage", "Allow popup Apply", "Let the popup explicitly send the selected ranking to the open auction page."]
    ]
  },
  {
    id: "arena",
    title: "Arena insights",
    description: "Inspect opponents, estimate matchups, and optionally fight the best cached target from the header.",
    capabilities: [
      ["annotations", "Opponent annotations", "Show read-only profile insights beside arena rows."],
      ["manualScan", "Manual opponent scan", "Scan visible opponents when you request it."],
      ["simulations", "Matchup simulations", "Estimate win likelihood from cached combat stats."],
      ["passiveRefresh", "Passive refresh", "Refresh eligible opponent information in the background."],
      ["statusWidget", "Page status widget", "Show scan freshness on Gladiatus pages."],
      ["quickFight", "Quick-fight header buttons", "Add ⚔ shortcuts beside Arena and Circus that immediately fight the best cached opponent when clicked."]
    ]
  },
  {
    id: "guildMarket",
    title: "Guild Market pricing",
    description: "Automatically fill stack prices from matching rules while leaving submission to you.",
    capabilities: []
  }
];

export function createSettingsView({ render, navigate, clearFeatureCache, clearAllData }) {
  function renderOnboarding() {
    const page = shellPage("onboarding-page");
    const intro = document.createElement("section");
    intro.className = "onboarding-card";
    intro.append(
      heading("Choose your Gladiatus tools"),
      paragraph("Each feature is independent. Start with only the helpers you want; you can change these choices in Settings at any time.", "shell-intro"),
      notice("The extension reads relevant Gladiatus pages using your existing signed-in session. Data and preferences remain in this browser. It never bids, buys, or lists an item. If enabled, a Quick-fight button starts a fight only when you explicitly click it.")
    );
    page.append(intro, renderFeatureGrid({ onboarding: true }));

    const actions = document.createElement("div");
    actions.className = "onboarding-actions";
    const complete = actionButton("Save choices and continue", "complete-onboarding");
    actions.append(complete);
    page.append(actions);
    nodes.results.replaceChildren(page);
    setStatus("Choose which features to enable. Nothing runs until you enable it.");
  }

  function renderHome() {
    const page = shellPage("home-page");
    page.append(
      heading("Your tools"),
      paragraph("Features can be switched on or off independently. Open Advanced for optional behavior.", "shell-intro"),
      renderFeatureGrid({ onboarding: false })
    );
    nodes.results.replaceChildren(page);
    setStatus(contextStatus());
  }

  function renderSettings() {
    const page = shellPage("settings-page");
    page.append(heading("Settings"));

    const data = document.createElement("section");
    data.className = "settings-card";
    data.append(
      heading("Privacy and stored data", "h2"),
      paragraph("Scans, player profiles, pricing rules, and preferences are stored locally. Requests go only to Gladiatus/Gameforge pages using the current game session.", "setting-help")
    );

    const cacheActions = document.createElement("div");
    cacheActions.className = "settings-actions";
    cacheActions.append(
      actionButton("Clear auction cache", "clear-feature-cache", { featureId: "auction" }),
      actionButton("Clear arena cache", "clear-feature-cache", { featureId: "arena" })
    );
    data.append(
      cacheActions,
      paragraph("Guild Market pricing changes only the native price field after a matching item is staged; it adds no controls to the page.", "setting-help")
    );

    const diagnostics = document.createElement("section");
    diagnostics.className = "settings-card";
    const diagnosticsEnabled = Boolean(state.helperSettings?.diagnostics?.enabled);
    diagnostics.append(
      heading("Diagnostics", "h2"),
      paragraph("Enable developer logging only while troubleshooting. The export controls appear below Settings.", "setting-help"),
      switchButton({
        checked: diagnosticsEnabled,
        label: "Developer diagnostics",
        action: "toggle-diagnostics"
      })
    );

    const reset = document.createElement("section");
    reset.className = "settings-card";
    reset.append(
      heading("Reset extension", "h2"),
      paragraph("Clears feature settings, rules, formulas, scans, cached profiles, and diagnostics. You will return to onboarding.", "setting-help")
    );
    const clear = actionButton("Clear all extension data", "clear-all-data");
    clear.classList.add("warning-action");
    reset.append(clear);

    page.append(data, diagnostics, reset);
    nodes.results.replaceChildren(page);
    setStatus("Settings and stored-data controls.");
  }

  function renderFeatureGrid({ onboarding }) {
    const grid = document.createElement("section");
    grid.className = "feature-grid";
    grid.setAttribute("aria-label", onboarding ? "Feature choices" : "Features");
    for (const definition of FEATURE_DEFINITIONS) grid.append(renderFeatureCard(definition));
    return grid;
  }

  function renderFeatureCard(definition) {
    const feature = state.helperSettings?.features?.[definition.id] || {};
    const available = Boolean(FEATURE_SETTINGS) && featureModules[definition.id] !== false;
    const configuredEnabled = Boolean(feature.enabled);
    const enabled = available && configuredEnabled;
    const card = document.createElement("article");
    card.className = "feature-card";
    if (state.pageMode === definition.id) card.classList.add("context-match");

    const header = document.createElement("div");
    header.className = "feature-card-header";
    const copy = document.createElement("div");
    copy.append(
      heading(definition.title, "h2"),
      paragraph(definition.description, "feature-description"),
      paragraph(available ? (enabled ? "Enabled" : "Disabled") : "Feature module unavailable", "feature-state")
    );
    header.append(copy, switchButton({
      checked: configuredEnabled,
      disabled: !available,
      label: `${configuredEnabled ? "Disable" : "Enable"} ${definition.title}`,
      action: "toggle-feature",
      dataset: { featureId: definition.id }
    }));
    card.append(header);

    const advanced = document.createElement("details");
    advanced.className = "feature-advanced";
    advanced.dataset.featureDetails = definition.id;
    advanced.open = Boolean(state.openFeatureDetails[definition.id]);
    const summary = document.createElement("summary");
    summary.textContent = definition.id === "guildMarket" ? "Pricing rules" : "Advanced options";
    advanced.append(summary);

    if (definition.capabilities.length) {
      const list = document.createElement("div");
      list.className = "capability-list";
      for (const [capability, title, help] of definition.capabilities) {
        list.append(renderCapability(definition.id, capability, title, help, feature, enabled));
      }
      advanced.append(list);
    } else {
      advanced.append(renderGuildMarketOptions(feature, enabled));
    }
    card.append(advanced);

    if (state.pageMode === definition.id && enabled) {
      const actions = document.createElement("div");
      actions.className = "feature-actions";
      actions.append(actionButton("Open current page tools", "open-workspace"));
      card.append(actions);
    }
    return card;
  }

  function renderCapability(featureId, capability, title, help, feature, parentEnabled) {
    const row = document.createElement("div");
    row.className = "capability-row";
    const copy = document.createElement("div");
    copy.className = "capability-copy";
    const strong = document.createElement("strong");
    strong.textContent = title;
    copy.append(strong, paragraph(help, "setting-help"));
    row.append(copy, switchButton({
      checked: Boolean(feature[capability]),
      disabled: !parentEnabled,
      label: `${feature[capability] ? "Disable" : "Enable"} ${title}`,
      action: "toggle-capability",
      dataset: { featureId, capability }
    }));
    return row;
  }

  function renderGuildMarketOptions(feature, parentEnabled) {
    const container = document.createElement("div");
    container.className = "capability-list";

    const modeRow = document.createElement("div");
    modeRow.className = "settings-row";
    const modeCopy = document.createElement("span");
    modeCopy.textContent = "Pricing behavior";
    const mode = document.createElement("strong");
    mode.textContent = "Fill automatically";
    modeRow.append(modeCopy, mode);
    container.append(modeRow, paragraph("A matching rule immediately fills only the price field and recalculates fees; it never submits the listing.", "setting-help"));

    const rules = document.createElement("div");
    rules.className = "rule-list";
    for (const rule of feature.rules || []) rules.append(renderGuildRule(rule, parentEnabled));
    if (state.guildRuleDraft) rules.append(renderGuildRuleEditor(state.guildRuleDraft, parentEnabled));
    container.append(rules);

    if (!state.guildRuleDraft) {
      const add = actionButton("Add pricing rule", "new-guild-rule");
      add.disabled = !parentEnabled;
      container.append(add);
    }
    return container;
  }

  function renderGuildRule(rule, parentEnabled) {
    const card = document.createElement("article");
    card.className = "rule-card";
    const title = document.createElement("div");
    title.className = "rule-title";
    title.textContent = rule.itemName || "Unnamed item";
    const meta = paragraph(`${formatGold(rule.pricePerUnit)} gold per item · ${rule.enabled === false ? "disabled" : "enabled"}`, "rule-meta");
    const actions = document.createElement("div");
    actions.className = "rule-actions";
    const edit = actionButton("Edit", "edit-guild-rule", { ruleId: rule.id });
    const remove = actionButton("Delete", "delete-guild-rule", { ruleId: rule.id });
    edit.disabled = !parentEnabled;
    remove.disabled = !parentEnabled;
    actions.append(edit, remove);
    card.append(title, meta, actions);
    return card;
  }

  function renderGuildRuleEditor(draft, parentEnabled) {
    const editor = document.createElement("section");
    editor.className = "rule-editor";
    editor.dataset.guildRuleEditor = "1";

    const name = document.createElement("input");
    name.name = "guild-item-name";
    name.type = "text";
    name.value = draft.itemName || "";
    name.placeholder = "Exact item name";
    name.disabled = !parentEnabled;
    const nameLabel = document.createElement("label");
    nameLabel.append(document.createTextNode("Item name"), name);

    const rate = document.createElement("input");
    rate.name = "guild-price-per-unit";
    rate.type = "number";
    rate.min = "1";
    rate.step = "1";
    rate.value = String(draft.pricePerUnit || "");
    rate.disabled = !parentEnabled;
    const rateLabel = document.createElement("label");
    rateLabel.append(document.createTextNode("Gold per item"), rate);

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "check-row";
    const enabled = document.createElement("input");
    enabled.name = "guild-rule-enabled";
    enabled.type = "checkbox";
    enabled.checked = draft.enabled !== false;
    enabled.disabled = !parentEnabled;
    enabledLabel.append(enabled, document.createTextNode(" Rule enabled"));

    const actions = document.createElement("div");
    actions.className = "rule-actions";
    actions.append(actionButton("Save rule", "save-guild-rule"), actionButton("Cancel", "cancel-guild-rule"));
    editor.append(nameLabel, rateLabel, enabledLabel, actions);
    return editor;
  }

  async function onClick(event) {
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return false;
    const action = actionNode.dataset.action;

    if (action === "open-workspace") {
      navigate("workspace");
      return true;
    }

    if (action === "toggle-feature") {
      const featureId = actionNode.dataset.featureId;
      await updateFeature(featureId, { enabled: !state.helperSettings.features[featureId].enabled });
      return true;
    }

    if (action === "toggle-capability") {
      const { featureId, capability } = actionNode.dataset;
      await updateFeature(featureId, { [capability]: !state.helperSettings.features[featureId][capability] });
      return true;
    }

    if (action === "complete-onboarding") {
      await completeOnboarding();
      state.shellPage = contextWorkspaceAvailable() ? "workspace" : "home";
      render();
      return true;
    }

    if (action === "new-guild-rule") {
      state.guildRuleDraft = { id: "", itemName: "", pricePerUnit: "", enabled: true, isNew: true };
      render();
      return true;
    }

    if (action === "edit-guild-rule") {
      const rule = state.helperSettings.features.guildMarket.rules.find((candidate) => candidate.id === actionNode.dataset.ruleId);
      if (rule) state.guildRuleDraft = { ...rule, isNew: false };
      render();
      return true;
    }

    if (action === "cancel-guild-rule") {
      state.guildRuleDraft = null;
      render();
      return true;
    }

    if (action === "delete-guild-rule") {
      await deleteGuildRule(actionNode.dataset.ruleId);
      return true;
    }

    if (action === "save-guild-rule") {
      await saveGuildRule();
      return true;
    }

    if (action === "toggle-diagnostics") {
      const enabled = !state.helperSettings.diagnostics.enabled;
      const result = await FEATURE_SETTINGS.updateDiagnostics({ enabled });
      state.helperSettings = result || await FEATURE_SETTINGS.get();
      render();
      setStatus(`Developer diagnostics ${enabled ? "enabled" : "disabled"}.`);
      return true;
    }

    if (action === "clear-feature-cache") {
      await clearFeatureCache(actionNode.dataset.featureId);
      return true;
    }

    if (action === "clear-all-data") {
      if (!window.confirm("Clear every Gladiatus Helper setting, rule, formula, scan, and cached profile? This cannot be undone.")) return true;
      await clearAllData();
      return true;
    }

    return false;
  }

  async function onChange(event) {
    return Boolean(event.target.closest("[data-settings-input]"));
  }

  function onToggle(event) {
    const details = event.target.closest?.("details[data-feature-details]");
    if (!details) return false;
    state.openFeatureDetails[details.dataset.featureDetails] = details.open;
    return true;
  }

  async function updateFeature(featureId, patch) {
    if (!FEATURE_SETTINGS?.updateFeature) {
      setStatus("Feature settings are unavailable. Reload the extension.");
      return;
    }
    const result = await FEATURE_SETTINGS.updateFeature(featureId, patch);
    state.helperSettings = result || await FEATURE_SETTINGS.get();
    render();
    setStatus(`${featureLabel(featureId)} settings updated.`);
  }

  async function completeOnboarding() {
    if (FEATURE_SETTINGS?.completeOnboarding) {
      state.helperSettings = await FEATURE_SETTINGS.completeOnboarding() || await FEATURE_SETTINGS.get();
      return;
    }
    if (FEATURE_SETTINGS?.update) {
      state.helperSettings = await FEATURE_SETTINGS.update((settings) => ({
        ...settings,
        onboarding: { completed: true, version: 1 }
      })) || await FEATURE_SETTINGS.get();
    }
  }

  async function saveGuildRule() {
    const editor = nodes.results.querySelector("[data-guild-rule-editor]");
    if (!editor) return;
    const itemName = normalizeItemName(editor.querySelector("input[name='guild-item-name']")?.value);
    const pricePerUnit = Number(editor.querySelector("input[name='guild-price-per-unit']")?.value);
    const enabled = Boolean(editor.querySelector("input[name='guild-rule-enabled']")?.checked);
    const currentRules = state.helperSettings.features.guildMarket.rules || [];

    if (!itemName) {
      setStatus("Pricing rule needs an exact item name.");
      return;
    }
    if (!Number.isSafeInteger(pricePerUnit) || pricePerUnit <= 0) {
      setStatus("Gold per item must be a positive whole number.");
      return;
    }
    const duplicate = currentRules.some((rule) => rule.id !== state.guildRuleDraft.id
      && normalizeItemName(rule.itemName).toLocaleLowerCase() === itemName.toLocaleLowerCase());
    if (duplicate) {
      setStatus(`A pricing rule for “${itemName}” already exists.`);
      return;
    }

    const id = state.guildRuleDraft.id || `guild-rule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const saved = { id, itemName, pricePerUnit, enabled };
    const rules = currentRules.some((rule) => rule.id === id)
      ? currentRules.map((rule) => rule.id === id ? saved : rule)
      : [...currentRules, saved];
    state.guildRuleDraft = null;
    await updateFeature("guildMarket", { rules });
  }

  async function deleteGuildRule(ruleId) {
    const currentRules = state.helperSettings.features.guildMarket.rules || [];
    const rule = currentRules.find((candidate) => candidate.id === ruleId);
    if (!window.confirm(`Delete the pricing rule for “${rule?.itemName || "this item"}”?`)) return;
    state.guildRuleDraft = state.guildRuleDraft?.id === ruleId ? null : state.guildRuleDraft;
    await updateFeature("guildMarket", { rules: currentRules.filter((candidate) => candidate.id !== ruleId) });
  }

  function contextWorkspaceAvailable() {
    const featureId = state.pageMode;
    if (!["auction", "arena", "guildMarket"].includes(featureId)) return false;
    return Boolean(state.helperSettings?.features?.[featureId]?.enabled && featureModules[featureId] !== false);
  }

  function contextStatus() {
    if (state.pageMode === "unsupported") return "Open a Gladiatus auction, arena, or Guild Market page for contextual tools.";
    const title = featureLabel(state.pageMode);
    return contextWorkspaceAvailable()
      ? `${title} is enabled for the current page.`
      : `${title} is disabled. Enable it below to use its page tools.`;
  }

  return {
    renderOnboarding,
    renderHome,
    renderSettings,
    onClick,
    onChange,
    onToggle,
    contextWorkspaceAvailable
  };
}

function shellPage(id) {
  const page = document.createElement("section");
  page.id = id;
  page.className = "shell-page";
  return page;
}

function heading(text, tagName = "") {
  const node = document.createElement(tagName || "h2");
  if (!tagName) node.className = "shell-heading";
  node.textContent = text;
  return node;
}

function paragraph(text, className) {
  const node = document.createElement("p");
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function notice(text) {
  const node = document.createElement("p");
  node.className = "notice";
  node.textContent = text;
  return node;
}

function switchButton({ checked, disabled = false, label, action, dataset = {} }) {
  const button = actionButton(checked ? "On" : "Off", action, dataset);
  button.classList.add("switch");
  button.setAttribute("role", "switch");
  button.setAttribute("aria-checked", String(Boolean(checked)));
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  return button;
}

function actionButton(text, action, dataset = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = text;
  for (const [key, value] of Object.entries(dataset)) button.dataset[key] = value;
  return button;
}

function featureLabel(featureId) {
  return FEATURE_DEFINITIONS.find((definition) => definition.id === featureId)?.title || "Feature";
}

function normalizeItemName(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function formatGold(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}
