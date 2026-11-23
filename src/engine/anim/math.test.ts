import { describe, expect, it } from 'vitest';
import {
  IDENTITY_QUAT,
  conjugateQuat,
  divideVec3,
  lerpVec3,
  multiplyQuat,
  nlerpQuat,
  normalizeQuat,
  quatAngleBetween,
  quatFromAxisAngle,
  slerpQuat,
} from './math';

const Y_AXIS = { x: 0, y: 1, z: 0 };

describe('quaternion math', () => {
  it('slerp 在中点给出半角旋转', () => {
    const from = quatFromAxisAngle(Y_AXIS, 0);
    const to = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    const mid = slerpQuat(from, to, 0.5);
    expect(quatAngleBetween(mid, quatFromAxisAngle(Y_AXIS, Math.PI / 4))).toBeCloseTo(0, 6);
    expect(Math.hypot(mid.x, mid.y, mid.z, mid.w)).toBeCloseTo(1, 6);
  });

  it('slerp 对 t 做夹取，t<=0 取起点、t>=1 取终点', () => {
    const from = quatFromAxisAngle(Y_AXIS, 0);
    const to = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    expect(quatAngleBetween(slerpQuat(from, to, -3), from)).toBeCloseTo(0, 6);
    expect(quatAngleBetween(slerpQuat(from, to, 7), to)).toBeCloseTo(0, 6);
  });

  it('slerp 走最短弧：到 -q 仍是同一个姿态', () => {
    const from = quatFromAxisAngle(Y_AXIS, 0.4);
    const opposite = {
      x: -from.x,
      y: -from.y,
      z: -from.z,
      w: -from.w,
    };
    expect(quatAngleBetween(slerpQuat(from, opposite, 0.5), from)).toBeCloseTo(0, 6);
  });

  it('nlerp 结果保持单位长度且接近 slerp 中点', () => {
    const from = quatFromAxisAngle(Y_AXIS, 0);
    const to = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    const mid = nlerpQuat(from, to, 0.5);
    expect(Math.hypot(mid.x, mid.y, mid.z, mid.w)).toBeCloseTo(1, 6);
    const target = quatFromAxisAngle(Y_AXIS, Math.PI / 4);
    expect(quatAngleBetween(mid, target)).toBeLessThan(0.01);
  });

  it('零长度四元数归一化退化为单位四元数', () => {
    const q = normalizeQuat({ x: 0, y: 0, z: 0, w: 0 });
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('conjugate 与 multiply 组合还原单位元', () => {
    const q = quatFromAxisAngle({ x: 1, y: 2, z: 3 }, 0.9);
    const identity = multiplyQuat(q, conjugateQuat(q));
    expect(quatAngleBetween(identity, IDENTITY_QUAT)).toBeCloseTo(0, 6);
  });
});

describe('vector helpers', () => {
  it('lerpVec3 夹取 t 并逐分量插值', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 10, y: -4, z: 2 };
    expect(lerpVec3(a, b, 0.5)).toEqual({ x: 5, y: -2, z: 1 });
    expect(lerpVec3(a, b, -1)).toEqual(a);
    expect(lerpVec3(a, b, 2)).toEqual(b);
  });

  it('divideVec3 对零分量退化为 1，不产生 NaN', () => {
    const result = divideVec3({ x: 4, y: 9, z: 5 }, { x: 2, y: 0, z: 0 });
    expect(result.x).toBeCloseTo(2, 6);
    expect(result.y).toBe(1);
    expect(result.z).toBe(1);
    expect(Number.isNaN(result.y)).toBe(false);
    expect(Number.isNaN(result.z)).toBe(false);
  });
});
