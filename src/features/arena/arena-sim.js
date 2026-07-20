(() => {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const ARENA = root.GladiatusArenaCore;

  if (!ARENA || root.GladiatusArenaSim) return;

  const DEFAULT_ITERATIONS = 500;
  const DEFAULT_MAX_ROUNDS = 15;

  function simulateOddsPvP(attacker, defender, options = {}) {
    const iterations = Math.max(1, ARENA.parseInteger(options.iterations) || DEFAULT_ITERATIONS);
    const battleOptions = {
      maxRounds: ARENA.parseInteger(options.maxRounds) || DEFAULT_MAX_ROUNDS,
      firstAttacker: options.firstAttacker || "coinflip",
      random: options.random
    };
    let wins = 0;
    let losses = 0;
    let draws = 0;

    for (let index = 0; index < iterations; index += 1) {
      const battle = simulateBattle(attacker, defender, battleOptions);
      if (battle.outcome === "attacker_wins") wins += 1;
      else if (battle.outcome === "defender_wins") losses += 1;
      else draws += 1;
    }

    return simulationSummary({ iterations, wins, losses, draws });
  }

  function simulateBattle(attacker, defender, options = {}) {
    const random = typeof options.random === "function" ? options.random : Math.random;
    const maxRounds = ARENA.parseInteger(options.maxRounds) || DEFAULT_MAX_ROUNDS;
    const firstAttackerMode = options.firstAttacker || "coinflip";
    const attackerStart = normalizeCombatant(attacker);
    const defenderStart = normalizeCombatant(defender);
    const attackerState = { ...attackerStart, hp: attackerStart.maxHp };
    const defenderState = { ...defenderStart, hp: defenderStart.maxHp };
    const attackerEffectiveCrit = Math.max(0, attackerState.critChance - defenderState.critAvoidChance);
    const defenderEffectiveCrit = Math.max(0, defenderState.critChance - attackerState.critAvoidChance);
    const rounds = [];
    let outcome = "draw";
    let outcomeReason = "rounds_exhausted";
    let finished = false;

    for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
      const strikes = [];
      const defenderStrikesFirst = firstAttackerMode === "coinflip" ? random() < 0.5 : firstAttackerMode !== "attacker";
      const first = defenderStrikesFirst ? defenderState : attackerState;
      const second = defenderStrikesFirst ? attackerState : defenderState;
      const firstCrit = defenderStrikesFirst ? defenderEffectiveCrit : attackerEffectiveCrit;
      const secondCrit = defenderStrikesFirst ? attackerEffectiveCrit : defenderEffectiveCrit;

      strike(first, second, firstCrit, strikes, random, false);
      if (second.hp <= 0) {
        outcome = second === defenderState ? "attacker_wins" : "defender_wins";
        outcomeReason = second === defenderState ? "defender_killed" : "attacker_killed";
        rounds.push({ roundIndex, firstAttacker: first.name, strikes });
        finished = true;
        break;
      }

      strike(second, first, secondCrit, strikes, random, false);
      if (first.hp <= 0) {
        outcome = first === defenderState ? "attacker_wins" : "defender_wins";
        outcomeReason = first === defenderState ? "defender_killed" : "attacker_killed";
        rounds.push({ roundIndex, firstAttacker: first.name, strikes });
        finished = true;
        break;
      }

      rounds.push({ roundIndex, firstAttacker: first.name, strikes });
    }

    if (!finished) {
      const damage = totalDamageBySide(rounds, attackerState.name);
      if (damage.attacker > damage.defender) outcome = "attacker_wins";
      else if (damage.defender > damage.attacker) outcome = "defender_wins";
    }

    return {
      attacker: attackerStart,
      defender: defenderStart,
      rounds,
      outcome,
      outcomeReason
    };
  }

  function strike(attacker, defender, effectiveCrit, strikes, random, isSecondHalf) {
    const hitPct = chanceToHit(attacker.dexterity, defender.agility);
    if (random() * 100 >= hitPct) {
      strikes.push(strikeEvent(attacker, defender, {
        result: "miss",
        isSecondHalf,
        defenderHpAfter: defender.hp
      }));
      return;
    }

    const damageRolled = rollInt(random, attacker.damageMin, attacker.damageMax);
    const isCrit = random() * 100 < effectiveCrit;
    let damageAfterMods = isCrit ? damageRolled * 2 : damageRolled;
    const isBlocked = random() * 100 < defender.blockChance;
    if (isBlocked) damageAfterMods = Math.floor(damageAfterMods / 2);

    const absorbed = rollInt(random, defender.armourAbsorbMin, defender.armourAbsorbMax);
    const finalDamage = Math.max(0, damageAfterMods - absorbed);
    defender.hp = Math.max(0, defender.hp - finalDamage);

    strikes.push(strikeEvent(attacker, defender, {
      result: "hit",
      isCrit,
      isBlocked,
      isSecondHalf,
      damageRolled,
      damageAfterMods,
      absorbed,
      finalDamage,
      defenderHpAfter: defender.hp
    }));

    if (defender.hp <= 0 || isSecondHalf) return;
    if (random() * 100 < chanceToDoubleHit(attacker.charisma, attacker.dexterity, defender.intelligence, defender.agility)) {
      strike(attacker, defender, effectiveCrit, strikes, random, true);
    }
  }

  function strikeEvent(attacker, defender, values = {}) {
    return {
      attacker: attacker.name,
      defender: defender.name,
      result: values.result || "miss",
      isCrit: Boolean(values.isCrit),
      isBlocked: Boolean(values.isBlocked),
      isSecondHalfOfDoubleHit: Boolean(values.isSecondHalf),
      damageRolled: Number(values.damageRolled) || 0,
      damageAfterMods: Number(values.damageAfterMods) || 0,
      absorbed: Number(values.absorbed) || 0,
      finalDamage: Number(values.finalDamage) || 0,
      defenderHpAfter: Number(values.defenderHpAfter) || 0
    };
  }

  function simulationReadiness(selfRecord, opponentResult) {
    const missing = [];
    const warnings = [];
    const selfCombat = selfRecord?.character?.combat;
    const opponentCombat = opponentResult?.character?.combat;

    if (opponentResult?.team || opponentResult?.opponent?.arenaKind === "team") {
      missing.push("team simulation not supported");
    }
    if (!selfRecord?.character) missing.push("self profile");
    else if (isStaleSelfProfile(selfRecord)) missing.push("self profile stale");
    else if (!selfCombat?.ready) {
      for (const key of selfCombat?.missing || ["combat data"]) missing.push(`self ${key}`);
      warnings.push(...(selfCombat?.warnings || []).map((warning) => `self ${warning}`));
    }
    if (!opponentResult?.character) missing.push("opponent profile");
    else if (!opponentCombat?.ready) {
      for (const key of opponentCombat?.missing || ["combat data"]) missing.push(`opponent ${key}`);
      warnings.push(...(opponentCombat?.warnings || []).map((warning) => `opponent ${warning}`));
    }

    return {
      ready: missing.length === 0,
      missing,
      warnings
    };
  }

  function isStaleSelfProfile(selfRecord) {
    const timestamp = Date.parse(selfRecord?.scannedAt || "");
    return !Number.isFinite(timestamp) || Date.now() - timestamp >= ARENA.selfProfileMaxAgeMs;
  }

  function simulationSummary(result) {
    const iterations = Math.max(1, ARENA.parseInteger(result.iterations));
    const wins = ARENA.parseInteger(result.wins);
    const losses = ARENA.parseInteger(result.losses);
    const draws = ARENA.parseInteger(result.draws);
    return {
      ready: true,
      iterations,
      wins,
      losses,
      draws,
      winRate: wins / iterations,
      lossRate: losses / iterations,
      drawRate: draws / iterations,
      missing: [],
      warnings: []
    };
  }

  function totalDamageBySide(rounds, attackerName) {
    return rounds.reduce((totals, round) => {
      for (const strikeRecord of round.strikes || []) {
        if (strikeRecord.attacker === attackerName) totals.attacker += strikeRecord.finalDamage;
        else totals.defender += strikeRecord.finalDamage;
      }
      return totals;
    }, { attacker: 0, defender: 0 });
  }

  function chanceToHit(attackerDexterity, defenderAgility) {
    const dexterity = Number(attackerDexterity) || 0;
    const agility = Number(defenderAgility) || 0;
    return dexterity + agility <= 0 ? 0 : Math.floor((dexterity / (dexterity + agility)) * 100);
  }

  function chanceToDoubleHit(attackerCharisma, attackerDexterity, defenderIntelligence, defenderAgility) {
    const intelligence = Number(defenderIntelligence) || 0;
    const agility = Number(defenderAgility) || 0;
    if (intelligence <= 0 || agility <= 0) return 0;
    return ((Number(attackerCharisma) || 0) * (Number(attackerDexterity) || 0) * 10) / (intelligence * agility);
  }

  function rollInt(random, min, max) {
    const low = Math.floor(Number(min) || 0);
    const high = Math.floor(Number(max) || 0);
    if (high < low) return low;
    return Math.floor(random() * (high - low + 1)) + low;
  }

  function normalizeCombatant(combatant = {}) {
    return {
      name: String(combatant.name || "Unknown fighter"),
      level: ARENA.parseInteger(combatant.level),
      hp: Math.max(0, ARENA.parseInteger(combatant.hp)),
      maxHp: Math.max(0, ARENA.parseInteger(combatant.maxHp || combatant.hp)),
      damageMin: Math.max(0, ARENA.parseInteger(combatant.damageMin)),
      damageMax: Math.max(0, ARENA.parseInteger(combatant.damageMax)),
      armour: Math.max(0, ARENA.parseInteger(combatant.armour)),
      armourAbsorbMin: Math.max(0, ARENA.parseInteger(combatant.armourAbsorbMin)),
      armourAbsorbMax: Math.max(0, ARENA.parseInteger(combatant.armourAbsorbMax)),
      strength: Math.max(0, ARENA.parseInteger(combatant.strength)),
      dexterity: Math.max(0, ARENA.parseInteger(combatant.dexterity)),
      agility: Math.max(0, ARENA.parseInteger(combatant.agility)),
      constitution: Math.max(0, ARENA.parseInteger(combatant.constitution)),
      charisma: Math.max(0, ARENA.parseInteger(combatant.charisma)),
      intelligence: Math.max(0, ARENA.parseInteger(combatant.intelligence)),
      critChance: clamp(Number(combatant.critChance) || 0, 0, 50),
      blockChance: clamp(Number(combatant.blockChance) || 0, 0, 50),
      critAvoidChance: clamp(Number(combatant.critAvoidChance) || 0, 0, 25)
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  root.GladiatusArenaSim = {
    defaultIterations: DEFAULT_ITERATIONS,
    defaultMaxRounds: DEFAULT_MAX_ROUNDS,
    simulateBattle,
    simulateOddsPvP,
    simulationReadiness
  };
})();
