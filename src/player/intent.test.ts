import { describe, expect, it } from 'vitest';
import type { InputSnapshot } from '../core/input';
import {
  LOOK_SENSITIVITY,
  createControlIntent,
  intentFromInput,
  lookDeltaFromMouse,
  mergeControlIntent,
  normalizeMoveAxis,
  withoutOneShot,
} from './intent';

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

describe('ControlIntent 零值', () => {
  it('starts from a fully neutral intent', () => {
    expect(createControlIntent()).toEqual({
      move: { x: 0, z: 0 },
      look: { yaw: 0, pitch: 0 },
      jump: false,
      crouch: false,
      walk: false,
      fire: false,
      reload: false,
      switchWeapon: null,
    });
  });
});

describe('意图映射：按键 → ControlIntent', () => {
  it('maps W/A/S/D into the local x/z axes', () => {
    expect(intentFromInput(input({ forward: true })).move).toEqual({ x: 0, z: 1 });
    expect(intentFromInput(input({ back: true })).move).toEqual({ x: 0, z: -1 });
    expect(intentFromInput(input({ right: true })).move).toEqual({ x: 1, z: 0 });
    expect(intentFromInput(input({ left: true })).move).toEqual({ x: -1, z: 0 });
  });

  it('normalizes diagonals so pressing two keys is not faster than one', () => {
    const diagonal = intentFromInput(input({ forward: true, right: true })).move;
    expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1, 6);
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(diagonal.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('cancels opposite keys instead of drifting', () => {
    expect(intentFromInput(input({ forward: true, back: true })).move).toEqual({ x: 0, z: 0 });
    expect(intentFromInput(input({ left: true, right: true })).move).toEqual({ x: 0, z: 0 });
  });

  it('turns mouse pixels into radian look deltas (right drag turns right)', () => {
    const look = intentFromInput(input({ mouseDX: 10, mouseDY: 4 })).look;
    expect(look.yaw).toBeCloseTo(-10 * LOOK_SENSITIVITY, 9);
    expect(look.pitch).toBeCloseTo(-4 * LOOK_SENSITIVITY, 9);
    expect(lookDeltaFromMouse(0, 0).yaw).toBeCloseTo(0, 12);
    expect(lookDeltaFromMouse(0, 0).pitch).toBeCloseTo(0, 12);
  });

  it('passes action buttons through without touching input state', () => {
    const snapshot = input({
      jump: true,
      crouch: true,
      walk: true,
      fire: true,
      reloadRequest: true,
      switchRequest: 'pistol',
    });
    const intent = intentFromInput(snapshot);
    expect(intent.jump).toBe(true);
    expect(intent.crouch).toBe(true);
    expect(intent.walk).toBe(true);
    expect(intent.fire).toBe(true);
    expect(intent.reload).toBe(true);
    expect(intent.switchWeapon).toBe('pistol');
    // 纯映射：不消费/不修改输入快照里的增量。
    expect(snapshot.reloadRequest).toBe(true);
    expect(snapshot.switchRequest).toBe('pistol');
  });

  it('treats non-finite axis values as no input', () => {
    expect(normalizeMoveAxis(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ x: 0, z: 0 });
  });
});

describe('意图合并（固定步长循环）', () => {
  it('merges two frames by or-ing actions and summing look deltas', () => {
    const a = { ...createControlIntent(), move: { x: 1, z: 0 }, look: { yaw: 0.1, pitch: 0 } };
    const b = { ...createControlIntent(), move: { x: 0, z: 1 }, fire: true, look: { yaw: 0, pitch: 0.2 } };
    const merged = mergeControlIntent(a, b);
    expect(merged.move.x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(merged.move.z).toBeCloseTo(Math.SQRT1_2, 6);
    expect(merged.fire).toBe(true);
    expect(merged.look.yaw).toBeCloseTo(0.1, 9);
    expect(merged.look.pitch).toBeCloseTo(0.2, 9);
  });

  it('drops one-shot actions for follow-up fixed steps but keeps held keys', () => {
    const intent = {
      ...createControlIntent(),
      move: { x: 0, z: 1 },
      look: { yaw: 0.3, pitch: -0.2 },
      reload: true,
      switchWeapon: 'rifle' as const,
      fire: true,
      crouch: true,
    };
    const next = withoutOneShot(intent);
    expect(next.reload).toBe(false);
    expect(next.switchWeapon).toBeNull();
    expect(next.look).toEqual({ yaw: 0, pitch: 0 });
    expect(next.move).toBe(intent.move);
    expect(next.fire).toBe(true);
    expect(next.crouch).toBe(true);
  });
});
