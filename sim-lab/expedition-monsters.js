"use strict";

// Fixed expedition targets transcribed from the live monster cards. Use maximum
// life because the displayed current life is transient between fights.
const EXPEDITION_MONSTERS = Object.freeze({
  "high-shaman": Object.freeze({
    id: "high-shaman",
    name: "High Shaman",
    level: 106,
    hp: 6459,
    maxHp: 6459,
    strength: 106,
    dexterity: 583,
    agility: 890,
    constitution: 212,
    charisma: 704,
    intelligence: 487,
    armour: 5006,
    armourAbsorbMin: 67,
    armourAbsorbMax: 82,
    damageMin: 342,
    damageMax: 420,
  }),
  "demon-elephant": Object.freeze({
    id: "demon-elephant",
    name: "Demon Elephant",
    level: 101,
    hp: 6349,
    maxHp: 6349,
    strength: 484,
    dexterity: 227,
    agility: 494,
    constitution: 404,
    charisma: 494,
    intelligence: 242,
    armour: 14752,
    armourAbsorbMin: 200,
    armourAbsorbMax: 245,
    damageMin: 295,
    damageMax: 362,
  }),
});

function getExpeditionMonster(id) {
  return EXPEDITION_MONSTERS[String(id || "").trim().toLowerCase()] || null;
}

module.exports = { EXPEDITION_MONSTERS, getExpeditionMonster };
