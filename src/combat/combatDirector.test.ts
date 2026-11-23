import { describe, expect, it } from 'vitest';
import type { Team, WeaponId } from '../game/types';
import {
  CombatDirector,
  KILL_FEED_TTL,
  MAX_KILL_FEED,
  weaponShortName,
  type CombatActor,
} from './combatDirector';

let serial = 0;

function actor(overrides: Partial<CombatActor> & { team?: Team } = {}): CombatActor {
  serial += 1;
  return {
    id: overrides.id ?? `actor-${serial}`,
    name: overrides.name ?? `Actor${serial}`,
    team: overrides.team ?? 't',
    alive: true,
    health: 100,
    armor: 50,
    kills: 0,
    deaths: 0,
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    weaponId: (overrides.weaponId ?? 'rifle') as WeaponId,
    isPlayer: overrides.isPlayer ?? false,
    ...overrides,
  };
}

describe('CombatDirector 伤害与护甲', () => {
  it('absorbs damage with armor and reports the settlement', () => {
    const victim = actor({ armor: 50, health: 100 });
    const attacker = actor({ team: 'ct' });
    const director = new CombatDirector([attacker, victim]);

    const outcome = director.applyDamage({
      victimId: victim.id,
      attackerId: attacker.id,
      rawDamage: 100,
      headshot: false,
    });

    expect(outcome.applied).toBe(true);
    // 护甲最多吸收 45%，50 点护甲吸收 45 点，剩余 55 点由生命承担。
    expect(outcome.armorLoss).toBeCloseTo(45, 5);
    expect(outcome.healthLoss).toBeCloseTo(55, 5);
    expect(victim.armor).toBeCloseTo(5, 5);
    expect(victim.health).toBeCloseTo(45, 5);
    expect(victim.alive).toBe(true);
    expect(outcome.victimDied).toBe(false);
    expect(outcome.events.map((event) => event.kind)).toEqual(['hit']);
  });

  it('ignores damage against a dead or unknown victim', () => {
    const victim = actor();
    const attacker = actor({ team: 'ct' });
    const director = new CombatDirector([attacker, victim]);
    victim.alive = false;

    const dead = director.applyDamage({
      victimId: victim.id,
      attackerId: attacker.id,
      rawDamage: 10,
      headshot: false,
    });
    const unknown = director.applyDamage({
      victimId: 'nobody',
      attackerId: attacker.id,
      rawDamage: 10,
      headshot: false,
    });

    expect(dead.applied).toBe(false);
    expect(unknown.applied).toBe(false);
    expect(attacker.kills).toBe(0);
  });
});

