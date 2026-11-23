import { describe, expect, it } from 'vitest';
import { vec3 } from '../core/math';
import type { InputSnapshot } from '../core/input';
import { WorldCollider } from '../world/collision';
import { PlayerController } from './player';

function input(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
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
    ...overrides,
  };
}

const floor = { min: vec3(-20, -1, -20), max: vec3(20, 0, 20) };

describe('PlayerController', () => {
  it('moves forward and stops before a wall', () => {
    const collider = new WorldCollider([floor, { min: vec3(-3, 0, -2), max: vec3(3, 3, -1) }]);
    const player = new PlayerController(vec3(0, 0, 4), 0);
    for (let i = 0; i < 120; i += 1) {
      player.update(1 / 60, input({ forward: true }), collider);
    }
    expect(player.position.z).toBeLessThan(4);
    expect(player.position.z).toBeGreaterThan(-1);
  });

  it('jumps and lands back on the floor', () => {
    const collider = new WorldCollider([floor]);
    const player = new PlayerController(vec3(0, 0, 0), 0);
    player.update(1 / 60, input({ jump: true }), collider);
    expect(player.position.y).toBeGreaterThan(0);
    for (let i = 0; i < 120; i += 1) {
      player.update(1 / 60, input(), collider);
    }
    expect(player.position.y).toBeCloseTo(0, 3);
    expect(player.grounded).toBe(true);
  });

  it('moves slower while crouching', () => {
    const collider = new WorldCollider([floor]);
    const runner = new PlayerController(vec3(0, 0, 0), 0);
    const croucher = new PlayerController(vec3(0, 0, 0), 0);
    for (let i = 0; i < 90; i += 1) {
      runner.update(1 / 60, input({ forward: true }), collider);
      croucher.update(1 / 60, input({ forward: true, crouch: true }), collider);
    }
    expect(Math.abs(croucher.position.z)).toBeLessThan(Math.abs(runner.position.z));
  });

  it('absorbs part of the damage with armor', () => {
    const player = new PlayerController(vec3(0, 0, 0));
    expect(player.applyDamage(50)).toBe(false);
    expect(player.health).toBeCloseTo(72.5, 1);
    expect(player.armor).toBeCloseTo(77.5, 1);
    expect(player.applyDamage(1000)).toBe(true);
    expect(player.alive).toBe(false);
  });
});
