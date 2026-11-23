import { describe, expect, it } from 'vitest';
import { vec3 } from '../core/math';
import {
  CROUCH_EYE_DROP,
  CROUCH_HEIGHT,
  PITCH_LIMIT,
  STAND_EYE_HEIGHT,
  STAND_HEIGHT,
  applyLookDelta,
  createCharacterState,
  eyeHeightForCrouch,
  eyePosition,
  heightForCrouch,
  horizontalSpeed,
  isAirborne,
  killCharacter,
  landCharacter,
  launchCharacter,
  respawnCharacter,
  setCrouch,
  speedRatio,
  updateCrouch,
} from './state';

describe('CharacterState 初值', () => {
  it('starts grounded, standing and alive at the spawn point', () => {
    const state = createCharacterState(vec3(1, 2, 3), 0.5);
    expect(state.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.yaw).toBe(0.5);
    expect(state.pitch).toBe(0);
    expect(state.grounded).toBe(true);
    expect(isAirborne(state)).toBe(false);
    expect(state.dead).toBe(false);
    expect(state.reloading).toBe(false);
    expect(state.weaponId).toBe('rifle');
    expect(state.height).toBe(STAND_HEIGHT);
    expect(state.eyeHeight).toBe(STAND_EYE_HEIGHT);
  });

  it('keeps the original stance numbers (stand 1.8/1.62, crouch 1.2/1.10)', () => {
    expect(heightForCrouch(0)).toBe(1.8);
    expect(heightForCrouch(1)).toBe(1.2);
    expect(heightForCrouch(0.5)).toBeCloseTo(1.5, 9);
    expect(eyeHeightForCrouch(0)).toBe(1.62);
    expect(eyeHeightForCrouch(1)).toBeCloseTo(1.62 - CROUCH_EYE_DROP, 9);
    expect(eyeHeightForCrouch(1)).toBeCloseTo(1.1, 9);
    // 越界蹲伏量被夹取，不会出现负高度或穿地视点。
    expect(heightForCrouch(-3)).toBe(STAND_HEIGHT);
    expect(heightForCrouch(4)).toBe(CROUCH_HEIGHT);
  });
});

describe('蹲下 / 站起转换', () => {
  it('crouches smoothly and drops the eye height with the collider', () => {
    const state = createCharacterState(vec3(), 0);
    updateCrouch(state, 1 / 60, true);
    expect(state.crouchAmount).toBeGreaterThan(0);
    expect(state.crouchAmount).toBeLessThan(1);
    expect(state.height).toBeLessThan(STAND_HEIGHT);
    expect(state.eyeHeight).toBeLessThan(STAND_EYE_HEIGHT);

    updateCrouch(state, 0.2, true);
    expect(state.crouchAmount).toBe(1);
    expect(state.crouchHeld).toBe(true);
    expect(state.height).toBeCloseTo(CROUCH_HEIGHT, 9);
    expect(state.eyeHeight).toBeCloseTo(1.1, 9);
    expect(eyePosition(state).y).toBeCloseTo(1.1, 9);
  });

  it('stands back up when the key is released', () => {
    const state = createCharacterState(vec3(), 0);
    setCrouch(state, 1);
    updateCrouch(state, 0.2, false);
    expect(state.crouchAmount).toBe(0);
    expect(state.height).toBeCloseTo(STAND_HEIGHT, 9);
    expect(state.eyeHeight).toBeCloseTo(STAND_EYE_HEIGHT, 9);
    expect(state.crouchHeld).toBe(false);
  });
});

describe('落地 / 起跳转换', () => {
  it('launch clears grounded and land restores it while killing downward speed', () => {
    const state = createCharacterState(vec3(), 0);
    launchCharacter(state, 5.4);
    expect(state.grounded).toBe(false);
    expect(isAirborne(state)).toBe(true);
    expect(state.velocity.y).toBe(5.4);

    state.velocity.y = -7;
    landCharacter(state);
    expect(state.grounded).toBe(true);
    expect(state.velocity.y).toBe(0);
  });

  it('keeps horizontal momentum when landing', () => {
    const state = createCharacterState(vec3(), 0);
    state.velocity = { x: 3, y: -2, z: 0 };
    landCharacter(state);
    expect(state.velocity.x).toBe(3);
    expect(state.velocity.y).toBe(0);
  });
});

describe('死亡 / 重生转换', () => {
  it('kills, freezes movement and clears reload/crouch hold', () => {
    const state = createCharacterState(vec3(2, 0, 2), 1);
    state.velocity = { x: 4, y: -1, z: 0 };
    state.reloading = true;
    state.crouchHeld = true;
    killCharacter(state);
    expect(state.dead).toBe(true);
    expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.reloading).toBe(false);
    expect(state.crouchHeld).toBe(false);
    // 倒地位置保留，观战回退点要用。
    expect(state.position).toEqual({ x: 2, y: 0, z: 2 });
  });

  it('respawns at the spawn point with a full standing state', () => {
    const state = createCharacterState(vec3(), 0);
    setCrouch(state, 1);
    launchCharacter(state, 3);
    killCharacter(state);
    respawnCharacter(state, vec3(5, 0, -5), 0.75, 'pistol');
    expect(state.dead).toBe(false);
    expect(state.position).toEqual({ x: 5, y: 0, z: -5 });
    expect(state.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(state.yaw).toBe(0.75);
    expect(state.pitch).toBe(0);
    expect(state.crouchAmount).toBe(0);
    expect(state.height).toBe(STAND_HEIGHT);
    expect(state.grounded).toBe(true);
    expect(state.weaponId).toBe('pistol');
  });
});

describe('视角与派生量', () => {
  it('adds look deltas and clamps pitch to ±1.45', () => {
    const state = createCharacterState(vec3(), 0);
    applyLookDelta(state, 0.3, 0.2);
    expect(state.yaw).toBeCloseTo(0.3, 9);
    expect(state.pitch).toBeCloseTo(0.2, 9);
    applyLookDelta(state, 0, 99);
    expect(state.pitch).toBe(PITCH_LIMIT);
    applyLookDelta(state, 0, -99);
    expect(state.pitch).toBe(-PITCH_LIMIT);
  });

  it('derives speed ratio and horizontal speed from velocity', () => {
    const state = createCharacterState(vec3(), 0);
    state.velocity = { x: 3, y: 9, z: 4 };
    expect(horizontalSpeed(state)).toBeCloseTo(5, 9);
    expect(speedRatio(state, 6)).toBeCloseTo(5 / 6, 9);
    expect(speedRatio(state, 4)).toBe(1);
    expect(speedRatio(state, 0)).toBe(0);
  });
});
