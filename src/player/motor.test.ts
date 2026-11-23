import { describe, expect, it } from 'vitest';
import { vec3, type Aabb } from '../core/math';
import { WorldCollider } from '../world/collision';
import { createControlIntent } from './intent';
import {
  MOTOR_DEFAULTS,
  createBoxMotorWorld,
  stepCharacterMotor,
  type MotorIntent,
  type MotorWorld,
} from './motor';
import { createCharacterState, killCharacter, type CharacterState } from './state';

const floor: Aabb = { min: vec3(-25, -1, -25), max: vec3(25, 0, 25) };

function intent(overrides: Partial<MotorIntent> = {}): MotorIntent {
  return { move: { x: 0, z: 0 }, jump: false, crouch: false, walk: false, ...overrides };
}

function runMotor(
  state: CharacterState,
  motorIntent: MotorIntent,
  world: MotorWorld,
  frames: number,
  dt = 1 / 60,
): ReturnType<typeof stepCharacterMotor>[] {
  const steps: ReturnType<typeof stepCharacterMotor>[] = [];
  for (let i = 0; i < frames; i += 1) {
    steps.push(stepCharacterMotor(state, motorIntent, dt, world));
  }
  return steps;
}

describe('CharacterMotor 手感参数', () => {
  it('keeps the pre-split player numbers unchanged', () => {
    expect(MOTOR_DEFAULTS.runSpeed).toBe(6);
    expect(MOTOR_DEFAULTS.walkSpeed).toBe(3.4);
    expect(MOTOR_DEFAULTS.crouchSpeed).toBe(2.6);
    expect(MOTOR_DEFAULTS.gravity).toBe(18);
    expect(MOTOR_DEFAULTS.jumpSpeed).toBe(5.4);
    expect(MOTOR_DEFAULTS.radius).toBe(0.38);
  });

  it('accelerates forward along -Z at yaw 0 and stops with friction', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 0, 0), 0);
    runMotor(state, intent({ move: { x: 0, z: 1 } }), world, 60);
    expect(state.position.z).toBeLessThan(-3);
    expect(state.position.x).toBeCloseTo(0, 6);
    expect(state.velocity.z).toBeLessThan(0);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeCloseTo(6, 1);

    // 松开按键：地面摩擦把水平速度收回到 0（不滑行、不反向）。
    runMotor(state, intent(), world, 60);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeCloseTo(0, 6);
  });

  it('moves along the intent axes relative to yaw', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 0, 0), Math.PI / 2);
    runMotor(state, intent({ move: { x: 0, z: 1 } }), world, 30);
    // yaw = 90° 时前方是 -X。
    expect(state.position.x).toBeLessThan(-1);
    expect(Math.abs(state.position.z)).toBeLessThan(0.05);
  });
});

describe('CharacterMotor 重力 / 跳跃 / 落地', () => {
  it('falls onto the floor and reports the landing frame', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 3, 0), 0);
    state.grounded = false;
    const steps = runMotor(state, intent(), world, 120);
    expect(state.grounded).toBe(true);
    expect(state.position.y).toBeCloseTo(0, 3);
    expect(state.velocity.y).toBe(0);
    expect(steps.some((step) => step.landed)).toBe(true);
  });

  it('jumps with the original impulse and lands again', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 0, 0), 0);
    const first = stepCharacterMotor(state, intent({ jump: true }), 1 / 60, world);
    expect(first.jumped).toBe(true);
    expect(state.grounded).toBe(false);
    expect(state.velocity.y).toBeCloseTo(5.4 - 18 / 60, 6);
    expect(state.position.y).toBeGreaterThan(0);

    const steps = runMotor(state, intent(), world, 120);
    expect(state.grounded).toBe(true);
    expect(state.position.y).toBeCloseTo(0, 3);
    expect(steps.some((step) => step.landed)).toBe(true);
  });

  it('does not double jump in the air', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 0, 0), 0);
    stepCharacterMotor(state, intent({ jump: true }), 1 / 60, world);
    const vy = state.velocity.y;
    const second = stepCharacterMotor(state, intent({ jump: true }), 1 / 60, world);
    expect(second.jumped).toBe(false);
    expect(state.velocity.y).toBeLessThan(vy);
  });
});

