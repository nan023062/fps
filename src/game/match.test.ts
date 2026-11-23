import { describe, expect, it } from 'vitest';
import type { InputSnapshot } from '../core/input';
import { Match, ROUNDS_TO_WIN, ROUND_END_DELAY } from './match';
import { DUST_LEVEL } from '../world/map';
import { REDOUBT_LEVEL } from '../world/level_redoubt';

const input: InputSnapshot = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  crouch: false,
  walk: false,
  fire: false,
  scoreboard: false,
  reloadRequest: false,
  switchRequest: null,
  mouseDX: 0,
  mouseDY: 0,
  pointerLocked: true,
};

function advance(match: Match, seconds: number): void {
  const steps = Math.ceil(seconds * 60);
  for (let i = 0; i < steps; i += 1) {
    match.update(1 / 60, input);
  }
}

function killTeam(match: Match, team: 'ct' | 't', attackerId = match.player.id): void {
  for (const bot of match.bots.filter((b) => b.team === team && b.alive)) {
    match.damageActor(bot.id, 500, false, attackerId);
  }
}

describe('Match', () => {
  it('starts a live first round', () => {
    const match = new Match();
    match.startMatch();
    expect(match.phase).toBe('live');
    expect(match.round).toBe(1);
    expect(match.scoreCT).toBe(0);
    expect(match.scoreT).toBe(0);
  });

  it('ends the round when one team is eliminated and resets it', () => {
    const match = new Match();
    match.startMatch();
    killTeam(match, 't');
    match.update(1 / 60, input);
    expect(match.phase).toBe('roundOver');
    expect(match.roundWinner).toBe('ct');
    expect(match.scoreCT).toBe(1);

    advance(match, ROUND_END_DELAY + 0.2);
    expect(match.phase).toBe('live');
    expect(match.round).toBe(2);
    expect(match.bots.filter((b) => b.team === 't' && b.alive)).toHaveLength(3);
    // 回合切换后上一回合的击杀信息不应污染新回合。
    expect(match.getHudState().killFeed).toHaveLength(0);
  });

  it('wins the match after five round wins', () => {
    const match = new Match();
    match.startMatch();
    for (let round = 0; round < ROUNDS_TO_WIN; round += 1) {
      killTeam(match, 't');
      match.update(1 / 60, input);
      expect(match.phase).toBe('roundOver');
      advance(match, ROUND_END_DELAY + 0.2);
    }
    expect(match.scoreCT).toBe(ROUNDS_TO_WIN);
    expect(match.phase).toBe('matchOver');
    expect(match.matchWinner).toBe('ct');
  });

  it('counts down the round timer', () => {
    const match = new Match();
    match.startMatch();
    advance(match, 0.5);
    expect(match.timeLeft).toBeCloseTo(74.5, 1);
  });
});

