// R-STAT, R-UTIL, R-ECO: scoreboard, per-round timeline, weapons, utility and economy for one match.
import { isGun, TICK_RATE } from './geometry.ts';
import { at, type Row, type TickData } from './load.ts';
import { roundOf, WIN_REASONS, type Round } from './rounds.ts';

export interface EconomyConfig {
  /** Average equipment value per player (at buy-time end) below which a round is an eco. */
  ecoBelow: number;
  /** At or above this it's a full buy. Between eco and full: force if money left is low, else half buy. */
  fullBuyFrom: number;
  /** Average money left per player below which a non-full buy counts as a force buy. */
  forceMoneyLeftBelow: number;
}

export const DEFAULT_ECONOMY: EconomyConfig = { ecoBelow: 1500, fullBuyFrom: 3900, forceMoneyLeftBelow: 1000 };

export type BuyType = 'pistol' | 'eco' | 'force' | 'half' | 'full';

const TRADE_WINDOW_TICKS = 5 * TICK_RATE;

const UTILITY_PRICES: Record<string, number> = {
  Flashbang: 200,
  'Smoke Grenade': 300,
  'High Explosive Grenade': 300,
  Molotov: 400,
  'Incendiary Grenade': 500,
  'Decoy Grenade': 50,
};

export interface PlayerStats {
  steamId: string;
  name: string;
  team: 'A' | 'B';
  startSide: 2 | 3;
  roundsPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  flashAssists: number;
  teamKills: number;
  suicides: number;
  headshotKills: number;
  hsPercent: number | null;
  kd: number | null;
  damage: number;
  adr: number | null;
  kast: number | null;
  multiKills: Record<'2k' | '3k' | '4k' | '5k', number>;
  openingKills: number;
  openingDeaths: number;
  clutches: { won: number; lost: number; byEnemies: Record<string, { won: number; lost: number }> };
  tradeKills: number;
  tradedDeaths: number;
  mvps: number | null;
  score: number | null;
  rank: number | null;
  rankType: number | null;
  wins: number | null;
  crosshairCode: string | null;
  rating: number | null;
  weapons: Record<string, { kills: number; hsKills: number; damage: number; shots: number; hits: number; accuracy: number | null; hsPercent: number | null }>;
  utility: {
    flashesThrown: number;
    enemiesFlashed: number;
    teammatesFlashed: number;
    avgEnemyBlindS: number | null;
    flashAssists: number;
    heThrown: number;
    heDamage: number;
    fireThrown: number;
    fireDamage: number;
    smokesThrown: number;
    decoysThrown: number;
    utilityDamagePerRound: number | null;
    unusedUtilityValue: number;
    unusedUtilityItems: number;
  };
  economy: { moneySpent: number; avgEquipValue: number | null };
}

export interface RoundStats {
  round: number;
  winner: 'A' | 'B' | null;
  winnerSide: 'T' | 'CT' | null;
  winReason: string | null;
  scoreA: number;
  scoreB: number;
  sideA: 'T' | 'CT' | null;
  firstDeath: { victim: string; attacker: string | null; tick: number } | null;
  players: Record<string, { kills: number; damage: number; died: boolean; side: 'T' | 'CT' | null; equipValue: number | null; moneySpent: number | null; purchases: string[] }>;
  teams: Record<'A' | 'B', { buyType: BuyType | null; equipValue: number; moneySpent: number }>;
  startTick: number;
  endTick: number;
}

export interface MatchSummary {
  rounds: number;
  scoreA: number;
  scoreB: number;
  winner: 'A' | 'B' | 'draw' | null;
  isRush: boolean;
  economy: Record<'A' | 'B', Record<BuyType, { rounds: number; won: number }>> | null;
  halftimeRound: number | null;
  economyConfig: EconomyConfig;
}

