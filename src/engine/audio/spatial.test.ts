import { describe, expect, it } from 'vitest';
import {
  applyListener,
  createVoicePanner,
  distanceAttenuation,
  forwardFromAngles,
  normalizeVec3,
  setPannerPosition,
} from './spatial';
import { MockAudioContext, MockPannerNode } from './fixtures';
import type { SoundDef } from './types';

const options = { refDistance: 6, maxDistance: 60, rolloff: 1 };

describe('距离衰减数学', () => {
  it('refDistance 以内不衰减', () => {
    expect(distanceAttenuation(0, options)).toBeCloseTo(1, 9);
    expect(distanceAttenuation(6, options)).toBeCloseTo(1, 9);
  });

  it('距离越远衰减越小且两两单调不增', () => {
    const distances = [6, 8, 12, 20, 30, 45, 60];
    const values = distances.map((distance) => distanceAttenuation(distance, options));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeLessThan(values[i - 1]);
    }
    expect(values[values.length - 1]).toBeGreaterThan(0);
  });

  it('超过 maxDistance 后不再继续衰减', () => {
    expect(distanceAttenuation(60, options)).toBeCloseTo(distanceAttenuation(200, options), 9);
  });

  it('rolloff 越大衰减越快', () => {
    const near = distanceAttenuation(20, { ...options, rolloff: 0.5 });
    const far = distanceAttenuation(20, { ...options, rolloff: 2 });
    expect(far).toBeLessThan(near);
  });

  it('rolloff 为 0 时恒定为 1', () => {
    expect(distanceAttenuation(50, { ...options, rolloff: 0 })).toBe(1);
  });

  it('非法距离被当作最远距离处理，结果仍有界', () => {
    const value = distanceAttenuation(Number.NaN, options);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});

describe('向量工具', () => {
  it('yaw/pitch 转换为前向量', () => {
    const forward = forwardFromAngles(0, 0);
    expect(forward.x).toBeCloseTo(0, 9);
    expect(forward.z).toBeCloseTo(-1, 9);
    const right = forwardFromAngles(Math.PI / 2, 0);
    expect(right.x).toBeCloseTo(-1, 9);
    const up = forwardFromAngles(0, Math.PI / 2);
    expect(up.y).toBeCloseTo(1, 9);
  });

  it('零向量与非法值回落到 fallback', () => {
    const fallback = { x: 0, y: 0, z: -1 };
    expect(normalizeVec3({ x: 0, y: 0, z: 0 }, fallback)).toEqual(fallback);
    expect(normalizeVec3({ x: Number.NaN, y: 0, z: 0 }, fallback)).toEqual(fallback);
    const normalized = normalizeVec3({ x: 0, y: 0, z: -4 }, fallback);
    expect(normalized.z).toBeCloseTo(-1, 9);
  });
});

describe('PannerNode 创建', () => {
  const def: Pick<SoundDef, 'refDistance' | 'maxDistance' | 'rolloff' | 'panningModel'> = {
    refDistance: 6,
    maxDistance: 80,
    rolloff: 1.5,
    panningModel: 'HRTF',
  };

  it('使用 HRTF、inverse 距离模型与定义中的衰减参数', () => {
    const ctx = new MockAudioContext();
    const panner = createVoicePanner(ctx.asAudioContext(), def, { x: 1, y: 2, z: 3 }) as unknown as MockPannerNode;
    expect(panner).not.toBeNull();
    expect(panner.panningModel).toBe('HRTF');
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBe(6);
    expect(panner.maxDistance).toBe(80);
    expect(panner.rolloffFactor).toBe(1.5);
    expect(panner.positionX.value).toBeCloseTo(1, 9);
    expect(panner.positionZ.value).toBeCloseTo(3, 9);
  });

  it('HRTF 抛异常时回退 equalpower', () => {
    const ctx = new MockAudioContext({ failHrtf: true });
    const panner = createVoicePanner(ctx.asAudioContext(), def) as unknown as MockPannerNode;
    expect(panner.panningModel).toBe('equalpower');
  });

  it('定义要求 equalpower 时不尝试 HRTF', () => {
    const ctx = new MockAudioContext({ failHrtf: true });
    const panner = createVoicePanner(
      ctx.asAudioContext(),
      { ...def, panningModel: 'equalpower' },
    ) as unknown as MockPannerNode;
    expect(panner.panningModel).toBe('equalpower');
  });

  it('createPanner 不可用时返回 null（降级为非空间化）', () => {
    const ctx = new MockAudioContext({ failPanner: true });
    expect(createVoicePanner(ctx.asAudioContext(), def)).toBeNull();
  });

  it('setPannerPosition 写入 AudioParam', () => {
    const ctx = new MockAudioContext();
    const panner = ctx.createPanner();
    setPannerPosition(panner as unknown as PannerNode, { x: -2, y: 0.5, z: 10 });
    expect(panner.positionX.value).toBeCloseTo(-2, 9);
    expect(panner.positionY.value).toBeCloseTo(0.5, 9);
    expect(panner.positionZ.value).toBeCloseTo(10, 9);
  });
});

describe('listener 更新', () => {
  it('通过 AudioParam 写入位置与朝向', () => {
    const ctx = new MockAudioContext();
    const ok = applyListener(ctx.asAudioContext(), {
      position: { x: 3, y: 1.62, z: -4 },
      forward: { x: 0, y: 0, z: -2 },
      up: { x: 0, y: 1, z: 0 },
    });
    expect(ok).toBe(true);
    expect(ctx.listener.positionX.value).toBeCloseTo(3, 9);
    expect(ctx.listener.positionY.value).toBeCloseTo(1.62, 9);
    expect(ctx.listener.positionZ.value).toBeCloseTo(-4, 9);
    expect(ctx.listener.forwardZ.value).toBeCloseTo(-1, 9);
    expect(ctx.listener.upY.value).toBeCloseTo(1, 9);
  });

  it('零前向量回落到默认朝向，不写入 NaN', () => {
    const ctx = new MockAudioContext();
    applyListener(ctx.asAudioContext(), {
      position: { x: 0, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 0 },
    });
    expect(ctx.listener.forwardZ.value).toBeCloseTo(-1, 9);
    expect(ctx.listener.upY.value).toBeCloseTo(1, 9);
    expect(Number.isNaN(ctx.listener.positionX.value)).toBe(false);
  });

  it('缺少 AudioParam 时回退到 setPosition/setOrientation', () => {
    const calls: number[] = [];
    const legacy = {
      get listener() {
        return {
          setPosition: (x: number, y: number, z: number) => calls.push(x, y, z),
          setOrientation: (fx: number, fy: number, fz: number) => calls.push(fx, fy, fz),
        };
      },
    } as unknown as AudioContext;
    const ok = applyListener(legacy, {
      position: { x: 1, y: 2, z: 3 },
      forward: { x: 0, y: 0, z: -1 },
      up: { x: 0, y: 1, z: 0 },
    });
    expect(ok).toBe(true);
    expect(calls.slice(0, 3)).toEqual([1, 2, 3]);
    expect(calls[5]).toBeCloseTo(-1, 9);
  });
});
