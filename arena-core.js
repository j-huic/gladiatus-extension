(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const SCORE = root.GladiatusScoreModel;
  if (!SCORE) {
    if (!isArenaPageUrl(root.document?.location?.href || root.location?.href || "")) return;
    throw new Error("GladiatusScoreModel must load before GladiatusArenaCore.");
  }

  if (root.GladiatusArenaCore) return;

  const FORMULAS_STORAGE_KEY = "glad-arena-formulas-v1";
  const RESULTS_STORAGE_KEY = "glad-arena-last-scan-v1";
  const PASSIVE_SCANS_STORAGE_KEY = "glad-arena-passive-scans-v1";
  const SCAN_STATUS_STORAGE_KEY = "glad-arena-scan-status-v1";
  const SELF_PROFILE_STORAGE_KEY = "glad-arena-self-profile-v1";
  const SELF_PROFILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
  const TEAM_DOLL_MIN = 2;
  const TEAM_DOLL_MAX = 6;

  const PRIMARY_STAT_KEYS = [
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence"
  ];

  const ARENA_STAT_LABELS = {
    level: "Level",
    strength: "Str",
    dexterity: "Dex",
    agility: "Agi",
    constitution: "Con",
    charisma: "Cha",
    intelligence: "Int",
    lifeCurrent: "HP",
    lifeMax: "HP max",
    lifePercent: "HP %",
    regenPerHour: "Regen/h",
    armour: "Armour",
    armourAbsorbMin: "Abs min",
    armourAbsorbMax: "Abs max",
    resilience: "Resilience",
    critAvoidChance: "Avoid crit %",
    blockingValue: "Block value",
    blockChance: "Block %",
    damageMin: "DMG min",
    damageMax: "DMG max",
    damageAvg: "DMG avg",
    damageBasicMin: "Base DMG min",
    damageBasicMax: "Base DMG max",
    damageFromItems: "Item DMG",
    damageFromStrength: "Str DMG",
    criticalDamage: "Crit value",
    critChance: "Crit %",
    criticalHealingValue: "Crit heal",
    criticalHealingChance: "Crit heal %",
    healing: "Healing"
  };

  const ARENA_STAT_ORDER = [
    "level",
    "strength",
    "dexterity",
    "agility",
    "constitution",
    "charisma",
    "intelligence",
    "lifeCurrent",
    "lifeMax",
    "lifePercent",
    "regenPerHour",
    "armour",
    "armourAbsorbMin",
    "armourAbsorbMax",
    "resilience",
    "critAvoidChance",
    "blockingValue",
    "blockChance",
    "damageMin",
    "damageMax",
    "damageAvg",
    "damageBasicMin",
    "damageBasicMax",
    "damageFromItems",
    "damageFromStrength",
    "criticalDamage",
    "critChance",
    "criticalHealingValue",
    "criticalHealingChance",
    "healing"
  ];

  const ROLE_SECTION_KEYS = ["duel", "tank", "healer", "damage"];
  const ROLE_SECTION_LABELS = {
    duel: "Duel",
    tank: "Tank",
    healer: "Healer",
    damage: "Damage"
  };

  const PROFILE_SELECTORS = {
    level: "#char_level",
    strength: "#char_f0",
    dexterity: "#char_f1",
    agility: "#char_f2",
    constitution: "#char_f3",
    charisma: "#char_f4",
    intelligence: "#char_f5",
    armour: "#char_panzer",
    damage: "#char_schaden",
    healing: "#char_healing"
  };

  const PROFILE_TOOLTIP_IDS = {
    life: "char_leben_tt",
    strength: "char_f0_tt",
    dexterity: "char_f1_tt",
    agility: "char_f2_tt",
    constitution: "char_f3_tt",
    charisma: "char_f4_tt",
    intelligence: "char_f5_tt",
    armour: "char_panzer_tt",
    damage: "char_schaden_tt",
    healing: "char_healing_tt"
  };

  const EQUIPMENT_SLOT_BY_ITEM_TYPE = {
    1: "weapon",
    2: "shield",
    3: "chest",
    4: "helmet",
    5: "gloves",
    6: "ring",
    8: "shoes",
    9: "amulet"
  };

  const DEFAULT_ARENA_FORMULA = {
    id: "role-aware-default",
    name: "Role-aware default",
    enabled: true,
    sections: {
      duel: {
        terms: [
          { stat: "dexterity", weight: 1 },
          { stat: "agility", weight: 1 },
          { stat: "damageAvg", weight: 1 }
        ],
        constraints: []
      },
      tank: {
        terms: [
          { stat: "agility", weight: 1 },
          { stat: "strength", weight: 0.5 },
          { stat: "armour", weight: 0.01 }
        ],
        constraints: []
      },
      healer: {
        terms: [
          { stat: "healing", weight: 1 }
        ],
        constraints: []
      },
      damage: {
        terms: [
          { stat: "dexterity", weight: 1 },
          { stat: "damageAvg", weight: 1 }
        ],
        constraints: []
      }
    }
  };

  class ArenaCharacter {
    constructor(data = {}) {
      this.id = String(data.id || "");
      this.name = String(data.name || "Unknown fighter").trim() || "Unknown fighter";
      this.profileUrl = String(data.profileUrl || "");
      this.province = String(data.province || "");
      this.language = String(data.language || "");
      this.level = parseInteger(data.level);
      this.doll = parseInteger(data.doll);
      this.role = normalizeRole(data.role);
      this.roleLabel = String(data.roleLabel || ROLE_SECTION_LABELS[this.role] || this.role);
      this.stats = normalizeStats({ ...(data.stats || {}), level: this.level });
      this.profile = normalizeProfileDetails(data.profile || data.details || {});
      this.equipment = normalizeEquipment(data.equipment);
    }

    get primaryStatSum() {
      return sumStats(this.stats, PRIMARY_STAT_KEYS);
    }

    get damageAvg() {
      return averageDamage(this.stats);
    }

    get simplePowerScore() {
      return this.primaryStatSum + this.damageAvg;
    }

    toJSON() {
      return {
        id: this.id,
        name: this.name,
        profileUrl: this.profileUrl,
        province: this.province,
        language: this.language,
        level: this.level,
        doll: this.doll,
        role: this.role,
        roleLabel: this.roleLabel,
        stats: { ...this.stats },
        profile: this.profile,
        equipment: this.equipment.map((item) => ({ ...item, stats: { ...(item.stats || {}) }, lines: [...(item.lines || [])] })),
        combat: combatProfile(this),
        scores: characterScores(this)
      };
    }
  }

  function isArenaPageUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.endsWith(".gladiatus.gameforge.com")
        && parsed.pathname.endsWith("/game/index.php")
        && parsed.searchParams.get("mod") === "arena";
    } catch {
      return false;
    }
  }

  function arenaKindFromUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.get("submod") === "grouparena") return "team";
      if (parsed.searchParams.get("aType") === "3") return "team";
      return "single";
    } catch {
      return "single";
    }
  }

  function deriveSelfProfileUrl(pageUrl, context = {}) {
    try {
      const parsed = new URL(String(pageUrl || ""));
      if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".gladiatus.gameforge.com")) return "";
      if (!parsed.pathname.startsWith("/game/")) return "";

      const sourceText = [
        context.documentText || "",
        ...(Array.isArray(context.scripts) ? context.scripts : [])
      ].join("\n");
      const playerId = String(context.playerId || playerIdFromText(sourceText) || parsed.searchParams.get("p") || "").trim();
      if (!/^\d+$/.test(playerId)) return "";

      const secureHash = String(context.secureHash || parsed.searchParams.get("sh") || secureHashFromText(sourceText) || "").trim();
      const profileUrl = new URL(parsed.pathname.endsWith("/index.php") ? parsed.pathname : "/game/index.php", parsed.origin);
      profileUrl.searchParams.set("mod", "player");
      profileUrl.searchParams.set("p", playerId);
      profileUrl.searchParams.set("doll", "1");
      if (secureHash) profileUrl.searchParams.set("sh", secureHash);
      return profileUrl.href;
    } catch {
      return "";
    }
  }

  function playerIdFromText(value) {
    const text = String(value || "");
    return text.match(/\bplayerId\s*=\s*["']?(\d+)/)?.[1]
      || text.match(/\bchat\.init\((\d+)\)/)?.[1]
      || "";
  }

  function secureHashFromText(value) {
    return String(value || "").match(/\bsecureHash\s*=\s*["']([^"']+)/)?.[1] || "";
  }

  function parseInteger(value) {
    const parsed = Number.parseInt(String(value || "").replace(/[^\d-]/g, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function parseDamageRange(value) {
    const text = String(value || "");
    const range = text.match(/(\d[\d.]*)\s*-\s*(\d[\d.]*)/);
    if (range) {
      const damageMin = parseInteger(range[1]);
      const damageMax = parseInteger(range[2]);
      return {
        damageMin,
        damageMax,
        damageAvg: damageMin && damageMax ? (damageMin + damageMax) / 2 : 0
      };
    }

    const single = text.match(/\d[\d.]*/);
    const damage = single ? parseInteger(single[0]) : 0;
    return {
      damageMin: damage,
      damageMax: damage,
      damageAvg: damage
    };
  }

  function normalizeStats(stats) {
    const normalized = {};
    for (const key of ARENA_STAT_ORDER) {
      normalized[key] = Number(stats[key]) || 0;
    }
    if (!normalized.damageAvg) normalized.damageAvg = averageDamage(normalized);
    return normalized;
  }

  function sumStats(stats, keys) {
    return keys.reduce((total, key) => total + (Number(stats?.[key]) || 0), 0);
  }

  function averageDamage(stats) {
    if (Number(stats?.damageAvg)) return Number(stats.damageAvg);
    const min = Number(stats?.damageMin) || 0;
    const max = Number(stats?.damageMax) || 0;
    return min && max ? (min + max) / 2 : 0;
  }

  function characterScores(character) {
    const stats = character?.stats || {};
    const primaryStatSum = sumStats(stats, PRIMARY_STAT_KEYS);
    const damageAvg = averageDamage(stats);
    return {
      primaryStatSum,
      damageAvg,
      simplePowerScore: primaryStatSum + damageAvg
    };
  }

  function parseCharacterFromHtml(html, meta = {}) {
    const parser = new DOMParser();
    return parseCharacterFromDocument(parser.parseFromString(String(html || ""), "text/html"), meta);
  }

  function parseCharacterFromDocument(doc, meta = {}) {
    const activeDoll = readActiveDollMeta(doc, meta.profileUrl);
    const stat = (key) => parseInteger(doc.querySelector(PROFILE_SELECTORS[key])?.textContent);
    const damage = parseDamageRange(doc.querySelector(PROFILE_SELECTORS.damage)?.textContent || "");
    const name = doc.querySelector(".playername")?.textContent?.trim() || meta.name || activeDoll.name;
    const level = stat("level") || meta.level;
    const visibleStats = {
      level,
      strength: stat("strength"),
      dexterity: stat("dexterity"),
      agility: stat("agility"),
      constitution: stat("constitution"),
      charisma: stat("charisma"),
      intelligence: stat("intelligence"),
      armour: stat("armour"),
      healing: stat("healing"),
      ...damage
    };
    const profile = parseProfileDetailsFromTooltips(readProfileTooltipsFromDocument(doc), visibleStats);
    const equipment = readProfileEquipmentFromDocument(doc);

    return new ArenaCharacter({
      ...meta,
      name,
      level,
      doll: meta.doll || activeDoll.doll,
      role: meta.role || activeDoll.role,
      roleLabel: meta.roleLabel || activeDoll.roleLabel,
      stats: {
        ...visibleStats,
        ...profileStats(profile)
      },
      profile,
      equipment
    });
  }

  function readProfileTooltipsFromDocument(doc) {
    const tooltips = {};
    for (const [key, id] of Object.entries(PROFILE_TOOLTIP_IDS)) {
      tooltips[key] = doc.querySelector(`#${id}`)?.getAttribute?.("data-tooltip") || "";
    }
    return tooltips;
  }

  function readProfileEquipmentFromDocument(doc) {
    const elements = [];
    const seen = new Set();
    for (const selector of ["#char [data-tooltip][data-basis]", "#char [data-tooltip][data-content-type]", "[data-tooltip][data-basis]"]) {
      for (const element of Array.from(doc.querySelectorAll?.(selector) || [])) {
        if (!element || seen.has(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    }

    return parseProfileEquipmentItems(elements.map((element) => ({
      tooltip: element.getAttribute?.("data-tooltip") || "",
      className: element.className || "",
      basis: element.dataset?.basis || element.getAttribute?.("data-basis") || "",
      contentType: element.dataset?.contentType || element.getAttribute?.("data-content-type") || "",
      containerNumber: element.dataset?.containerNumber || element.getAttribute?.("data-container-number") || "",
      level: element.dataset?.level || element.getAttribute?.("data-level") || "",
      quality: element.dataset?.quality || element.getAttribute?.("data-quality") || ""
    })));
  }

  function parseProfileDetailsFromTooltips(tooltips = {}, visibleStats = {}) {
    return normalizeProfileDetails({
      life: parseLifeProfile(tooltips.life, visibleStats),
      primary: Object.fromEntries(PRIMARY_STAT_KEYS.map((key) => [
        key,
        parsePrimaryStatProfile(key, tooltips[key], visibleStats)
      ])),
      armour: parseArmourProfile(tooltips.armour, visibleStats),
      damage: parseDamageProfile(tooltips.damage, visibleStats),
      healing: parseHealingProfile(tooltips.healing, visibleStats)
    });
  }

  function parseLifeProfile(rawTooltip, visibleStats = {}) {
    const life = {
      current: 0,
      max: 0,
      percent: Number(visibleStats.lifePercent) || 0,
      fromLevel: 0,
      fromItems: 0,
      fromReinforcement: 0,
      fromConstitution: 0,
      regenPerHour: 0,
      regenFromConstitution: 0,
      regenFromLevel: 0
    };

    for (const row of parseTooltipPairs(rawTooltip)) {
      if (labelEquals(row.label, "Life points")) {
        const currentMax = parseCurrentMax(row.value);
        life.current = currentMax.current;
        life.max = currentMax.max;
        continue;
      }
      if (/^Life on level\b/i.test(row.label)) life.fromLevel = parseInteger(row.value);
      else if (labelEquals(row.label, "Through items")) life.fromItems = parseInteger(row.value);
      else if (labelEquals(row.label, "Through reinforcement")) life.fromReinforcement = parseInteger(row.value);
      else if (labelEquals(row.label, "Bonus through Constitution")) life.fromConstitution = parseInteger(row.value);
      else if (labelEquals(row.label, "Regeneration")) life.regenPerHour = parseInteger(row.value);
      else if (labelEquals(row.label, "Through constitution")) life.regenFromConstitution = parseInteger(row.value);
      else if (labelEquals(row.label, "By level")) life.regenFromLevel = parseInteger(row.value);
    }

    if (!life.percent && life.current && life.max) life.percent = Math.round((life.current / life.max) * 100);
    return life;
  }

  function parsePrimaryStatProfile(key, rawTooltip, visibleStats = {}) {
    const detail = {
      value: Number(visibleStats[key]) || 0,
      basic: 0,
      maximum: 0,
      fromItems: 0,
      fromItemsRaw: 0
    };
    const expectedLabel = ARENA_STAT_LABELS[key] || key;

    for (const row of parseTooltipPairs(rawTooltip)) {
      if (labelEquals(row.label, expectedLabel)) detail.value = parseInteger(row.value);
      else if (labelEquals(row.label, "Basic")) detail.basic = parseInteger(row.value);
      else if (labelEquals(row.label, "Maximum")) detail.maximum = parseInteger(row.value);
      else if (labelEquals(row.label, "Through items")) {
        const contribution = parseContribution(row.value);
        detail.fromItems = contribution.value;
        detail.fromItemsRaw = contribution.raw || contribution.value;
      }
    }

    return detail;
  }

  function parseArmourProfile(rawTooltip, visibleStats = {}) {
    const detail = {
      value: Number(visibleStats.armour) || 0,
      absorbMin: 0,
      absorbMax: 0,
      resilience: 0,
      resilienceFromItems: 0,
      resilienceFromAgility: 0,
      critAvoidChance: 0,
      blockingValue: 0,
      blockingFromItems: 0,
      blockingFromStrength: 0,
      blockChance: 0
    };
    let section = "armour";

    for (const row of parseTooltipPairs(rawTooltip)) {
      if (labelEquals(row.label, "Armour")) {
        detail.value = parseInteger(row.value);
        section = "armour";
      } else if (labelEquals(row.label, "Absorbs damage")) {
        const range = parseNumberRange(row.value);
        detail.absorbMin = range.min;
        detail.absorbMax = range.max;
      } else if (labelEquals(row.label, "Resilience")) {
        detail.resilience = parseInteger(row.value);
        section = "resilience";
      } else if (labelEquals(row.label, "Blocking value")) {
        detail.blockingValue = parseInteger(row.value);
        section = "blocking";
      } else if (labelEquals(row.label, "Through items") && section === "resilience") {
        detail.resilienceFromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through agility")) {
        detail.resilienceFromAgility = parseInteger(row.value);
      } else if (/avoiding critical hits/i.test(row.label)) {
        detail.critAvoidChance = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through items") && section === "blocking") {
        detail.blockingFromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through strength")) {
        detail.blockingFromStrength = parseInteger(row.value);
      } else if (/block a hit/i.test(row.label)) {
        detail.blockChance = parseInteger(row.value);
      }
    }

    return detail;
  }

  function parseDamageProfile(rawTooltip, visibleStats = {}) {
    const detail = {
      min: Number(visibleStats.damageMin) || 0,
      max: Number(visibleStats.damageMax) || 0,
      basicMin: 0,
      basicMax: 0,
      fromItems: 0,
      fromStrength: 0,
      fromReinforcement: 0,
      criticalDamage: 0,
      criticalDamageFromItems: 0,
      criticalDamageFromDexterity: 0,
      critChance: 0
    };
    let section = "damage";

    for (const row of parseTooltipPairs(rawTooltip)) {
      if (labelEquals(row.label, "Damage")) {
        const range = parseNumberRange(row.value);
        detail.min = range.min;
        detail.max = range.max;
        section = "damage";
      } else if (labelEquals(row.label, "Basic")) {
        const range = parseNumberRange(row.value);
        detail.basicMin = range.min;
        detail.basicMax = range.max;
      } else if (labelEquals(row.label, "Through items") && section === "damage") {
        detail.fromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through strength")) {
        detail.fromStrength = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through reinforcement")) {
        detail.fromReinforcement = parseInteger(row.value);
      } else if (labelEquals(row.label, "Critical damage")) {
        detail.criticalDamage = parseInteger(row.value);
        section = "criticalDamage";
      } else if (labelEquals(row.label, "Through items") && section === "criticalDamage") {
        detail.criticalDamageFromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through dexterity")) {
        detail.criticalDamageFromDexterity = parseInteger(row.value);
      } else if (/critical damage/i.test(row.label) && /^chance\b/i.test(row.label)) {
        detail.critChance = parseInteger(row.value);
      }
    }

    return detail;
  }

  function parseHealingProfile(rawTooltip, visibleStats = {}) {
    const detail = {
      value: Number(visibleStats.healing) || 0,
      fromItems: 0,
      fromIntelligence: 0,
      criticalHealingValue: 0,
      criticalHealingFromItems: 0,
      criticalHealingFromIntelligence: 0,
      criticalHealingChance: 0
    };
    let section = "healing";

    for (const row of parseTooltipPairs(rawTooltip)) {
      if (labelEquals(row.label, "Healing")) {
        detail.value = parseInteger(row.value);
        section = "healing";
      } else if (labelEquals(row.label, "Through items") && section === "healing") {
        detail.fromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through intelligence") && section === "healing") {
        detail.fromIntelligence = parseInteger(row.value);
      } else if (labelEquals(row.label, "Critical healing value")) {
        detail.criticalHealingValue = parseInteger(row.value);
        section = "criticalHealing";
      } else if (labelEquals(row.label, "Through items") && section === "criticalHealing") {
        detail.criticalHealingFromItems = parseInteger(row.value);
      } else if (labelEquals(row.label, "Through intelligence") && section === "criticalHealing") {
        detail.criticalHealingFromIntelligence = parseInteger(row.value);
      } else if (/improved healing/i.test(row.label)) {
        detail.criticalHealingChance = parseInteger(row.value);
      }
    }

    return detail;
  }

  function profileStats(profile) {
    const source = normalizeProfileDetails(profile);
    return {
      lifeCurrent: source.life.current,
      lifeMax: source.life.max,
      lifePercent: source.life.percent,
      regenPerHour: source.life.regenPerHour,
      armour: source.armour.value,
      armourAbsorbMin: source.armour.absorbMin,
      armourAbsorbMax: source.armour.absorbMax,
      resilience: source.armour.resilience,
      critAvoidChance: source.armour.critAvoidChance,
      blockingValue: source.armour.blockingValue,
      blockChance: source.armour.blockChance,
      damageMin: source.damage.min,
      damageMax: source.damage.max,
      damageAvg: source.damage.min && source.damage.max ? (source.damage.min + source.damage.max) / 2 : 0,
      damageBasicMin: source.damage.basicMin,
      damageBasicMax: source.damage.basicMax,
      damageFromItems: source.damage.fromItems,
      damageFromStrength: source.damage.fromStrength,
      criticalDamage: source.damage.criticalDamage,
      critChance: source.damage.critChance,
      healing: source.healing.value,
      criticalHealingValue: source.healing.criticalHealingValue,
      criticalHealingChance: source.healing.criticalHealingChance
    };
  }

  function combatantFromCharacter(character) {
    const lifeMax = combatStat(character, "lifeMax");
    const lifeCurrent = combatStat(character, "lifeCurrent");
    const hp = lifeMax > 0 ? lifeMax : lifeCurrent;
    const critChance = clampPercent(combatStat(character, "critChance"), 0, 50);
    const blockChance = clampPercent(combatStat(character, "blockChance"), 0, 50);
    const critAvoidChance = clampPercent(combatStat(character, "critAvoidChance"), 0, 25);

    return {
      name: String(character?.name || "Unknown fighter").trim() || "Unknown fighter",
      level: Number(character?.level || character?.stats?.level) || 0,
      hp,
      maxHp: hp,
      damageMin: combatStat(character, "damageMin"),
      damageMax: combatStat(character, "damageMax"),
      armour: combatStat(character, "armour"),
      armourAbsorbMin: combatStat(character, "armourAbsorbMin"),
      armourAbsorbMax: combatStat(character, "armourAbsorbMax"),
      strength: combatStat(character, "strength"),
      dexterity: combatStat(character, "dexterity"),
      agility: combatStat(character, "agility"),
      constitution: combatStat(character, "constitution"),
      charisma: combatStat(character, "charisma"),
      intelligence: combatStat(character, "intelligence"),
      critChance,
      blockChance,
      critAvoidChance
    };
  }

  function combatantReadiness(character) {
    const combatant = combatantFromCharacter(character);
    const missing = [];
    const warnings = [];

    if (combatant.level <= 0) missing.push("level");
    if (combatant.maxHp <= 0) missing.push("hp");
    if (combatant.damageMin <= 0 || combatant.damageMax <= 0) missing.push("damageRange");
    for (const key of PRIMARY_STAT_KEYS) {
      if (combatant[key] <= 0) missing.push(key);
    }

    if (!combatStat(character, "lifeMax") && combatStat(character, "lifeCurrent")) {
      warnings.push("lifeMax missing; using lifeCurrent");
    }
    for (const [key, max] of [["critChance", 50], ["blockChance", 50], ["critAvoidChance", 25]]) {
      const raw = combatStat(character, key);
      if (raw > max) warnings.push(`${key} clamped to ${max}`);
      else if (raw < 0) warnings.push(`${key} clamped to 0`);
    }

    return {
      ready: missing.length === 0,
      missing,
      warnings
    };
  }

  function combatProfile(character) {
    const readiness = combatantReadiness(character);
    return {
      ...readiness,
      combatant: combatantFromCharacter(character)
    };
  }

  function combatStat(character, key) {
    return Number(character?.stats?.[key]) || 0;
  }

  function clampPercent(value, min, max) {
    return Math.min(max, Math.max(min, Number(value) || 0));
  }

  function parseProfileEquipmentItems(items = []) {
    return (Array.isArray(items) ? items : [])
      .map(parseProfileEquipmentItem)
      .filter(Boolean);
  }

  function parseProfileEquipmentItem(item = {}) {
    const lines = parseTooltipRows(item.tooltip || "")
      .map((row) => row.join(" ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!lines.length) return null;

    const itemType = itemTypeFromBasis(item.basis) || itemTypeFromClassName(item.className);
    const parsed = parseEquipmentStats(lines);

    return {
      slot: EQUIPMENT_SLOT_BY_ITEM_TYPE[itemType] || "",
      itemType: itemType ? String(itemType) : "",
      basis: String(item.basis || ""),
      contentType: String(item.contentType || ""),
      containerNumber: String(item.containerNumber || ""),
      className: String(item.className || ""),
      name: lines[0] || "Unknown item",
      level: parseInteger(item.level) || parsed.level,
      quality: String(item.quality || ""),
      lines,
      stats: parsed.stats
    };
  }

  function parseEquipmentStats(lines) {
    const stats = {};
    let level = 0;

    for (const line of lines || []) {
      const damageLine = String(line || "").match(/^Damage\s+(.+)/i);
      if (damageLine) {
        const range = parseNumberRange(damageLine[1]);
        if (range.min || range.max) {
          stats.damageMin = range.min;
          stats.damageMax = range.max;
          stats.damageAvg = (range.min + range.max) / 2;
        } else {
          stats.damageBonus = (stats.damageBonus || 0) + parseSignedBonus(damageLine[1]);
        }
        continue;
      }

      const levelMatch = String(line || "").match(/^Level\s+(\d+)/i);
      if (levelMatch) {
        level = Number.parseInt(levelMatch[1], 10) || 0;
        continue;
      }

      const statLine = equipmentStatLine(line);
      if (!statLine.key) continue;
      stats[statLine.key] = (stats[statLine.key] || 0) + parseSignedBonus(statLine.value);
    }

    return { level, stats };
  }

  function equipmentStatLine(line) {
    const text = normalizeLabel(line);
    const map = {
      "Strength": "strength",
      "Dexterity": "dexterity",
      "Agility": "agility",
      "Constitution": "constitution",
      "Charisma": "charisma",
      "Intelligence": "intelligence",
      "Life points": "lifePoints",
      "Health": "health",
      "Armour": "armour",
      "Critical attack value": "criticalAttackValue",
      "Critical damage": "criticalDamage",
      "Hardening value": "resilience",
      "Block value": "blockingValue",
      "Healing": "healing",
      "Threat": "threat"
    };
    const name = Object.keys(map)
      .sort((a, b) => b.length - a.length)
      .find((candidate) => new RegExp(`^${escapeRegExp(candidate)}\\b\\s*:?`, "i").test(text));
    return name
      ? { key: map[name], value: text.replace(new RegExp(`^${escapeRegExp(name)}\\b\\s*:?\\s*`, "i"), "") }
      : { key: "", value: "" };
  }

  function parseTooltipPairs(rawTooltip) {
    return parseTooltipRows(rawTooltip).map((row) => ({
      label: normalizeLabel(row[0] || ""),
      value: row.slice(1).join(" ").trim()
    })).filter((row) => row.label);
  }

  function parseTooltipRows(rawTooltip) {
    if (!rawTooltip) return [];
    try {
      const parsed = JSON.parse(decodeEntities(String(rawTooltip || "")));
      const rows = [];
      collectTooltipRows(parsed, rows);
      return rows
        .map((row) => row.map(stripMarkup).filter(Boolean))
        .filter((row) => row.length);
    } catch {
      return [];
    }
  }

  function collectTooltipRows(value, rows) {
    if (!Array.isArray(value)) return;
    if (isTooltipRow(value)) {
      rows.push(tooltipContentCells(value[0]));
      return;
    }
    value.forEach((entry) => collectTooltipRows(entry, rows));
  }

  function isTooltipRow(value) {
    if (!Array.isArray(value) || value.length < 2) return false;
    const content = value[0];
    const style = value[1];
    return tooltipContentCells(content).length > 0 && tooltipStyleLike(style);
  }

  function tooltipContentCells(value) {
    if (Array.isArray(value)) {
      return value
        .filter((entry) => typeof entry === "string" || typeof entry === "number")
        .map((entry) => String(entry));
    }
    return typeof value === "string" || typeof value === "number" ? [String(value)] : [];
  }

  function tooltipStyleLike(value) {
    if (Array.isArray(value)) return value.every(tooltipStyleLike);
    if (typeof value === "number") return true;
    return typeof value === "string" && /^(#|white|black|lime|red|green|blue|purple|orange|yellow|grey|gray|font|color|text-shadow|rgb|rgba)/i.test(value.trim());
  }

  function parseCurrentMax(value) {
    const match = String(value || "").match(/(\d[\d.]*)\s*\/\s*(\d[\d.]*)/);
    return {
      current: match ? parseInteger(match[1]) : 0,
      max: match ? parseInteger(match[2]) : 0
    };
  }

  function parseNumberRange(value) {
    const match = String(value || "").match(/([+-]?\d[\d.]*)\s*-\s*([+-]?\d[\d.]*)/);
    return {
      min: match ? parseInteger(match[1]) : 0,
      max: match ? parseInteger(match[2]) : 0
    };
  }

  function parseContribution(value) {
    const text = String(value || "");
    const match = text.match(/([+-]?\d[\d.]*)\s+from\s+([+-]?\d[\d.]*)/i);
    if (match) {
      return {
        value: parseInteger(match[1]),
        raw: parseInteger(match[2])
      };
    }
    const parsed = parseInteger(text);
    return { value: parsed, raw: parsed };
  }

  function parseSignedBonus(line) {
    const text = String(line || "");
    const parenthesized = text.match(/\(([+-]?\d+)\)/g) || [];
    if (parenthesized.length) {
      return parenthesized.reduce((total, match) => total + (Number.parseInt(match.replace(/[()]/g, ""), 10) || 0), 0);
    }
    const directValues = text.match(/[+-]\d+/g) || [];
    if (directValues.length) {
      return directValues.reduce((total, match) => total + (Number.parseInt(match, 10) || 0), 0);
    }
    return parseInteger(text);
  }

  function normalizeLabel(value) {
    return stripMarkup(value)
      .replace(/:+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function labelEquals(actual, expected) {
    return normalizeLabel(actual).toLowerCase() === normalizeLabel(expected).toLowerCase();
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function itemTypeFromBasis(value) {
    return parseInteger(String(value || "").split("-")[0]);
  }

  function itemTypeFromClassName(value) {
    return parseInteger(String(value || "").match(/\bitem-i-(\d+)-/)?.[1]);
  }

  function normalizeProfileDetails(details) {
    const source = details && typeof details === "object" ? details : {};
    return {
      life: normalizeNumberRecord(source.life, ["current", "max", "percent", "fromLevel", "fromItems", "fromReinforcement", "fromConstitution", "regenPerHour", "regenFromConstitution", "regenFromLevel"]),
      primary: Object.fromEntries(PRIMARY_STAT_KEYS.map((key) => [
        key,
        normalizeNumberRecord(source.primary?.[key], ["value", "basic", "maximum", "fromItems", "fromItemsRaw"])
      ])),
      armour: normalizeNumberRecord(source.armour, ["value", "absorbMin", "absorbMax", "resilience", "resilienceFromItems", "resilienceFromAgility", "critAvoidChance", "blockingValue", "blockingFromItems", "blockingFromStrength", "blockChance"]),
      damage: normalizeNumberRecord(source.damage, ["min", "max", "basicMin", "basicMax", "fromItems", "fromStrength", "fromReinforcement", "criticalDamage", "criticalDamageFromItems", "criticalDamageFromDexterity", "critChance"]),
      healing: normalizeNumberRecord(source.healing, ["value", "fromItems", "fromIntelligence", "criticalHealingValue", "criticalHealingFromItems", "criticalHealingFromIntelligence", "criticalHealingChance"])
    };
  }

  function normalizeNumberRecord(record, keys) {
    const source = record && typeof record === "object" ? record : {};
    return Object.fromEntries(keys.map((key) => [key, Number(source[key]) || 0]));
  }

  function normalizeEquipment(equipment) {
    return Array.isArray(equipment)
      ? equipment.map((item) => ({
        slot: String(item?.slot || ""),
        itemType: String(item?.itemType || ""),
        basis: String(item?.basis || ""),
        contentType: String(item?.contentType || ""),
        containerNumber: String(item?.containerNumber || ""),
        className: String(item?.className || ""),
        name: String(item?.name || "Unknown item"),
        level: parseInteger(item?.level),
        quality: String(item?.quality || ""),
        lines: Array.isArray(item?.lines) ? item.lines.map((line) => String(line || "")) : [],
        stats: normalizeOpenNumberRecord(item?.stats)
      })).filter((item) => item.name)
      : [];
  }

  function normalizeOpenNumberRecord(record) {
    const source = record && typeof record === "object" ? record : {};
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, Number(value) || 0]));
  }

  function readActiveDollMeta(doc, baseUrl = "") {
    const active = doc.querySelector(".charmercsel.active");
    if (!active) return { doll: 0, role: "duel", roleLabel: ROLE_SECTION_LABELS.duel, name: "" };
    return readDollTab(active, 0, baseUrl);
  }

  function readProfileDollTabsFromHtml(html, baseUrl = "") {
    const parser = new DOMParser();
    return readProfileDollTabsFromDocument(parser.parseFromString(String(html || ""), "text/html"), baseUrl);
  }

  function readProfileDollTabsFromDocument(doc, baseUrl = "") {
    return Array.from(doc.querySelectorAll(".charmercsel"))
      .map((tab, index) => readDollTab(tab, index, baseUrl || doc.location?.href || root.location?.href || ""))
      .filter((tab) => tab.url);
  }

  function readDollTab(tab, index, baseUrl = "") {
    const relativeUrl = extractDollUrl(tab.getAttribute("onclick") || "");
    const url = relativeUrl ? absoluteUrl(relativeUrl, baseUrl) : "";
    const rawTooltip = tab.querySelector("[data-tooltip]")?.getAttribute("data-tooltip") || "";
    const tooltipText = tooltipToText(rawTooltip);
    const role = parseRoleFromTooltipText(tooltipText);
    const doll = parseInteger(url ? new URL(url).searchParams.get("doll") : "") || index + 1;

    return {
      doll,
      url,
      tooltip: rawTooltip,
      tooltipText,
      role,
      roleLabel: ROLE_SECTION_LABELS[role] || ROLE_SECTION_LABELS.duel,
      active: tab.classList.contains("active")
    };
  }

  function extractDollUrl(onclick) {
    return String(onclick || "").match(/selectDoll\('([^']+)'\)/)?.[1]?.replaceAll("&amp;", "&") || "";
  }

  function absoluteUrl(value, baseUrl) {
    try {
      return new URL(value, baseUrl || root.location?.href || "").href;
    } catch {
      return "";
    }
  }

  function teamDollTabs(tabs) {
    return tabs.filter((tab) => tab.doll >= TEAM_DOLL_MIN && tab.doll <= TEAM_DOLL_MAX);
  }

  function tooltipToText(rawTooltip) {
    const values = [];
    try {
      collectStrings(JSON.parse(String(rawTooltip || "")), values);
    } catch {
      values.push(String(rawTooltip || ""));
    }
    return stripMarkup(values.join(" "));
  }

  function collectStrings(value, output) {
    if (Array.isArray(value)) {
      value.forEach((entry) => collectStrings(entry, output));
      return;
    }
    if (typeof value === "string") output.push(value);
  }

  function stripMarkup(value) {
    return decodeEntities(String(value || "")
      .replace(/\\\//g, "/")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function decodeEntities(value) {
    return String(value || "")
      .replace(/&quot;/g, "\"")
      .replace(/&#039;/g, "'")
      .replace(/&#0?39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code) || 0));
  }

  function parseRoleFromTooltipText(text) {
    const lower = String(text || "").toLowerCase();
    if (lower.includes("direct attention to oneself")) return "tank";
    if (lower.includes("heal group members")) return "healer";
    if (lower.includes("dish out damage")) return "damage";
    return "duel";
  }

  function normalizeRole(role) {
    if (role === "standard") return "duel";
    return ROLE_SECTION_KEYS.includes(role) ? role : "duel";
  }

  function readArenaOpponentEntries(doc = document, baseUrl = "") {
    const rows = Array.from(doc.querySelectorAll("#content tr"))
      .filter((row) => row.querySelector("a[href*='mod=player'][href*='p=']"))
      .filter((row) => row.querySelector(".attack[onclick]"));

    return rows.map((row, rowIndex) => {
      const link = row.querySelector("a[href*='mod=player'][href*='p=']");
      const attack = row.querySelector(".attack[onclick]");
      return {
        row,
        link,
        attack,
        opponent: readOpponentFromRow(row, link, attack, rowIndex, doc, baseUrl)
      };
    });
  }

  function readArenaOpponentEntriesFromHtml(html, baseUrl = "") {
    const parser = new DOMParser();
    return readArenaOpponentEntries(parser.parseFromString(String(html || ""), "text/html"), baseUrl);
  }

  function readOpponentFromRow(row, link, attack, rowIndex, doc = document, baseUrl = "") {
    const sourceUrl = baseUrl || doc.location?.href || root.location?.href || "";
    const profileUrl = new URL(link.getAttribute("href"), sourceUrl);
    const cells = Array.from(row.cells || []);
    const onclick = attack?.getAttribute("onclick") || "";
    const fightArgs = parseFightArgs(onclick);
    const arenaKind = fightArgs.arenaKind || arenaKindFromUrl(sourceUrl);

    return {
      rowIndex,
      arenaKind,
      id: profileUrl.searchParams.get("p") || fightArgs.playerId || "",
      name: link.textContent.trim(),
      level: parseInteger(cells[1]?.textContent),
      province: String(parseInteger(cells[2]?.textContent) || fightArgs.province || provinceFromHost(profileUrl.hostname) || ""),
      language: profileUrl.searchParams.get("language") || fightArgs.language || "",
      profileUrl: profileUrl.href
    };
  }

  function arenaOpponentFingerprint(entries) {
    return (entries || [])
      .map((entry) => entry?.opponent || entry)
      .map((opponent) => [
        String(opponent?.arenaKind || ""),
        String(opponent?.id || ""),
        normalizeFingerprintUrl(opponent?.profileUrl || "")
      ].join(":"))
      .sort()
      .join("|");
  }

  function normalizeFingerprintUrl(value) {
    try {
      const url = new URL(String(value || ""));
      url.hash = "";
      url.searchParams.delete("sh");
      url.searchParams.sort();
      return url.href;
    } catch {
      return String(value || "");
    }
  }

  function parseFightArgs(onclick) {
    const provincial = String(onclick || "").match(/startProvinciarumFight\([^,]+,\s*(\d+),\s*(\d+),\s*(\d+),\s*'([^']*)'/);
    if (provincial) {
      return {
        arenaType: provincial[1],
        arenaKind: provincial[1] === "3" ? "team" : "single",
        playerId: provincial[2],
        province: provincial[3],
        language: provincial[4]
      };
    }

    const group = String(onclick || "").match(/startGroupFight\([^,]+,\s*(\d+)/);
    return group ? { arenaType: "group", arenaKind: "team", playerId: group[1] } : {};
  }

  function provinceFromHost(hostname) {
    return String(hostname || "").match(/^s(\d+)-/)?.[1] || "";
  }

  function defaultArenaFormula() {
    return cloneArenaFormula(DEFAULT_ARENA_FORMULA);
  }

  function normalizeArenaFormulas(formulas) {
    return Array.isArray(formulas)
      ? formulas.map(normalizeArenaFormula).filter(Boolean)
      : [];
  }

  function normalizeArenaFormula(formula) {
    if (!formula || typeof formula !== "object") return null;

    const id = SCORE.sanitizeId(formula.id) || SCORE.makeId("arena-formula");
    const name = String(formula.name || "").trim() || "Untitled arena formula";
    const sourceSections = formula.sections && typeof formula.sections === "object" ? formula.sections : {};
    const sections = {};

    for (const key of ROLE_SECTION_KEYS) {
      const sourceSection = key === "duel"
        ? sourceSections.duel || sourceSections.standard || {}
        : sourceSections[key] || {};
      sections[key] = SCORE.normalizeScoreSection(sourceSection, { statKeys: ARENA_STAT_ORDER });
    }

    return {
      id,
      name,
      enabled: formula.enabled !== false,
      sections
    };
  }

  function cloneArenaFormula(formula) {
    return {
      id: formula.id,
      name: formula.name,
      enabled: formula.enabled !== false,
      sections: Object.fromEntries(ROLE_SECTION_KEYS.map((key) => [
        key,
        cloneSection(formula.sections?.[key] || {})
      ]))
    };
  }

  function cloneSection(section) {
    return {
      terms: (section.terms || []).map((term) => ({ ...term })),
      constraints: (section.constraints || []).map((constraint) => ({ ...constraint }))
    };
  }

  function scoreArenaCharacter(character, formula) {
    const normalizedFormula = normalizeArenaFormula(formula) || defaultArenaFormula();
    const sectionKey = normalizeRole(character?.role);
    const section = sectionWithFallback(normalizedFormula, sectionKey);
    const score = SCORE.score(character, section, stat);

    return {
      score,
      matches: SCORE.matches(character, section, stat),
      sectionKey
    };
  }

  function scoreArenaTeam(members, formula) {
    const scoredMembers = (members || []).map((member) => {
      const scored = scoreArenaCharacter(member, formula);
      return {
        ...member,
        formulaSection: scored.sectionKey,
        formulaScore: scored.score,
        formulaMatches: scored.matches
      };
    });
    return {
      members: scoredMembers,
      totalScore: scoredMembers.reduce((total, member) => total + member.formulaScore, 0),
      matches: scoredMembers.every((member) => member.formulaMatches)
    };
  }

  function sectionWithFallback(formula, sectionKey) {
    const section = formula.sections?.[sectionKey];
    if (section) return section;
    const duel = formula.sections?.duel;
    if (duel) return duel;
    return SCORE.normalizeScoreSection(DEFAULT_ARENA_FORMULA.sections[sectionKey] || DEFAULT_ARENA_FORMULA.sections.duel, { statKeys: ARENA_STAT_ORDER });
  }

  function stat(record, key) {
    if (key === "level") return Number(record?.level || record?.stats?.level) || 0;
    return Number(record?.stats?.[key]) || 0;
  }

  function summarizeArenaFormula(formula) {
    const normalized = normalizeArenaFormula(formula);
    if (!normalized) return "";
    return ROLE_SECTION_KEYS
      .map((key) => `${ROLE_SECTION_LABELS[key]}: ${SCORE.summarizeSection(normalized.sections[key], ARENA_STAT_LABELS)}`)
      .join(" | ");
  }

  function formatNumber(value) {
    return SCORE.formatNumber(Number(value) || 0);
  }

  function formatCharacterStats(character) {
    const stats = character?.stats || {};
    return [
      character?.roleLabel ? `${character.roleLabel}` : "",
      `Str ${stats.strength || 0}`,
      `Dex ${stats.dexterity || 0}`,
      `Agi ${stats.agility || 0}`,
      `Con ${stats.constitution || 0}`,
      `Cha ${stats.charisma || 0}`,
      `Int ${stats.intelligence || 0}`,
      stats.lifeMax ? `HP ${formatNumber(stats.lifeMax)}` : "",
      `DMG ${formatNumber(averageDamage(stats))}`,
      `Armour ${stats.armour || 0}`,
      stats.critChance ? `Crit ${formatNumber(stats.critChance)}%` : "",
      stats.blockChance ? `Block ${formatNumber(stats.blockChance)}%` : "",
      stats.critAvoidChance ? `Avoid crit ${formatNumber(stats.critAvoidChance)}%` : "",
      `Healing ${stats.healing || 0}`
    ].filter(Boolean).join(" | ");
  }

  root.GladiatusArenaCore = {
    ArenaCharacter,
    arenaKindFromUrl,
    defaultArenaFormula,
    formulasStorageKey: FORMULAS_STORAGE_KEY,
    passiveScansStorageKey: PASSIVE_SCANS_STORAGE_KEY,
    resultsStorageKey: RESULTS_STORAGE_KEY,
    scanStatusStorageKey: SCAN_STATUS_STORAGE_KEY,
    selfProfileStorageKey: SELF_PROFILE_STORAGE_KEY,
    selfProfileMaxAgeMs: SELF_PROFILE_MAX_AGE_MS,
    arenaOpponentFingerprint,
    combatantFromCharacter,
    combatantReadiness,
    combatProfile,
    deriveSelfProfileUrl,
    formatArenaFormula: summarizeArenaFormula,
    formatCharacterStats,
    formatNumber,
    isArenaPageUrl,
    normalizeArenaFormula,
    normalizeArenaFormulas,
    parseCharacterFromDocument,
    parseCharacterFromHtml,
    parseDamageRange,
    parseFightArgs,
    parseInteger,
    parseProfileDetailsFromTooltips,
    parseProfileEquipmentItems,
    parseTooltipRows,
    parseRoleFromTooltipText,
    profileStats,
    primaryStatKeys: PRIMARY_STAT_KEYS,
    profileTooltipIds: PROFILE_TOOLTIP_IDS,
    profileSelectors: PROFILE_SELECTORS,
    readArenaOpponentEntries,
    readArenaOpponentEntriesFromHtml,
    readProfileDollTabsFromDocument,
    readProfileDollTabsFromHtml,
    roleSectionKeys: ROLE_SECTION_KEYS,
    roleSectionLabels: ROLE_SECTION_LABELS,
    scoreArenaCharacter,
    scoreArenaTeam,
    stat,
    statLabels: ARENA_STAT_LABELS,
    statOptions: ARENA_STAT_ORDER.map((key) => ({ key, label: ARENA_STAT_LABELS[key] || key })),
    statOrder: ARENA_STAT_ORDER,
    teamDollTabs,
    characterScores
  };
})();
