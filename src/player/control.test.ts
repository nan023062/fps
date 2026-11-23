import { describe, expect, it } from 'vitest';
import { vec3, type Aabb } from '../core/math';
import type { InputSnapshot } from '../core/input';
import { WorldCollider } from '../world/collision';
import { PlayerControlSystem } from './control';
import { createControlIntent, intentFromInput } from './intent';
import { MOTOR_DEFAULTS } from './motor';
import { PlayerController } from './player';

const floor: Aabb = { min: vec3(-30, -1, -30), max: vec3(30, 0, 30) };

function intent(moveX = 0, moveZ = 0) {
  return { ...createControlIntent(), move: { x: moveX, z: moveZ } };
}

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

describe('PlayerControlSystem 手感参数', () => {
  it('exposes the pre-split player numbers by default', () => {
    const control = new PlayerControlSystem(vec3(), 0);
    const config = control.motorConfig;
    expect(config).toEqual(MOTOR_DEFAULTS);
    expect(config.runSpeed).toBe(6);
    expect(config.jumpSpeed).toBe(5.4);
    expect(config.gravity).toBe(18);
    expect(config.crouchSpeed).toBe(2.6);
    expect(config.walkSpeed).toBe(3.4);
  });

  it('allows runtime tuning without mutating the shared defaults', () => {
    const control = new PlayerControlSystem(vec3(), 0);
    control.setMotorConfig({ runSpeed: 9 });
    expect(control.motorConfig.runSpeed).toBe(9);
    expect(MOTOR_DEFAULTS.runSpeed).toBe(6);
    expect(new PlayerControlSystem(vec3(), 0).motorConfig.runSpeed).toBe(6);
  });
});

describe('PlayerControlSystem：意图 + dt + 世界碰撞 → CharacterState', () => {
  it('turns a forward intent into -Z displacement and reports it', () => {
    const world = new WorldCollider([floor]);
    const control = new PlayerControlSystem(vec3(0, 0, 0), 0);
    let lastStep = control.applyIntent(intent(0, 1), 1 / 60, world);
    for (let i = 0; i < 29; i += 1) {
      lastStep = control.applyIntent(intent(0, 1), 1 / 60, world);
    }
    expect(control.state.position.z).toBeLessThan(-1);
    expect(lastStep.skipped).toBe(false);
    expect(lastStep.grounded).toBe(true);
    expect(lastStep.displacement.z).toBeLessThan(0);
    expect(control.speedRatio()).toBeGreaterThan(0.5);
  });

  it('maps keyboard input to movement (WASD → intent → displacement)', () => {
    const world = new WorldCollider([floor]);
    const control = new PlayerControlSystem(vec3(0, 0, 0), 0);
    for (let i = 0; i < 30; i += 1) {
      control.applyIntent(intentFromInput(input({ forward: true, right: true })), 1 / 60, world);
    }
    expect(control.state.position.z).toBeLessThan(-0.5);
    expect(control.state.position.x).toBeGreaterThan(0.5);
  });

  it('applies look deltas and clamps pitch', () => {
    const world = new WorldCollider([floor]);
    const control = new PlayerControlSystem(vec3(), 0);
    control.applyIntent({ ...intent(), look: { yaw: 0.25, pitch: 0.1 } }, 1 / 60, world);
    expect(control.state.yaw).toBeCloseTo(0.25, 9);
    expect(control.state.pitch).toBeCloseTo(0.1, 9);
    control.look(0, 99);
    expect(control.state.pitch).toBeLessThan(1.5);
    control.addRecoil(-99);
    expect(control.state.pitch).toBeGreaterThan(-1.5);
  });

  it('crouches, moves slower and reports the crouched eye height', () => {
    const world = new WorldCollider([floor]);
    const runner = new PlayerControlSystem(vec3(), 0);
    const croucher = new PlayerControlSystem(vec3(), 0);
    for (let i = 0; i < 60; i += 1) {
      runner.applyIntent(intent(0, 1), 1 / 60, world);
      croucher.applyIntent({ ...intent(0, 1), crouch: true }, 1 / 60, world);
    }
    expect(croucher.state.crouchAmount).toBe(1);
    expect(croucher.state.eyeHeight).toBeCloseTo(1.1, 6);
    expect(croucher.state.height).toBeCloseTo(1.2, 6);
    expect(Math.abs(croucher.state.position.z)).toBeLessThan(Math.abs(runner.state.position.z));
  });

  it('jumps and lands through the motor, exposing grounded/airborne transitions', () => {
    const world = new WorldCollider([floor]);
    const control = new PlayerControlSystem(vec3(), 0);
    const jump = control.applyIntent({ ...intent(), jump: true }, 1 / 60, world);
    expect(jump.jumped).toBe(true);
    expect(control.state.grounded).toBe(false);
    expect(control.state.velocity.y).toBeGreaterThan(0);

    let landed = false;
    for (let i = 0; i < 120; i += 1) {
      const step = control.applyIntent(intent(), 1 / 60, world);
      landed = landed || step.landed;
    }
    expect(landed).toBe(true);
    expect(control.state.grounded).toBe(true);
    expect(control.state.position.y).toBeCloseTo(0, 3);
  });

  it('ignores intent while dead and recovers on respawn', () => {
    const world = new WorldCollider([floor]);
    const control = new PlayerControlSystem(vec3(2, 0, 2), 0.5);
    control.die();
    expect(control.state.dead).toBe(true);
    const step = control.applyIntent(intent(0, 1), 1 / 60, world);
    expect(step.skipped).toBe(true);
    expect(control.state.position).toEqual({ x: 2, y: 0, z: 2 });

    control.respawn(vec3(-4, 0, 3), 0.25);
    expect(control.state.dead).toBe(false);
    expect(control.state.position).toEqual({ x: -4, y: 0, z: 3 });
    expect(control.state.yaw).toBe(0.25);
    control.applyIntent(intent(0, 1), 1 / 60, world);
    expect(control.state.position.z).toBeLessThan(3);
  });

  it('mirrors weapon reload state without owning weapon rules', () => {
    const control = new PlayerControlSystem(vec3(), 0);
    control.setWeaponState('pistol', true);
    expect(control.state.weaponId).toBe('pistol');
    expect(control.state.reloading).toBe(true);
    control.die();
    control.setWeaponState('pistol', true);
    expect(control.state.reloading).toBe(false);
  });
});