describe('CombatDirector 击杀归属与击杀信息', () => {
  it('attributes the kill to the attacker and death to the victim', () => {
    const victim = actor({ name: 'Viper' });
    const killer = actor({ team: 'ct', name: 'Rook' });
    const director = new CombatDirector([killer, victim]);

    const outcome = director.applyDamage({
      victimId: victim.id,
      attackerId: killer.id,
      rawDamage: 500,
      headshot: true,
    });

    expect(outcome.victimDied).toBe(true);
    expect(victim.alive).toBe(false);
    expect(victim.deaths).toBe(1);
    expect(killer.kills).toBe(1);
    expect(outcome.events.map((event) => event.kind)).toEqual(['hit', 'kill']);
    const kill = outcome.events.find((event) => event.kind === 'kill');
    expect(kill && kill.kind === 'kill' ? kill.text : '').toBe('Rook  [AK-12]  ✪ Viper');
  });

  it('uses the killer’s actual weapon short name in the kill feed', () => {
    const victim = actor({ name: 'Ash' });
    const player = actor({ id: 'player', name: '你', team: 'ct', weaponId: 'pistol', isPlayer: true });
    const director = new CombatDirector([player, victim]);

    const outcome = director.applyDamage({
      victimId: victim.id,
      attackerId: player.id,
      rawDamage: 500,
      headshot: false,
    });

    expect(outcome.weaponShortName).toBe('P-9');
    expect(outcome.killFeedText).toBe('你  [P-9]  Ash');
    expect(outcome.killFeedText).not.toContain('AK-12');
    expect(director.killFeed()[0].text).toBe('你  [P-9]  Ash');
  });

  it('prefers the weapon supplied by the shot over the held weapon', () => {
    const victim = actor();
    const killer = actor({ team: 'ct', weaponId: 'pistol' });
    const director = new CombatDirector([killer, victim]);

    const outcome = director.applyDamage({
      victimId: victim.id,
      attackerId: killer.id,
      rawDamage: 500,
      headshot: false,
      weaponId: 'rifle',
    });

    expect(outcome.killFeedText).toContain('[AK-12]');
    expect(weaponShortName('pistol')).toBe('P-9');
  });

  it('does not double count kills when damage repeats after death', () => {
    const victim = actor();
    const killer = actor({ team: 'ct' });
    const director = new CombatDirector([killer, victim]);
    director.applyDamage({ victimId: victim.id, attackerId: killer.id, rawDamage: 500, headshot: false });
    director.applyDamage({ victimId: victim.id, attackerId: killer.id, rawDamage: 500, headshot: false });

    expect(killer.kills).toBe(1);
    expect(victim.deaths).toBe(1);
    expect(director.killFeed()).toHaveLength(1);
  });

  it('keeps only the newest kill feed entries', () => {
    const killer = actor({ team: 'ct' });
    const victims = Array.from({ length: MAX_KILL_FEED + 2 }, () => actor());
    const director = new CombatDirector([killer, ...victims]);
    for (const victim of victims) {
      director.applyDamage({ victimId: victim.id, attackerId: killer.id, rawDamage: 500, headshot: false });
    }
    expect(director.killFeed()).toHaveLength(MAX_KILL_FEED);
    expect(killer.kills).toBe(MAX_KILL_FEED + 2);
  });

  it('expires kill feed entries by elapsed time, not frames', () => {
    const victim = actor();
    const killer = actor({ team: 'ct' });
    const director = new CombatDirector([killer, victim]);
    director.applyDamage({ victimId: victim.id, attackerId: killer.id, rawDamage: 500, headshot: false });

    director.tick(KILL_FEED_TTL - 0.1);
    expect(director.killFeed()).toHaveLength(1);
    director.tick(0.2);
    expect(director.killFeed()).toHaveLength(0);
  });
});

describe('CombatDirector 命中反馈', () => {
  it('raises the hit marker when the player lands a hit', () => {
    const victim = actor();
    const player = actor({ id: 'player', name: '你', team: 'ct', isPlayer: true });
    const director = new CombatDirector([player, victim]);

    director.applyDamage({ victimId: victim.id, attackerId: player.id, rawDamage: 10, headshot: false });
    expect(director.hitMarker).toBe(1);

    director.tick(0.1);
    expect(director.hitMarker).toBeCloseTo(0.6, 5);
    director.tick(1);
    expect(director.hitMarker).toBe(0);
  });

  it('flashes and angles the screen when the player is hit', () => {
    const player = actor({ id: 'player', name: '你', team: 'ct', isPlayer: true });
    const attacker = actor({ team: 't', position: { x: 5, y: 0, z: 0 } });
    const director = new CombatDirector([player, attacker]);

    director.applyDamage({ victimId: player.id, attackerId: attacker.id, rawDamage: 10, headshot: false });

    expect(director.damageFlash).toBe(1);
    expect(director.hitMarker).toBe(0);
    expect(director.damageAngle).toBeCloseTo(Math.PI / 2, 5);

    director.tick(0.5);
    expect(director.damageFlash).toBeCloseTo(0.2, 5);
  });

  it('resets transient feedback and the kill feed between rounds', () => {
    const victim = actor();
    const player = actor({ id: 'player', name: '你', team: 'ct', isPlayer: true });
    const director = new CombatDirector([player, victim]);
    director.applyDamage({ victimId: victim.id, attackerId: player.id, rawDamage: 500, headshot: false });

    director.reset();

    expect(director.killFeed()).toHaveLength(0);
    expect(director.hitMarker).toBe(0);
    expect(director.damageFlash).toBe(0);
    expect(director.damageAngle).toBe(0);
  });
});