export interface StatsInput {
  td: TickData;
  rounds: Round[];
  players: { steamid: string; name: string; team_number: number }[];
  deaths: Row[];
  hurts: Row[];
  fires: Row[];
  blinds: Row[];
  flashDet: Row[];
  smokeDet: Row[];
  heDet: Row[];
  infernoStart: Row[];
  decoyStart: Row[];
  snapshots: Row[];
  /** Inventories keyed `${tick}:${steamid}`. */
  inventories: Map<string, string[]>;
  map: string | null;
  economy?: EconomyConfig;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' && v !== '0' ? v : null);
const normWeapon = (w: unknown) => String(w ?? '').replace(/^weapon_/, '') || 'unknown';
const sideLetter = (s: number | null | undefined): 'T' | 'CT' | null => (s === 2 ? 'T' : s === 3 ? 'CT' : null);

/** Ticks whose inventories stats need: round start, buy end, and the tick before each death. */
export function inventoryTicks(rounds: Round[], deaths: Row[]): number[] {
  const t: number[] = [];
  for (const r of rounds) t.push(r.start + 1, r.buyEnd);
  for (const d of deaths) t.push(Math.max(0, (d.tick as number) - 1));
  return t;
}

export function computeStats(input: StatsInput) {
  const { td, rounds } = input;
  const econ = input.economy ?? DEFAULT_ECONOMY;
  const isRush = (input.map ?? '').startsWith('rush_');
  const ids = td.steamIds;
  const startSide = new Map<string, 2 | 3>();
  for (const p of input.players) if (p.team_number === 2 || p.team_number === 3) startSide.set(p.steamid, p.team_number);
  const teamOf = (sid: string): 'A' | 'B' => (startSide.get(sid) === 3 ? 'B' : 'A');

  /** Side of a player in a round: team_num at freeze end, falling back to the nearest tick in the round. */
  const sideCache = new Map<string, 2 | 3 | null>();
  const sideIn = (sid: string, r: Round): 2 | 3 | null => {
    const key = `${sid}:${r.round}`;
    if (sideCache.has(key)) return sideCache.get(key)!;
    const p = td.index.get(sid);
    let side: 2 | 3 | null = null;
    if (p !== undefined) {
      for (const t of [r.freezeEnd, r.buyEnd, r.start + 1, r.end - 1]) {
        if (t < 0 || t > td.maxTick) continue;
        const v = td.f.team_num[at(td, p, t)];
        if (v === 2 || v === 3) {
          side = v;
          break;
        }
      }
    }
    sideCache.set(key, side);
    return side;
  };
  const sideAOf = (r: Round): 2 | 3 | null => {
    let t = 0;
    let ct = 0;
    for (const sid of ids) if (teamOf(sid) === 'A') sideIn(sid, r) === 2 ? t++ : sideIn(sid, r) === 3 ? ct++ : 0;
    return t === 0 && ct === 0 ? null : t >= ct ? 2 : 3;
  };

  const ps = new Map<string, PlayerStats>();
  for (const sid of ids) {
    ps.set(sid, {
      steamId: sid,
      name: td.names[td.index.get(sid)!] || input.players.find((p) => p.steamid === sid)?.name || sid,
      team: teamOf(sid),
      startSide: startSide.get(sid) ?? 2,
      roundsPlayed: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      flashAssists: 0,
      teamKills: 0,
      suicides: 0,
      headshotKills: 0,
      hsPercent: null,
      kd: null,
      damage: 0,
      adr: null,
      kast: null,
      multiKills: { '2k': 0, '3k': 0, '4k': 0, '5k': 0 },
      openingKills: 0,
      openingDeaths: 0,
      clutches: { won: 0, lost: 0, byEnemies: {} },
      tradeKills: 0,
      tradedDeaths: 0,
      mvps: null,
      score: null,
      rank: null,
      rankType: null,
      wins: null,
      crosshairCode: null,
      rating: null,
      weapons: {},
      utility: {
        flashesThrown: 0,
        enemiesFlashed: 0,
        teammatesFlashed: 0,
        avgEnemyBlindS: null,
        flashAssists: 0,
        heThrown: 0,
        heDamage: 0,
        fireThrown: 0,
        fireDamage: 0,
        smokesThrown: 0,
        decoysThrown: 0,
        utilityDamagePerRound: null,
        unusedUtilityValue: 0,
        unusedUtilityItems: 0,
      },
      economy: { moneySpent: 0, avgEquipValue: null },
    });
  }
  const weapon = (sid: string, w: string) => (ps.get(sid)!.weapons[w] ??= { kills: 0, hsKills: 0, damage: 0, shots: 0, hits: 0, accuracy: null, hsPercent: null });

  // ---- per-round bookkeeping ----
  const roundStats: RoundStats[] = [];
  const kastRounds = new Map<string, number>();
  const blindSum = new Map<string, number>();
  const equipSum = new Map<string, { sum: number; n: number }>();
  let scoreA = 0;
  let scoreB = 0;
  let halftimeRound: number | null = null;
  let prevSideA: 2 | 3 | null = null;
  const econAgg: Record<'A' | 'B', Record<BuyType, { rounds: number; won: number }>> = {
    A: { pistol: { rounds: 0, won: 0 }, eco: { rounds: 0, won: 0 }, force: { rounds: 0, won: 0 }, half: { rounds: 0, won: 0 }, full: { rounds: 0, won: 0 } },
    B: { pistol: { rounds: 0, won: 0 }, eco: { rounds: 0, won: 0 }, force: { rounds: 0, won: 0 }, half: { rounds: 0, won: 0 }, full: { rounds: 0, won: 0 } },
  };

  const inRound = <T extends Row>(rows: T[], r: Round) => rows.filter((e) => (e.tick as number) > r.start && (e.tick as number) <= r.end);
  const snapAtEnd = (r: Round, sid: string) => input.snapshots.find((s) => s.steamid === sid && (s.tick as number) <= r.end && (s.tick as number) >= r.end - 2);

  for (const r of rounds) {
    const sideA = sideAOf(r);
    const sideSwitch = prevSideA !== null && sideA !== null && sideA !== prevSideA;
    if (sideSwitch && halftimeRound === null) halftimeRound = r.round;
    prevSideA = sideA ?? prevSideA;
    const winner: 'A' | 'B' | null = r.winnerSide && sideA ? (r.winnerSide === sideA ? 'A' : 'B') : null;
    if (winner === 'A') scoreA++;
    if (winner === 'B') scoreB++;

    const deaths = inRound(input.deaths, r);
    const hurts = inRound(input.hurts, r);
    const rs: RoundStats = {
      round: r.round,
      winner,
      winnerSide: sideLetter(r.winnerSide),
      winReason: r.winReason !== null ? (WIN_REASONS[r.winReason] ?? `reason ${r.winReason}`) : null,
      scoreA,
      scoreB,
      sideA: sideLetter(sideA),
      firstDeath: null,
      players: {},
      teams: { A: { buyType: null, equipValue: 0, moneySpent: 0 }, B: { buyType: null, equipValue: 0, moneySpent: 0 } },
      startTick: r.start,
      endTick: r.end,
    };
    const participants = ids.filter((sid) => sideIn(sid, r) !== null);
    for (const sid of participants) {
      const p = td.index.get(sid)!;
      const eq = td.f.equip_value[at(td, p, Math.min(r.buyEnd, td.maxTick))];
      const snap = snapAtEnd(r, sid);
      const spent = typeof snap?.cash_spent_this_round === 'number' ? snap.cash_spent_this_round : null;
      const before = input.inventories.get(`${r.start + 1}:${sid}`) ?? [];
      const after = input.inventories.get(`${r.buyEnd}:${sid}`) ?? [];
      const purchases = multisetDiff(after, before);
      rs.players[sid] = { kills: 0, damage: 0, died: false, side: sideLetter(sideIn(sid, r)), equipValue: Number.isNaN(eq) ? null : eq, moneySpent: spent, purchases };
      ps.get(sid)!.roundsPlayed++;
      const team = teamOf(sid);
      if (!Number.isNaN(eq)) {
        rs.teams[team].equipValue += eq;
        const e = equipSum.get(sid) ?? { sum: 0, n: 0 };
        e.sum += eq;
        e.n++;
        equipSum.set(sid, e);
      }
      if (spent !== null) {
        rs.teams[team].moneySpent += spent;
        ps.get(sid)!.economy.moneySpent += spent;
      }
    }

    // Economy buy types (R-ECO). Not meaningful for Rush.
    if (!isRush) {
      for (const team of ['A', 'B'] as const) {
        const members = participants.filter((s) => teamOf(s) === team);
        if (!members.length) continue;
        let money = 0;
        for (const sid of members) {
          const m = td.f.money[at(td, td.index.get(sid)!, Math.min(r.buyEnd, td.maxTick))];
          money += Number.isNaN(m) ? 0 : m;
        }
        const avgEquip = rs.teams[team].equipValue / members.length;
        const avgMoney = money / members.length;
        const pistol = r.round === 1 || r.round === halftimeRound;
        const bt: BuyType = pistol
          ? 'pistol'
          : avgEquip < econ.ecoBelow
            ? 'eco'
            : avgEquip >= econ.fullBuyFrom
              ? 'full'
              : avgMoney < econ.forceMoneyLeftBelow
                ? 'force'
                : 'half';
        rs.teams[team].buyType = bt;
        econAgg[team][bt].rounds++;
        if (winner === team) econAgg[team][bt].won++;
      }
    }

    // Alive tracking for clutches.
    const alive = new Map<2 | 3, Set<string>>([
      [2, new Set(participants.filter((s) => sideIn(s, r) === 2))],
      [3, new Set(participants.filter((s) => sideIn(s, r) === 3))],
    ]);
    const clutch = new Map<string, number>();
    const roundKills = new Map<string, number>();
    const contributed = new Set<string>();
    const recentKills: { killer: string; victim: string; tick: number }[] = [];
    const tradedVictims = new Set<string>();

    for (const d of deaths) {
      const victim = str(d.user_steamid);
      const attacker = str(d.attacker_steamid);
      const assister = str(d.assister_steamid);
      const tick = d.tick as number;
      if (!victim || !ps.has(victim)) continue;
      const vSide = sideIn(victim, r);
      const aSide = attacker && ps.has(attacker) ? sideIn(attacker, r) : null;
      const vs = ps.get(victim)!;
      vs.deaths++;
      if (rs.players[victim]) rs.players[victim].died = true;
      if (!rs.firstDeath) {
        rs.firstDeath = { victim, attacker, tick };
        if (attacker && attacker !== victim && aSide !== vSide && ps.has(attacker)) {
          ps.get(attacker)!.openingKills++;
          vs.openingDeaths++;
        }
      }
      const w = normWeapon(d.weapon);
      if (!attacker || attacker === victim) vs.suicides++;
      else if (ps.has(attacker)) {
        const as = ps.get(attacker)!;
        if (aSide !== null && aSide === vSide) as.teamKills++;
        else {
          as.kills++;
          if (d.headshot) as.headshotKills++;
          const ws = weapon(attacker, w);
          ws.kills++;
          if (d.headshot) ws.hsKills++;
          roundKills.set(attacker, (roundKills.get(attacker) ?? 0) + 1);
          contributed.add(attacker);
          if (rs.players[attacker]) rs.players[attacker].kills++;
          // Trade: attacker killed someone who killed a teammate of the attacker within the window.
          for (const k of recentKills) {
            if (k.killer === victim && tick - k.tick <= TRADE_WINDOW_TICKS && sideIn(k.victim, r) === aSide && k.victim !== attacker) {
              as.tradeKills++;
              if (!tradedVictims.has(k.victim)) {
                tradedVictims.add(k.victim);
                ps.get(k.victim)!.tradedDeaths++;
              }
              break;
            }
          }
          recentKills.push({ killer: attacker, victim, tick });
        }
      }
      if (assister && ps.has(assister) && assister !== attacker) {
        const ast = ps.get(assister)!;
        if (sideIn(assister, r) !== vSide) {
          ast.assists++;
          contributed.add(assister);
          if (d.assistedflash) {
            ast.flashAssists++;
            ast.utility.flashAssists++;
          }
        }
      }
      // Unused utility at death (value lost).
      const inv = input.inventories.get(`${Math.max(0, tick - 1)}:${victim}`) ?? [];
      for (const item of inv) {
        const price = UTILITY_PRICES[item];
        if (price) {
          vs.utility.unusedUtilityValue += price;
          vs.utility.unusedUtilityItems++;
        }
      }
      // Clutch detection.
      if (vSide) {
        alive.get(vSide)!.delete(victim);
        for (const side of [2, 3] as const) {
          const mine = alive.get(side)!;
          const other = alive.get(side === 2 ? 3 : 2)!;
          if (mine.size === 1 && other.size >= 1) {
            const [last] = mine;
            if (!clutch.has(last)) clutch.set(last, other.size);
          }
        }
      }
    }
    for (const [sid, enemies] of clutch) {
      const won = r.winnerSide !== null && sideIn(sid, r) === r.winnerSide;
      const c = ps.get(sid)!.clutches;
      const key = `1v${enemies}`;
      c.byEnemies[key] ??= { won: 0, lost: 0 };
      if (won) {
        c.won++;
        c.byEnemies[key].won++;
      } else {
        c.lost++;
        c.byEnemies[key].lost++;
      }
    }
    for (const [sid, k] of roundKills) {
      if (k >= 2) ps.get(sid)!.multiKills[`${Math.min(k, 5)}k` as '2k']++;
    }
    for (const h of hurts) {
      const attacker = str(h.attacker_steamid);
      const victim = str(h.user_steamid);
      if (!attacker || !victim || attacker === victim || !ps.has(attacker) || !ps.has(victim)) continue;
      if (sideIn(attacker, r) === sideIn(victim, r)) continue;
      const before = typeof h.user_health === 'number' ? h.user_health : 100;
      const dmg = Math.max(0, Math.min(Number(h.dmg_health ?? 0), before));
      ps.get(attacker)!.damage += dmg;
      if (rs.players[attacker]) rs.players[attacker].damage += dmg;
      const w = normWeapon(h.weapon);
      const ws = weapon(attacker, w);
      ws.damage += dmg;
      if (isGun(w)) ws.hits++;
      const u = ps.get(attacker)!.utility;
      if (w === 'hegrenade') u.heDamage += dmg;
      if (w === 'inferno' || w === 'molotov' || w === 'incgrenade') u.fireDamage += dmg;
    }
    // KAST: kill, assist, survived or traded.
    for (const sid of participants) {
      const survived = !rs.players[sid]?.died;
      if (contributed.has(sid) || survived || tradedVictims.has(sid)) kastRounds.set(sid, (kastRounds.get(sid) ?? 0) + 1);
    }
    roundStats.push(rs);
  }

  // ---- shots, utility throws, flashes ----
  for (const f of input.fires) {
    const sid = str(f.user_steamid);
    if (!sid || !ps.has(sid) || !roundOf(rounds, f.tick as number)) continue;
    const w = normWeapon(f.weapon);
    if (isGun(w)) weapon(sid, w).shots++;
  }
  const countThrow = (rows: Row[], key: 'flashesThrown' | 'smokesThrown' | 'heThrown' | 'fireThrown' | 'decoysThrown') => {
    for (const e of rows) {
      const sid = str(e.user_steamid);
      if (sid && ps.has(sid) && roundOf(rounds, e.tick as number)) ps.get(sid)!.utility[key]++;
    }
  };
  countThrow(input.flashDet, 'flashesThrown');
  countThrow(input.smokeDet, 'smokesThrown');
  countThrow(input.heDet, 'heThrown');
  countThrow(input.infernoStart, 'fireThrown');
  countThrow(input.decoyStart, 'decoysThrown');
  for (const b of input.blinds) {
    const attacker = str(b.attacker_steamid);
    const victim = str(b.user_steamid);
    const r = roundOf(rounds, b.tick as number);
    if (!attacker || !victim || !ps.has(attacker) || !ps.has(victim) || !r) continue;
    const dur = Number(b.blind_duration ?? 0);
    if (dur <= 0 || attacker === victim) continue;
    const u = ps.get(attacker)!.utility;
    if (sideIn(attacker, r) === sideIn(victim, r)) u.teammatesFlashed++;
    else {
      u.enemiesFlashed++;
      blindSum.set(attacker, (blindSum.get(attacker) ?? 0) + dur);
    }
  }

  // ---- final per-player numbers ----
  const lastSnap = new Map<string, Row>();
  for (const s of input.snapshots) {
    const sid = str(s.steamid);
    if (!sid) continue;
    const prev = lastSnap.get(sid);
    if (!prev || (s.tick as number) > (prev.tick as number)) lastSnap.set(sid, s);
  }
  for (const s of ps.values()) {
    const rp = s.roundsPlayed || 1;
    s.kd = s.deaths ? round2(s.kills / s.deaths) : s.kills ? s.kills : null;
    s.hsPercent = s.kills ? round1((100 * s.headshotKills) / s.kills) : null;
    s.adr = s.roundsPlayed ? round1(s.damage / rp) : null;
    s.kast = s.roundsPlayed ? round1((100 * (kastRounds.get(s.steamId) ?? 0)) / rp) : null;
    const snap = lastSnap.get(s.steamId);
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    s.mvps = n(snap?.mvps);
    s.score = n(snap?.score);
    s.rank = n(snap?.rank);
    s.rankType = n(snap?.comp_rank_type);
    s.wins = n(snap?.comp_wins);
    s.crosshairCode = typeof snap?.crosshair_code === 'string' ? snap.crosshair_code : null;
    s.utility.avgEnemyBlindS = s.utility.enemiesFlashed ? round2((blindSum.get(s.steamId) ?? 0) / s.utility.enemiesFlashed) : null;
    s.utility.utilityDamagePerRound = s.roundsPlayed ? round1((s.utility.heDamage + s.utility.fireDamage) / rp) : null;
    const e = equipSum.get(s.steamId);
    s.economy.avgEquipValue = e?.n ? Math.round(e.sum / e.n) : null;
    for (const w of Object.values(s.weapons)) {
      w.accuracy = w.shots ? round1((100 * Math.min(w.hits, w.shots)) / w.shots) : null;
      w.hsPercent = w.kills ? round1((100 * w.hsKills) / w.kills) : null;
    }
    // HLTV 2.0-style approximation (community regression).
    if (s.roundsPlayed) {
      const kpr = s.kills / rp;
      const dpr = s.deaths / rp;
      const apr = s.assists / rp;
      const impact = 2.13 * kpr + 0.42 * apr - 0.41;
      s.rating = round2(0.0073 * (s.kast ?? 0) + 0.3591 * kpr - 0.5329 * dpr + 0.2372 * impact + 0.0032 * (s.adr ?? 0) + 0.1587);
    }
  }

  const summary: MatchSummary = {
    rounds: rounds.length,
    scoreA,
    scoreB,
    winner: scoreA > scoreB ? 'A' : scoreB > scoreA ? 'B' : rounds.length ? 'draw' : null,
    isRush,
    economy: isRush ? null : econAgg,
    halftimeRound,
    economyConfig: econ,
  };
  return { players: [...ps.values()].filter((p) => p.roundsPlayed > 0), rounds: roundStats, summary, sideIn };
}

function multisetDiff(after: string[], before: string[]): string[] {
  const left = new Map<string, number>();
  for (const b of before) left.set(b, (left.get(b) ?? 0) + 1);
  const out: string[] = [];
  for (const a of after) {
    const n = left.get(a) ?? 0;
    if (n > 0) left.set(a, n - 1);
    else out.push(a);
  }
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
