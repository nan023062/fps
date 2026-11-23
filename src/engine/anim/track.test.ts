import { describe, expect, it } from 'vitest';
import {
  positionTrack,
  rotationTrack,
  sampleTrackValue,
  trackEnd,
} from './track';
import { quatAngleBetween, quatFromAxisAngle } from './math';
import type { Quat, Vec3 } from './math';

const Y_AXIS = { x: 0, y: 1, z: 0 };

function asVec(value: Vec3 | Quat | null): Vec3 {
  if (!value) {
    throw new Error('expected a vector value');
  }
  return value as Vec3;
}

function asQuat(value: Vec3 | Quat | null): Quat {
  if (!value) {
    throw new Error('expected a quaternion value');
  }
  return value as Quat;
}

describe('track sampling', () => {
  it('线性插值在区间中点取平均', () => {
    const track = positionTrack(0, [
      { time: 0, value: { x: 0, y: 0, z: 0 } },
      { time: 1, value: { x: 10, y: -4, z: 2 } },
    ]);
    const mid = asVec(sampleTrackValue(track, 0.5));
    expect(mid.x).toBeCloseTo(5, 6);
    expect(mid.y).toBeCloseTo(-2, 6);
    expect(mid.z).toBeCloseTo(1, 6);
    expect(trackEnd(track)).toBe(1);
  });

  it('阶梯插值保持前一帧，直到跨过关键帧才跳变', () => {
    const track = positionTrack(
      0,
      [
        { time: 0, value: { x: 0, y: 0, z: 0 } },
        { time: 0.5, value: { x: 10, y: 0, z: 0 } },
      ],
      'step',
    );
    expect(asVec(sampleTrackValue(track, 0.499)).x).toBe(0);
    expect(asVec(sampleTrackValue(track, 0.5)).x).toBe(10);
    expect(asVec(sampleTrackValue(track, 0.9)).x).toBe(10);
  });

  it('四元数 slerp 在中点给出半角，且与 nlerp 一致到 0.01 弧度', () => {
    const from = quatFromAxisAngle(Y_AXIS, 0);
    const to = quatFromAxisAngle(Y_AXIS, Math.PI / 2);
    const slerpTrack = rotationTrack(0, [
      { time: 0, value: from },
      { time: 1, value: to },
    ]);
    const nlerpTrack = rotationTrack(
      0,
      [
        { time: 0, value: from },
        { time: 1, value: to },
      ],
      'linear',
    );
    const target = quatFromAxisAngle(Y_AXIS, Math.PI / 4);
    const slerpMid = asQuat(sampleTrackValue(slerpTrack, 0.5));
    const nlerpMid = asQuat(sampleTrackValue(nlerpTrack, 0.5));
    expect(quatAngleBetween(slerpMid, target)).toBeCloseTo(0, 6);
    expect(quatAngleBetween(nlerpMid, target)).toBeLessThan(0.01);
  });

  it('超出首尾时间时夹到端点值', () => {
    const track = positionTrack(0, [
      { time: 0.2, value: { x: 1, y: 0, z: 0 } },
      { time: 0.8, value: { x: 3, y: 0, z: 0 } },
    ]);
    expect(asVec(sampleTrackValue(track, -5)).x).toBe(1);
    expect(asVec(sampleTrackValue(track, 5)).x).toBe(3);
    expect(asVec(sampleTrackValue(track, 0.2)).x).toBe(1);
    expect(asVec(sampleTrackValue(track, 0.8)).x).toBe(3);
  });

  it('单帧轨道任意时间都返回该帧，空轨道返回 null', () => {
    const single = positionTrack(0, [{ time: 0.5, value: { x: 7, y: 0, z: 0 } }]);
    expect(asVec(sampleTrackValue(single, 0)).x).toBe(7);
    expect(asVec(sampleTrackValue(single, 100)).x).toBe(7);
    const empty = positionTrack(0, []);
    expect(sampleTrackValue(empty, 0.3)).toBeNull();
    expect(trackEnd(empty)).toBe(0);
  });

  it('关键帧时间必须升序且有限', () => {
    expect(() =>
      positionTrack(0, [
        { time: 1, value: { x: 0, y: 0, z: 0 } },
        { time: 0.5, value: { x: 1, y: 0, z: 0 } },
      ]),
    ).toThrow(/sorted by time/);
    expect(() =>
      positionTrack(0, [{ time: Number.NaN, value: { x: 0, y: 0, z: 0 } }]),
    ).toThrow(/non finite/);
  });

  it('采样返回拷贝，修改结果不影响轨道数据', () => {
    const track = positionTrack(0, [
      { time: 0, value: { x: 1, y: 2, z: 3 } },
      { time: 1, value: { x: 1, y: 2, z: 3 } },
    ]);
    const value = asVec(sampleTrackValue(track, 0.5));
    value.x = 99;
    expect(track.keys[0].value.x).toBe(1);
  });
});
