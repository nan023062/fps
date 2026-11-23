import { describe, expect, it } from 'vitest';
import { vec3 } from '../core/math';
import { createRenderState } from '../character/state';
import { createCameraTarget, resolveSpectateTarget } from '../engine/camera';
import {
  DEATH_EYE_HEIGHT,
  applyActorRenderState,
  applyCameraTarget,
  applyCharacterRenderState,
  buildSpectateState,
  type ActorPoseSource,
  type CharacterControlState,
} from './threeC';
import {
  createCharacterState,
  horizontalSpeed,
  killCharacter,
  setCrouch,
  type CharacterState,
} from '../player/state';

function stateAt(x = 0, y = 0, z = 0): CharacterState {
  return createCharacterState(vec3(x, y, z), 0.6);
}

describe('3C 契约：CharacterState → CharacterRenderState', () => {
  it('writes position, heading, speed, aim, weapon and alive into the render state', () => {
    const state: CharacterControlState = stateAt(2, 0, -3);
    state.velocity = { x: 3, y: 0, z: 4 };
    state.pitch = -0.2;
    state.weaponId = 'pistol';
    const out = createRenderState('ct', 'rifle', 2);
    applyCharacterRenderState(out, state, { firing: true });
    expect(out.position).toEqual({ x: 2, y: 0, z: -3 });
    expect(out.yaw).toBeCloseTo(0.6, 9);
    expect(out.aimPitch).toBeCloseTo(-0.2, 9);
    expect(out.speed).toBeCloseTo(horizontalSpeed(state), 9);
    expect(out.speed).toBeCloseTo(5, 9);
    expect(out.alive).toBe(true);
    expect(out.weaponId).toBe('pistol');
    expect(out.reloading).toBe(false);
    expect(out.firing).toBe(true);
    // 队伍/体型是身份信息，映射不改写归属。
    expect(out.team).toBe('ct');
    expect(out.variant).toBe(2);
  });

  it('maps crouch into both crouch amount and render speed cap', () => {
    const state = stateAt();
    setCrouch(state, 1);
    const out = createRenderState();
    applyCharacterRenderState(out, state);
    expect(out.crouch).toBe(1);
    expect(out.speed).toBe(0);
    expect(state.eyeHeight).toBeCloseTo(1.1, 9);
  });

  it('marks death as alive=false and drops the reload flag', () => {
    const state = stateAt(1, 0, 1);
    state.reloading = true;
    killCharacter(state);
    const out = createRenderState();
    applyCharacterRenderState(out, state, { firing: false });
    expect(out.alive).toBe(false);
    expect(out.reloading).toBe(false);
    expect(out.position).toEqual({ x: 1, y: 0, z: 1 });
  });

  it('lets the presentation layer override the measured speed', () => {
    const state = stateAt();
    state.velocity = { x: 0, y: 0, z: 0 };
    const out = createRenderState();
    applyCharacterRenderState(out, state, { speed: 4.2 });
    expect(out.speed).toBeCloseTo(4.2, 9);
    applyCharacterRenderState(out, state, { speed: 999 });
    expect(out.speed).toBe(24);
  });
});

describe('3C 契约：任意姿态来源（Bot）→ CharacterRenderState', () => {
  it('maps a bot-like source without needing a control state', () => {
    const bot: ActorPoseSource = {
      position: { x: -4, y: 0, z: 5 },
      yaw: -1.2,
      pitch: 0.1,
      alive: true,
      team: 't',
      weapon: { id: 'rifle', reloading: true },
    };
    const out = createRenderState('t', 'rifle', 1);
    applyActorRenderState(out, bot, { speed: 3.5, crouch: 0.5, firing: true });
    expect(out.position).toEqual({ x: -4, y: 0, z: 5 });
    expect(out.yaw).toBeCloseTo(-1.2, 9);
    expect(out.aimPitch).toBeCloseTo(0.1, 9);
    expect(out.team).toBe('t');
    expect(out.speed).toBeCloseTo(3.5, 9);
    expect(out.crouch).toBeCloseTo(0.5, 9);
    expect(out.reloading).toBe(true);
    expect(out.firing).toBe(true);
    expect(out.variant).toBe(1);
  });

  it('clears reloading for a dead actor', () => {
    const bot: ActorPoseSource = {
      position: vec3(),
      yaw: 0,
      pitch: 0,
      alive: false,
      team: 'ct',
      weapon: { id: 'rifle', reloading: true },
    };
    const out = createRenderState();
    applyActorRenderState(out, bot);
    expect(out.alive).toBe(false);
    expect(out.reloading).toBe(false);
    expect(out.speed).toBe(0);
    expect(out.crouch).toBe(0);
  });
});

