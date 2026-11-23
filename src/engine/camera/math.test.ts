import { describe, expect, it } from 'vitest';
import { wrapAngle } from '../../core/math';
import {
  DEFAULT_SHAKE_SCALE,
  damp,
  dampAngle,
  dampVec3,
  forwardFromAngles,
  quatFromEuler,
  sampleShake,
  smoothingAlpha,
  valueNoise,
  type Quat,
} from './math';

function rotateVec(q: Quat, v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  // v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
  const tx = q.y * v.z - q.z * v.y + q.w * v.x;
  const ty = q.z * v.x - q.x * v.z + q.w * v.y;
  const tz = q.x * v.y - q.y * v.x + q.w * v.z;
  return {
    x: v.x + 2 * (q.y * tz - q.z * ty),
    y: v.y + 2 * (q.z * tx - q.x * tz),
    z: v.z + 2 * (q.x * ty - q.y * tx),
  };
}

describe('相机四元数', () => {
  it('YXZ 欧拉角旋转 -Z 与 forwardFromAngles 一致', () => {
    const cases: Array<[number, number, number]> = [
      [0, 0, 0],
      [Math.PI / 2, 0, 0],
      [-1.1, 0.35, 0],
      [2.4, -0.6, 0],
    ];
    for (const [yaw, pitch] of cases) {
      const rotated = rotateVec(quatFromEuler(yaw, pitch), { x: 0, y: 0, z: -1 });
      const expected = forwardFromAngles(yaw, pitch);
      expect(rotated.x).toBeCloseTo(expected.x, 9);
      expect(rotated.y).toBeCloseTo(expected.y, 9);
      expect(rotated.z).toBeCloseTo(expected.z, 9);
    }
  });

  it('四元数保持单位长度', () => {
    const q = quatFromEuler(1.3, -0.7, 0.2);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 12);
  });

  it('roll 绕视线轴旋转但不改变朝向', () => {
    const plain = rotateVec(quatFromEuler(0.4, 0.2), { x: 0, y: 0, z: -1 });
    const rolled = rotateVec(quatFromEuler(0.4, 0.2, 0.5), { x: 0, y: 0, z: -1 });
    expect(rolled.x).toBeCloseTo(plain.x, 9);
    expect(rolled.z).toBeCloseTo(plain.z, 9);
  });
});

describe('指数插值', () => {
  it('smoothingAlpha 与帧率无关：1 大步 ≈ 60 小步', () => {
    const big = smoothingAlpha(0.1, 1);
    let remaining = 1;
    for (let i = 0; i < 60; i += 1) {
      remaining *= 1 - smoothingAlpha(0.1, 1 / 60);
    }
    expect(1 - remaining).toBeCloseTo(big, 6);
  });

  it('damp 单调收敛且不过冲', () => {
    let value = 0;
    let previous = 0;
    for (let i = 0; i < 120; i += 1) {
      value = damp(value, 10, 0.05, 1 / 60);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(10);
      previous = value;
    }
    expect(value).toBeCloseTo(10, 6);
  });

  it('dampAngle 走最短弧（跨越 ±π）', () => {
    const goal = -3.1;
    let value = 3.1;
    const before = Math.abs(wrapAngle(goal - value));
    value = dampAngle(value, goal, 0.05, 1 / 60);
    const after = Math.abs(wrapAngle(goal - value));
    expect(after).toBeLessThan(before);
    // 最短弧应为正方向（3.1 → π → -3.1）
    expect(value).toBeGreaterThan(3.1);
  });

  it('dampVec3 原地写入并收敛', () => {
    const out = { x: 0, y: 0, z: 0 };
    const goal = { x: 1, y: -2, z: 3 };
    for (let i = 0; i < 120; i += 1) {
      dampVec3(out, goal, 0.05, 1 / 60);
    }
    expect(out.x).toBeCloseTo(1, 5);
    expect(out.y).toBeCloseTo(-2, 5);
    expect(out.z).toBeCloseTo(3, 5);
  });
});

describe('抖动噪声', () => {
  it('valueNoise 可确定复现且落在 [-1, 1]', () => {
    for (let i = 0; i < 200; i += 1) {
      const t = i * 0.37;
      const a = valueNoise(3, t);
      expect(valueNoise(3, t)).toBe(a);
      expect(a).toBeGreaterThanOrEqual(-1);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it('trauma=0 时完全没有抖动', () => {
    const offsets = sampleShake(0, 12.5);
    expect(offsets.yaw).toBe(0);
    expect(offsets.pitch).toBe(0);
    expect(offsets.roll).toBe(0);
    expect(offsets.position.x).toBe(0);
    expect(offsets.position.y).toBe(0);
    expect(offsets.position.z).toBe(0);
  });

  it('幅度按 trauma² 缩放：半量只有四分之一', () => {
    const full = sampleShake(1, 4.2);
    const half = sampleShake(0.5, 4.2);
    expect(half.yaw).toBeCloseTo(full.yaw * 0.25, 12);
    expect(half.pitch).toBeCloseTo(full.pitch * 0.25, 12);
    expect(half.roll).toBeCloseTo(full.roll * 0.25, 12);
    expect(half.position.x).toBeCloseTo(full.position.x * 0.25, 12);
  });

  it('抖动幅度受 scale 约束', () => {
    const offsets = sampleShake(1, 7.7, undefined, DEFAULT_SHAKE_SCALE);
    expect(Math.abs(offsets.yaw)).toBeLessThanOrEqual(DEFAULT_SHAKE_SCALE.yaw + 1e-12);
    expect(Math.abs(offsets.roll)).toBeLessThanOrEqual(DEFAULT_SHAKE_SCALE.roll + 1e-12);
    expect(Math.abs(offsets.position.x)).toBeLessThanOrEqual(DEFAULT_SHAKE_SCALE.position + 1e-12);
  });
});
