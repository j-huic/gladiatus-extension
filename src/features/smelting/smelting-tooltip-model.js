// Structured, presentation-neutral model for adding smelting data to native
// Gladiatus tooltips. The game can render multiple columns, so only column 0
// belongs to the inspected item; later columns are comparisons and stay intact.
(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : self;
  const VERSION = "smelting-tooltip-model-v1";
  const DATA = root.GladiatusSmeltingMaterialData;
  const MATERIALS_HEADER = "Smelting materials";

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
      baseName: affixes.baseName,
      materials: affixes.materials,
      hasMaterials: Object.keys(affixes.materials).length > 0
    });
  }

  function hasMaterialsBlock(column) {
    return Array.isArray(column) && column.some((row) => rowText(row) === MATERIALS_HEADER);
  }

  function appendMaterials(rawTooltip) {
    const item = itemFromPayload(rawTooltip);
    if (!item || !item.hasMaterials || hasMaterialsBlock(item.payload[0])) {
      return Object.freeze({ changed: false, item, payload: item?.payload || null });
    }

    item.payload[0].push([MATERIALS_HEADER, "#BA9700"]);
    for (const [material, quantity] of Object.entries(item.materials)) {
      item.payload[0].push([`${quantity} × ${material}`, "#DDD"]);
    }
    return Object.freeze({ changed: true, item, payload: item.payload });
  }

  root.GladiatusSmeltingTooltipModel = Object.freeze({
    version: VERSION,
    materialsHeader: MATERIALS_HEADER,
    parsePayload,
    itemFromPayload,
    appendMaterials,
    rowText
  });
})();