describe('Match 关卡注入', () => {
  it('defaults to the dust level and spawns actors from the level data', () => {
    const match = new Match();
    expect(match.level.id).toBe('dust');
    expect(match.player.position).toEqual(DUST_LEVEL.spawns.ct[0].pos);
    const ctBots = match.bots.filter((bot) => bot.team === 'ct');
    expect(ctBots[0].position).toEqual(DUST_LEVEL.spawns.ct[1].pos);
    expect(ctBots[1].position).toEqual(DUST_LEVEL.spawns.ct[2].pos);
    const tBots = match.bots.filter((bot) => bot.team === 't');
    tBots.forEach((bot, index) => {
      expect(bot.position).toEqual(DUST_LEVEL.spawns.t[index].pos);
    });
  });

  it('uses the injected level boxes for collision and its nav graph for bots', () => {
    const match = new Match(REDOUBT_LEVEL);
    expect(match.level.id).toBe('redoubt');
    expect(match.collider.boxes).toHaveLength(REDOUBT_LEVEL.boxes.length);
    expect(match.nav.nodes).toHaveLength(REDOUBT_LEVEL.navNodes.length);
    expect(match.player.position).toEqual(REDOUBT_LEVEL.spawns.ct[0].pos);
    match.startMatch();
    // 用第二关跑真实回合循环：Bot 寻路/交战代码不需要任何关卡分支就能工作。
    advance(match, 2);
    for (const bot of match.bots) {
      expect(Number.isFinite(bot.position.x)).toBe(true);
      expect(Number.isFinite(bot.position.z)).toBe(true);
      expect(bot.position.y).toBeGreaterThan(-1);
    }
  });

  it('runs a longer round loop on the injected level without breaking nav or vitals', () => {
    const match = new Match(REDOUBT_LEVEL);
    match.startMatch();
    const starts = new Map(match.bots.map((bot) => [bot.id, { ...bot.position }]));
    advance(match, 12);
    for (const bot of match.bots) {
      expect(Number.isFinite(bot.position.x)).toBe(true);
      expect(Number.isFinite(bot.position.z)).toBe(true);
      expect(Number.isFinite(bot.health)).toBe(true);
      expect(Number.isFinite(bot.armor)).toBe(true);
      expect(bot.health).toBeGreaterThanOrEqual(0);
      expect(bot.health).toBeLessThanOrEqual(100);
    }
    // 至少有一名 Bot 离开出生点，说明注入的导航图真的在驱动寻路。
    const moved = match.bots.filter((bot) => {
      const start = starts.get(bot.id)!;
      return Math.hypot(bot.position.x - start.x, bot.position.z - start.z) > 1.5;
    });
    expect(moved.length).toBeGreaterThan(0);
  });

  it('can switch level mid match and restarts on the new level', () => {
    const match = new Match();
    match.startMatch();
    killTeam(match, 't');
    match.update(1 / 60, input);
    expect(match.phase).toBe('roundOver');
    expect(match.scoreCT).toBe(1);

    match.setLevel(REDOUBT_LEVEL);

    expect(match.level.id).toBe('redoubt');
    expect(match.phase).toBe('live');
    expect(match.round).toBe(1);
    expect(match.scoreCT).toBe(0);
    expect(match.collider.boxes).toHaveLength(REDOUBT_LEVEL.boxes.length);
    expect(match.player.position).toEqual(REDOUBT_LEVEL.spawns.ct[0].pos);
    expect(match.bots.filter((bot) => bot.alive)).toHaveLength(5);
  });

  it('reuses spawn points when a team has fewer spawns than actors', () => {
    const singleSpawn = {
      ...REDOUBT_LEVEL,
      id: 'single-spawn',
      spawns: { ct: [REDOUBT_LEVEL.spawns.ct[0]], t: [REDOUBT_LEVEL.spawns.t[0]] },
    };
    const match = new Match(singleSpawn);
    match.startMatch();
    expect(match.player.position).toEqual(singleSpawn.spawns.ct[0].pos);
    for (const bot of match.bots.filter((item) => item.team === 'ct')) {
      expect(bot.position).toEqual(singleSpawn.spawns.ct[0].pos);
    }
    for (const bot of match.bots.filter((item) => item.team === 't')) {
      expect(bot.position).toEqual(singleSpawn.spawns.t[0].pos);
    }
  });
});

describe('Match 击杀信息', () => {
  it('shows the pistol short name when the player kills with a pistol', () => {
    const match = new Match();
    match.startMatch();
    match.player.switchWeapon('pistol');
    const victim = match.bots.find((bot) => bot.team === 't' && bot.alive);
    expect(victim).toBeDefined();

    match.damageActor(victim!.id, 500, true, match.player.id);

    const feed = match.getHudState().killFeed;
    expect(feed).toHaveLength(1);
    expect(feed[0].text).toContain('[P-9]');
    expect(feed[0].text).not.toContain('AK-12');
    expect(feed[0].text).toContain('✪');
  });

  it('shows the rifle short name for a bot kill', () => {
    const match = new Match();
    match.startMatch();
    const killer = match.bots.find((bot) => bot.team === 't' && bot.alive)!;

    match.damageActor(match.player.id, 500, false, killer.id);

    const feed = match.getHudState().killFeed;
    expect(feed[0].text).toBe(`${killer.name}  [AK-12]  你`);
    expect(match.player.alive).toBe(false);
    expect(match.player.deaths).toBe(1);
    expect(killer.kills).toBe(1);
  });

  it('centralizes kill attribution and hit feedback', () => {
    const match = new Match();
    match.startMatch();
    const victim = match.bots.find((bot) => bot.team === 't' && bot.alive)!;

    match.damageActor(victim.id, 10, false, match.player.id);
    expect(match.combat.hitMarker).toBe(1);
    expect(victim.alive).toBe(true);

    match.damageActor(victim.id, 500, false, match.player.id);
    expect(victim.alive).toBe(false);
    expect(victim.deaths).toBe(1);
    expect(match.player.kills).toBe(1);
    expect(match.getHudState().scoreboard.find((row) => row.isPlayer)?.kills).toBe(1);
  });
});