describe('3C 契约：CharacterState → CameraTarget', () => {
  it('writes a standing eye, crouch amount and velocity for a live character', () => {
    const state = stateAt(3, 1, -2);
    state.velocity = { x: 1, y: -2, z: 3 };
    state.pitch = 0.15;
    setCrouch(state, 1);
    const target = createCameraTarget({ fov: 74 });
    applyCameraTarget(target, state, { fov: 80 });
    // 相机自己按 crouchDrop 下沉，所以 eye 仍是站立视点。
    expect(target.eye).toEqual({ x: 3, y: 1 + 1.62, z: -2 });
    expect(target.crouch).toBe(1);
    expect(state.eyeHeight).toBeCloseTo(1.1, 9);
    expect(target.yaw).toBeCloseTo(0.6, 9);
    expect(target.pitch).toBeCloseTo(0.15, 9);
    expect(target.velocity).toEqual({ x: 1, y: -2, z: 3 });
    expect(target.fov).toBe(80);
    expect(target.alive).toBe(true);
    expect(target.spectate).toBeNull();
    expect(target.recoil).toEqual({ pitch: 0, yaw: 0 });
    expect(target.shake).toBe(0);
  });

  it('passes visual recoil/shake through without touching gameplay state', () => {
    const state = stateAt();
    const target = createCameraTarget();
    applyCameraTarget(target, state, { recoil: { pitch: 0.01, yaw: -0.003 }, shake: 0.4 });
    expect(target.recoil).toEqual({ pitch: 0.01, yaw: -0.003 });
    expect(target.shake).toBeCloseTo(0.4, 9);
    expect(state.pitch).toBe(0);
    applyCameraTarget(target, state, { shake: 5 });
    expect(target.shake).toBe(1);
  });

  it('marks death with alive=false, a corpse eye and spectate candidates', () => {
    const state = stateAt(1, 0, 1);
    killCharacter(state);
    const spectate = buildSpectateState(
      [
        { id: 'Sable', eye: { x: 0, y: 1.62, z: 0 }, yaw: 0, pitch: 0, alive: true },
        { id: 'Rook', eye: { x: 2, y: 1.62, z: 0 }, yaw: 0, pitch: 0, alive: false },
      ],
      'Rook',
    );
    const target = createCameraTarget();
    applyCameraTarget(target, state, { spectate });
    expect(target.alive).toBe(false);
    expect(target.eye).toEqual({ x: 1, y: DEATH_EYE_HEIGHT, z: 1 });
    expect(target.crouch).toBe(0);
    expect(target.spectate).not.toBeNull();
    // preferredId 已阵亡 → 相机回退到第一个存活候选。
    expect(resolveSpectateTarget(target.spectate)?.id).toBe('Sable');
    expect(buildSpectateState([], null).candidates).toHaveLength(0);
  });

  it('keeps the current fov when no fov extras are supplied', () => {
    const target = createCameraTarget({ fov: 66 });
    applyCameraTarget(target, stateAt());
    expect(target.fov).toBe(66);
  });

  it('sanitizes non-finite control values so cameras never receive NaN', () => {
    const state = stateAt();
    state.yaw = Number.NaN;
    state.pitch = Number.POSITIVE_INFINITY;
    state.crouchAmount = Number.NaN;
    const target = createCameraTarget();
    applyCameraTarget(target, state);
    expect(target.yaw).toBe(0);
    expect(target.pitch).toBe(0);
    expect(Number.isFinite(target.eye.y)).toBe(true);
    const out = createRenderState();
    applyCharacterRenderState(out, state);
    expect(out.yaw).toBe(0);
    expect(out.crouch).toBe(0);
  });
});