describe('CharacterMotor 碰撞边界', () => {
  it('slides along a wall instead of sticking', () => {
    const wall: Aabb = { min: vec3(-1, 0, -20), max: vec3(1, 3, 20) };
    const world = createBoxMotorWorld([floor, wall]);
    const state = createCharacterState(vec3(4, 0, 0), 0);
    // 同时向左（撞墙）与向前（-Z）：x 被墙挡住，z 继续滑动。
    const steps = runMotor(state, intent({ move: { x: -1, z: 1 } }), world, 90);
    expect(state.position.x).toBeGreaterThan(1.37);
    expect(state.position.x).toBeLessThan(1.42);
    expect(state.position.z).toBeLessThan(-3);
    expect(steps.some((step) => step.blocked)).toBe(true);
  });

  it('blocks a tall box the character cannot step over', () => {
    const tallWall: Aabb = { min: vec3(-2, 0, -1), max: vec3(2, 1.6, 1) };
    const world = createBoxMotorWorld([floor, tallWall]);
    const state = createCharacterState(vec3(0, 0, 4), 0);
    const steps = runMotor(state, intent({ move: { x: 0, z: 1 } }), world, 120);
    expect(state.position.z).toBeGreaterThan(1.37);
    expect(state.position.y).toBeCloseTo(0, 6);
    expect(steps.some((step) => step.blocked)).toBe(true);
  });

  it('steps up a low box and keeps moving on top of it', () => {
    const step: Aabb = { min: vec3(-2, 0, -1), max: vec3(2, 0.3, 1) };
    const world = createBoxMotorWorld([floor, step]);
    const state = createCharacterState(vec3(0, 0, 4), 0);
    // 45 帧刚好走上台阶并停在上面；再往后会从盒体另一端走下去。
    runMotor(state, intent({ move: { x: 0, z: 1 } }), world, 45);
    expect(state.position.z).toBeLessThan(0);
    expect(state.position.y).toBeCloseTo(0.3, 3);
    expect(state.grounded).toBe(true);
  });

  it('uses the crouched collider height for collision queries', () => {
    const captured: Array<{ radius: number; height: number; stepHeight?: number }> = [];
    const world: MotorWorld = {
      move(position, radius, height, delta, stepHeight) {
        captured.push({ radius, height, stepHeight });
        return { position: { ...position, y: position.y + delta.y }, grounded: false };
      },
    };
    const state = createCharacterState(vec3(), 0);
    const steps = runMotor(state, intent({ crouch: true }), world, 12);
    const last = captured[captured.length - 1];
    expect(steps).toHaveLength(12);
    expect(captured[0].radius).toBe(0.38);
    expect(last.height).toBeCloseTo(1.2, 6);
    expect(last.stepHeight).toBe(0.45);
  });

  it('accepts a pre-built WorldCollider as the injected world', () => {
    const world = new WorldCollider([floor]);
    const state = createCharacterState(vec3(0, 2, 0), 0);
    state.grounded = false;
    runMotor(state, intent(), world, 120);
    expect(state.position.y).toBeCloseTo(0, 3);
    expect(state.grounded).toBe(true);
  });
});

describe('CharacterMotor 蹲伏与冻结', () => {
  it('moves slower while crouched', () => {
    const world = createBoxMotorWorld([floor]);
    const runner = createCharacterState(vec3(0, 0, 0), 0);
    const croucher = createCharacterState(vec3(0, 0, 0), 0);
    runMotor(runner, intent({ move: { x: 0, z: 1 } }), world, 90);
    runMotor(croucher, intent({ move: { x: 0, z: 1 }, crouch: true }), world, 90);
    expect(Math.abs(croucher.position.z)).toBeLessThan(Math.abs(runner.position.z));
    expect(croucher.height).toBeCloseTo(1.2, 6);
  });

  it('does nothing while dead or with a non-positive dt', () => {
    const world = createBoxMotorWorld([floor]);
    const dead = createCharacterState(vec3(0, 0, 0), 0);
    killCharacter(dead);
    const deadStep = stepCharacterMotor(dead, intent({ move: { x: 0, z: 1 } }), 1 / 60, world);
    expect(deadStep.displacement).toEqual({ x: 0, y: 0, z: 0 });
    expect(dead.position.z).toBe(0);

    const frozen = createCharacterState(vec3(0, 0, 0), 0);
    const frozenStep = stepCharacterMotor(frozen, intent({ move: { x: 0, z: 1 } }), 0, world);
    expect(frozenStep.displacement).toEqual({ x: 0, y: 0, z: 0 });
    expect(frozen.position.z).toBe(0);
    expect(createControlIntent().move).toEqual({ x: 0, z: 0 });
  });

  it('reports displacement that matches the moving bone position', () => {
    const world = createBoxMotorWorld([floor]);
    const state = createCharacterState(vec3(0, 0, 0), 0);
    const before = { ...state.position };
    const step = stepCharacterMotor(state, intent({ move: { x: 0, z: 1 } }), 1 / 60, world);
    expect(step.displacement.z).toBeCloseTo(state.position.z - before.z, 12);
    expect(step.grounded).toBe(true);
    expect(step.jumped).toBe(false);
  });
});
