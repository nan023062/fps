import { describe, expect, it } from 'vitest';
import { DEFAULT_OCCLUSION_MARGIN, DEFAULT_OCCLUSION_MIN_DISTANCE, resolveOccludedDistance } from './occlusion';
import { box } from './fixtures';

const FOCUS = { x: 0, y: 1.62, z: 0 };
const BACK = { x: 0, y: 0, z: 1 };

describe('相机遮挡回退', () => {
  it('没有盒体时保持期望距离', () => {
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [])).toBe(3.2);
  });

  it('期望距离为 0 或负数时返回 0', () => {
    expect(resolveOccludedDistance(FOCUS, BACK, 0, [box(-1, 0, 1, 1, 3, 2)])).toBe(0);
    expect(resolveOccludedDistance(FOCUS, BACK, -2, [])).toBe(0);
  });

  it('墙体挡住时拉近到命中点之前（保留 margin）', () => {
    const wall = box(-2, 0, 2, 2, 3, 2.2);
    const distance = resolveOccludedDistance(FOCUS, BACK, 3.2, [wall]);
    expect(distance).toBeCloseTo(2 - DEFAULT_OCCLUSION_MARGIN, 9);
    expect(distance).toBeLessThan(2);
  });

  it('多个盒体取最近的命中点', () => {
    const near = box(-2, 0, 1, 2, 3, 1.2);
    const far = box(-2, 0, 2.5, 2, 3, 2.7);
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [far, near])).toBeCloseTo(
      1 - DEFAULT_OCCLUSION_MARGIN,
      9,
    );
  });

  it('距离被夹到最小距离，不会把相机压进焦点', () => {
    const tooClose = box(-2, 0, 0.1, 2, 3, 0.3);
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [tooClose])).toBe(
      DEFAULT_OCCLUSION_MIN_DISTANCE,
    );
  });

  it('起点在盒体内部时退回到最小距离', () => {
    const around = box(-1, 0, -1, 1, 3, 1);
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [around])).toBe(
      DEFAULT_OCCLUSION_MIN_DISTANCE,
    );
  });

  it('背后的盒体不影响距离', () => {
    const behind = box(-2, 0, -3, 2, 3, -2.5);
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [behind])).toBe(3.2);
  });

  it('可自定义 margin 与 minDistance', () => {
    const wall = box(-2, 0, 1, 2, 3, 1.2);
    expect(resolveOccludedDistance(FOCUS, BACK, 3.2, [wall], { margin: 0.5 })).toBeCloseTo(0.5, 9);
    expect(
      resolveOccludedDistance(FOCUS, BACK, 3.2, [wall], { margin: 0.5, minDistance: 0.9 }),
    ).toBe(0.9);
  });
});
