import { describe, expect, it } from 'vitest';
import { vec3 } from '../core/math';
import type { ShotTarget } from '../game/types';
import { applyRawDamage, armorAbsorb, resolveShot, spreadDirection } from './combat';
import {
  WEAPONS,
  consumeShot,
  createWeapon,
  currentSpread,
  startReload,
  updateWeapon,
} from './weapons';

const target: ShotTarget = {
  id: 't1',
  team: 't',
  alive: true,
  head: { min: vec3(-0.22, 1.5, -6), max: vec3(0.22, 1.9, -5) },
  body: { min: vec3(-0.38, 0, -6), max: vec3(0.38, 1.42, -5) },
};

describe('resolveShot', () => {
  it('detects a headshot', () => {
    const shot = resolveShot(vec3(0, 1.65, 0), vec3(0, 0, -1), 50, 'player', [target], () => null);
    expect(shot.targetId).toBe('t1');
    expect(shot.headshot).toBe(true);
    expect(shot.hitWorld).toBe(false);
  });

  it('detects a body hit', () => {
    const shot = resolveShot(vec3(0, 1, 0), vec3(0, 0, -1), 50, 'player', [target], () => null);
    expect(shot.targetId).toBe('t1');
    expect(shot.headshot).toBe(false);
  });

  it('lets the world block the shot', () => {
    const shot = resolveShot(vec3(0, 1.65, 0), vec3(0, 0, -1), 50, 'player', [target], () => 3);
    expect(shot.targetId).toBeNull();
    expect(shot.hitWorld).toBe(true);
    expect(shot.distance).toBe(3);
  });

  it('never hits the shooter itself', () => {
    const shot = resolveShot(vec3(0, 1.65, 0), vec3(0, 0, -1), 50, 't1', [target], () => null);
    expect(shot.targetId).toBeNull();
  });
});

describe('weapons', () => {
  it('fires a full magazine, then needs a reload', () => {
    const weapon = createWeapon('rifle');
    for (let i = 0; i < 30; i += 1) {
      expect(consumeShot(weapon)).toBe(true);
      updateWeapon(weapon, 0.11);
    }
    expect(weapon.mag).toBe(0);
    expect(consumeShot(weapon)).toBe(false);
    expect(startReload(weapon)).toBe(true);
    updateWeapon(weapon, 2.5);
    expect(weapon.reloading).toBe(false);
    expect(weapon.mag).toBe(30);
    expect(weapon.reserve).toBe(60);
  });

  it('spreads more while moving and in the air', () => {
    const weapon = createWeapon('rifle');
    const still = currentSpread(weapon, 0, false, false);
    const moving = currentSpread(weapon, 1, false, false);
    const airborne = currentSpread(weapon, 0, false, true);
    expect(moving).toBeGreaterThan(still);
    expect(airborne).toBeGreaterThan(still);
  });

  it('keeps random spread inside the cone', () => {
    const dir = spreadDirection(vec3(0, 0, -1), 0.05);
    expect(dir.z).toBeLessThan(-0.99);
    expect(Math.hypot(dir.x, dir.y)).toBeLessThan(0.06);
  });
});

describe('armorAbsorb', () => {
  it('absorbs at most 45 percent', () => {
    const result = armorAbsorb(50, 100);
    expect(result.health).toBeCloseTo(27.5, 3);
    expect(result.armorLoss).toBeCloseTo(22.5, 3);
    expect(armorAbsorb(50, 0).health).toBe(50);
  });
});

describe('applyRawDamage', () => {
  it('is the single damage settlement used by player, bots and the combat director', () => {
    const target = { health: 100, armor: 50 };
    const result = applyRawDamage(target, 100);
    expect(result.healthLoss).toBeCloseTo(55, 5);
    expect(result.armorLoss).toBeCloseTo(45, 5);
    expect(target.health).toBeCloseTo(45, 5);
    expect(target.armor).toBeCloseTo(5, 5);
  });

  it('clamps health at zero and reports the final value', () => {
    const target = { health: 20, armor: 0 };
    const result = applyRawDamage(target, 500);
    expect(target.health).toBe(0);
    expect(result.remainingHealth).toBe(0);
    expect(result.healthLoss).toBe(20);
  });

  it('ignores non-positive damage', () => {
    const target = { health: 80, armor: 10 };
    expect(applyRawDamage(target, 0).healthLoss).toBe(0);
    expect(target.health).toBe(80);
    expect(target.armor).toBe(10);
  });
});

describe('weapon specs', () => {
  it('carries a short name for the kill feed', () => {
    expect(WEAPONS.rifle.shortName).toBe('AK-12');
    expect(WEAPONS.pistol.shortName).toBe('P-9');
  });
});
