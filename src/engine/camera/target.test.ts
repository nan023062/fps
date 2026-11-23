import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAMERA_FOV,
  createCameraTarget,
  crouchAmount,
  nextSpectateTarget,
  resetCameraTarget,
  resolveSpectateTarget,
} from './target';
import { candidate, makeTarget } from './fixtures';

describe('CameraTarget', () => {
  it('默认值覆盖全部字段且可独立使用', () => {
    const target = createCameraTarget();
    expect(target.eye).toEqual({ x: 0, y: 1.62, z: 0 });
    expect(target.yaw).toBe(0);
    expect(target.pitch).toBe(0);
    expect(target.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(target.crouch).toBe(0);
    expect(target.recoil).toEqual({ pitch: 0, yaw: 0 });
    expect(target.shake).toBe(0);
    expect(target.fov).toBe(DEFAULT_CAMERA_FOV);
    expect(target.alive).toBe(true);
    expect(target.spectate).toBeNull();
  });

  it('支持用覆盖值构造（含向量字段的部分覆盖）', () => {
    const target = createCameraTarget({
      eye: { y: 1.1 },
      velocity: { z: 3 },
      recoil: { pitch: 0.04 },
      crouch: 1,
      alive: false,
      fov: 90,
    });
    expect(target.eye).toEqual({ x: 0, y: 1.1, z: 0 });
    expect(target.velocity).toEqual({ x: 0, y: 0, z: 3 });
    expect(target.recoil).toEqual({ pitch: 0.04, yaw: 0 });
    expect(target.crouch).toBe(1);
    expect(target.alive).toBe(false);
    expect(target.fov).toBe(90);
  });

  it('resetCameraTarget 回到干净的站立活人状态', () => {
    const target = makeTarget({ crouch: 0.7, shake: 0.8, alive: false, yaw: 2, pitch: -1 });
    target.recoil.pitch = 0.2;
    target.spectate = { candidates: [], preferredId: null };
    resetCameraTarget(target);
    expect(target.crouch).toBe(0);
    expect(target.shake).toBe(0);
    expect(target.alive).toBe(true);
    expect(target.yaw).toBe(0);
    expect(target.pitch).toBe(0);
    expect(target.spectate).toBeNull();
    expect(target.recoil).toEqual({ pitch: 0, yaw: 0 });
  });

  it('crouchAmount 夹到 0..1', () => {
    expect(crouchAmount(makeTarget({ crouch: -2 }))).toBe(0);
    expect(crouchAmount(makeTarget({ crouch: 0.42 }))).toBe(0.42);
    expect(crouchAmount(makeTarget({ crouch: 5 }))).toBe(1);
  });
});

describe('观战目标解算', () => {
  const a = candidate('a', { x: 1, y: 1.6, z: 0 });
  const b = candidate('b', { x: 2, y: 1.6, z: 0 });

  it('优先跟随指定目标', () => {
    const resolved = resolveSpectateTarget({ candidates: [a, b], preferredId: 'b' });
    expect(resolved?.id).toBe('b');
  });

  it('指定目标死亡时回退到下一个存活目标', () => {
    const dead = candidate('a', { x: 1, y: 1.6, z: 0 }, { alive: false });
    const resolved = resolveSpectateTarget({ candidates: [dead, b], preferredId: 'a' });
    expect(resolved?.id).toBe('b');
  });

  it('指定目标不存在时回退到第一个存活目标', () => {
    const resolved = resolveSpectateTarget({ candidates: [a, b], preferredId: 'ghost' });
    expect(resolved?.id).toBe('a');
  });

  it('全部死亡或没有候选时返回 null（调用方回退死亡位置）', () => {
    expect(
      resolveSpectateTarget({
        candidates: [candidate('a', { x: 0, y: 0, z: 0 }, { alive: false })],
        preferredId: 'a',
      }),
    ).toBeNull();
    expect(resolveSpectateTarget({ candidates: [], preferredId: 'a' })).toBeNull();
    expect(resolveSpectateTarget(null)).toBeNull();
  });

  it('nextSpectateTarget 循环切换存活目标', () => {
    expect(nextSpectateTarget([a, b], null)?.id).toBe('a');
    expect(nextSpectateTarget([a, b], 'a')?.id).toBe('b');
    expect(nextSpectateTarget([a, b], 'b')?.id).toBe('a');
    expect(
      nextSpectateTarget([candidate('a', { x: 0, y: 0, z: 0 }, { alive: false }), b], 'b')?.id,
    ).toBe('b');
    expect(nextSpectateTarget([], 'a')).toBeNull();
  });
});
