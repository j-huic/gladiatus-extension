// Structured, presentation-neutral model for adding smelting data to native
// Gladiatus tooltips. The game can render multiple columns, so only column 0
// belongs to the inspected item; later columns are comparisons and stay intact.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const VERSION = "smelting-tooltip-model-v3";
  const DATA = root.GladiatusSmeltingMaterialData;
  const LEGACY_AFFIXES_HEADER = "Affix levels";
  const MATERIALS_HEADER = "Smelting materials";
  const MATERIAL_COLOR_OPTIONS = Object.freeze([
    Object.freeze({ id: "red", label: "Red", value: "#FF5A5A" }),
    Object.freeze({ id: "orange", label: "Orange", value: "#FF9B3D" }),
    Object.freeze({ id: "yellow", label: "Yellow", value: "#F5D547" }),
    Object.freeze({ id: "green", label: "Green", value: "#58C56B" }),
    Object.freeze({ id: "blue", label: "Blue", value: "#6AA9FF" })
  ]);
  const MATERIAL_COLORS = Object.freeze(Object.fromEntries(
    MATERIAL_COLOR_OPTIONS.map((option) => [option.id, option.value])
  ));

  if (!DATA) throw new Error("GladiatusSmeltingMaterialData must load before GladiatusSmeltingTooltipModel.");
  if (root.GladiatusSmeltingTooltipModel?.version === VERSION) return;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function parsePayload(rawTooltip) {
    if (typeof rawTooltip === "string") {
      try {
        return parsePayload(JSON.parse(rawTooltip));
      } catch (_error) {
        return null;
      }
    }

    if (!Array.isArray(rawTooltip) || !Array.isArray(rawTooltip[0])) return null;
    return clone(rawTooltip);
  }

  function rowText(row) {
    if (typeof row === "string") return row;
    if (!Array.isArray(row)) return "";
    if (typeof row[0] === "string") return row[0];
    if (Array.isArray(row[0]) && typeof row[0][0] === "string") return row[0][0];
    return "";
  }

  function itemFromPayload(rawTooltip) {
    const payload = parsePayload(rawTooltip);
    const title = rowText(payload?.[0]?.[0]);
    if (!payload || !title) return null;

    const affixes = DATA.affixesForTitle(title);
    return Object.freeze({
      payload,
      title: affixes.title,
      prefix: affixes.prefix,
      suffix: affixes.suffix,
      prefixLevel: affixes.prefixLevel,
      suffixLevel: affixes.suffixLevel,
      baseName: affixes.baseName,
      prefixMaterials: DATA.materialsFor("prefix", affixes.prefix),
      suffixMaterials: DATA.materialsFor("suffix", affixes.suffix),
      materials: affixes.materials,
      hasAffixes: Boolean(affixes.prefix || affixes.suffix),
      hasMaterials: Object.keys(affixes.materials).length > 0
    });
  }

  function affixLabel(name, level) {
    return `${name} (${level})`;
  }

  function affixGroups(item) {
    return [
      item.prefix && item.prefixLevel != null
        ? { name: item.prefix, level: item.prefixLevel, materials: item.prefixMaterials }
        : null,
      item.suffix && item.suffixLevel != null
        ? { name: item.suffix, level: item.suffixLevel, materials: item.suffixMaterials }
        : null
    ].filter(Boolean);
  }

  function hasAffixGroups(column, item) {
    return affixGroups(item).every((group) => column.some((row) => rowText(row) === affixLabel(group.name, group.level)));
  }

  function removeLegacyBlocks(column) {
    const firstLegacyRow = column.findIndex((row) => {
      const text = rowText(row);
      return text === LEGACY_AFFIXES_HEADER || text === MATERIALS_HEADER;
    });
    if (firstLegacyRow >= 0) column.splice(firstLegacyRow);
  }

  function colorForMaterial(materialColors, material) {
    return MATERIAL_COLORS[materialColors?.[material]] || "#DDD";
  }

  function appendMaterials(rawTooltip, options = {}) {
    const item = itemFromPayload(rawTooltip);
    if (!item || !item.hasAffixes) {
      return Object.freeze({ changed: false, item, payload: item?.payload || null });
    }

    if (hasAffixGroups(item.payload[0], item)) {
      return Object.freeze({ changed: false, item, payload: item.payload });
    }

    removeLegacyBlocks(item.payload[0]);
    for (const group of affixGroups(item)) {
      item.payload[0].push([affixLabel(group.name, group.level), "#BA9700"]);
      for (const [material, quantity] of Object.entries(group.materials)) {
        item.payload[0].push([`- ${quantity} × ${material}`, colorForMaterial(options.materialColors, material)]);
      }
    }
    return Object.freeze({ changed: true, item, payload: item.payload });
  }

  root.GladiatusSmeltingTooltipModel = Object.freeze({
    version: VERSION,
    affixLabel,
    materialColorOptions: MATERIAL_COLOR_OPTIONS,
    colorForMaterial,
    parsePayload,
    itemFromPayload,
    appendMaterials,
    rowText
  });
})();