describe('PlayerController 兼容层', () => {
  it('delegates legacy members to the control state', () => {
    const player = new PlayerController(vec3(0, 0, 6), 0);
    expect(player.controlState).toBe(player.control.state);
    expect(player.state).toBe(player.controlState);
    expect(player.height).toBe(1.8);
    expect(player.eyeHeight).toBeCloseTo(1.62, 9);
    expect(player.eyePosition()).toEqual({ x: 0, y: 1.62, z: 6 });

    player.position = vec3(1, 0, 1);
    expect(player.controlState.position).toEqual({ x: 1, y: 0, z: 1 });

    player.yaw = 0.4;
    player.pitch = 9;
    expect(player.controlState.yaw).toBeCloseTo(0.4, 9);
    expect(player.pitch).toBeLessThan(1.5);
  });

  it('update(dt, input, world) and applyIntent(intentFromInput(input)) match', () => {
    const worldA = new WorldCollider([floor]);
    const worldB = new WorldCollider([floor]);
    const legacy = new PlayerController(vec3(0, 0, 8), 0);
    const modern = new PlayerController(vec3(0, 0, 8), 0);
    const snapshot = input({ forward: true, right: true, crouch: true, mouseDX: 20, mouseDY: -5 });
    for (let i = 0; i < 40; i += 1) {
      legacy.update(1 / 60, snapshot, worldA);
      modern.applyIntent(intentFromInput(snapshot), 1 / 60, worldB);
    }
    expect(modern.position.z).toBeCloseTo(legacy.position.z, 9);
    expect(modern.position.x).toBeCloseTo(legacy.position.x, 9);
    expect(modern.yaw).toBeCloseTo(legacy.yaw, 9);
    expect(modern.pitch).toBeCloseTo(legacy.pitch, 9);
    expect(modern.crouchAmount).toBeCloseTo(legacy.crouchAmount, 9);
  });

  it('keeps the legacy look()/addRecoil()/switchWeapon() behaviour', () => {
    const player = new PlayerController(vec3(), 0);
    player.look(10, 0);
    expect(player.yaw).toBeCloseTo(-10 * 0.0022, 9);
    player.addRecoil(0.05);
    expect(player.pitch).toBeCloseTo(0.05, 9);
    expect(player.switchWeapon('pistol')).toBe(true);
    expect(player.weaponId).toBe('pistol');
    expect(player.controlState.weaponId).toBe('pistol');
    expect(player.switchWeapon('pistol')).toBe(false);
  });

  it('syncs death from the combat layer into the control state', () => {
    const player = new PlayerController(vec3(1, 0, 1), 0);
    player.velocity = vec3(3, 0, 0);
    expect(player.applyDamage(1000)).toBe(true);
    expect(player.alive).toBe(false);
    expect(player.controlState.dead).toBe(true);
    expect(player.controlState.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(player.deaths).toBe(1);

    player.alive = false;
    player.reset(vec3(0, 0, 0), 0);
    expect(player.alive).toBe(true);
    expect(player.controlState.position).toEqual({ x: 0, y: 0, z: 0 });
    expect(player.health).toBe(100);
    expect(player.weapons.rifle.mag).toBe(30);
  });
});
