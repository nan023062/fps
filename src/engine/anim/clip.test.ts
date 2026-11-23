import { describe, expect, it } from 'vitest';
import {
  createClip,
  eventsBetween,
  sampleClip,
  sampleClipInto,
  wrapTime,
} from './clip';
import { identityPose, poseJointCount, restPose } from './skeleton';
import { positionTrack } from './track';
import { JOINT, JOINT_COUNT, moveClip, testSkeleton, turnClip } from './fixtures';

describe('wrapTime', () => {
  it('循环模式对时间取模，负时间折回正区间', () => {
    expect(wrapTime(1.25, 1, true)).toBeCloseTo(0.25, 6);
    expect(wrapTime(-0.25, 1, true)).toBeCloseTo(0.75, 6);
    expect(wrapTime(-2.5, 1, true)).toBeCloseTo(0.5, 6);
    expect(wrapTime(3, 1, true)).toBeCloseTo(0, 6);
  });

  it('非循环模式夹到 [0, duration]，时长为 0 时固定为 0', () => {
    expect(wrapTime(5, 1, false)).toBe(1);
    expect(wrapTime(-5, 1, false)).toBe(0);
    expect(wrapTime(0.4, 1, false)).toBeCloseTo(0.4, 6);
    expect(wrapTime(2, 0, true)).toBe(0);
    expect(wrapTime(Number.NaN, 1, true)).toBe(0);
  });
});

describe('sampleClip', () => {
  it('按时间插值关节位置', () => {
    const clip = moveClip(
      'walk',
      JOINT.root,
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      1,
    );
    expect(sampleClip(clip, 0).position[JOINT.root].x).toBeCloseTo(0, 6);
    expect(sampleClip(clip, 0.5).position[JOINT.root].x).toBeCloseTo(5, 6);
    expect(sampleClip(clip, 0.75).position[JOINT.root].x).toBeCloseTo(7.5, 6);
    // 循环片段在 t=duration 时取模回 0；非循环时停在末帧
    expect(sampleClip(clip, 1).position[JOINT.root].x).toBeCloseTo(0, 6);
    expect(sampleClip(clip, 1, { loop: false }).position[JOINT.root].x).toBeCloseTo(10, 6);
  });

  it('循环取模后采样等价于圈内时间', () => {
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    const wrapped = sampleClip(clip, 1.25);
    const inRange = sampleClip(clip, 0.25);
    expect(wrapped.position[JOINT.root].x).toBeCloseTo(2.5, 6);
    expect(wrapped.position[JOINT.root].x).toBeCloseTo(inRange.position[JOINT.root].x, 6);
  });

  it('负时间在循环模式折回，在 clamp 模式落到首帧', () => {
    const looping = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    expect(sampleClip(looping, -0.25).position[JOINT.root].x).toBeCloseTo(7.5, 6);
    const clamped = moveClip(
      'once',
      JOINT.root,
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      1,
      { loop: false },
    );
    expect(sampleClip(clamped, -0.25).position[JOINT.root].x).toBeCloseTo(0, 6);
    expect(sampleClip(clamped, 4).position[JOINT.root].x).toBeCloseTo(10, 6);
  });

  it('速度缩放把时间倍率体现在采样结果上', () => {
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 2);
    const fast = sampleClip(clip, 0.5, { speed: 2 });
    const direct = sampleClip(clip, 1);
    expect(fast.position[JOINT.root].x).toBeCloseTo(5, 6);
    expect(fast.position[JOINT.root].x).toBeCloseTo(direct.position[JOINT.root].x, 6);
    const still = sampleClip(clip, 0.5, { speed: 0 });
    expect(still.position[JOINT.root].x).toBeCloseTo(0, 6);
  });

  it('未动画关节保留 base（rest）值', () => {
    const skeleton = testSkeleton();
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    const pose = sampleClip(clip, 0.5, { base: restPose(skeleton) });
    expect(poseJointCount(pose)).toBe(JOINT_COUNT);
    expect(pose.position[JOINT.hips]).toEqual({ x: 0, y: 1, z: 0 });
    expect(pose.position[JOINT.root].x).toBeCloseTo(5, 6);
    expect(pose.rotation[JOINT.head]).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('旋转轨道按 slerp 采样', () => {
    const clip = turnClip('turn', JOINT.spine, Math.PI / 2, 1);
    const pose = sampleClip(clip, 0.5);
    expect(pose.rotation[JOINT.spine].y).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(pose.rotation[JOINT.spine].w).toBeCloseTo(Math.cos(Math.PI / 8), 6);
  });

  it('空片段返回中性姿势，零时长片段固定首帧', () => {
    const empty = createClip({ name: 'empty' });
    expect(poseJointCount(sampleClip(empty, 3))).toBe(0);
    const withJoints = createClip({ name: 'empty-joints', jointCount: 3 });
    const neutral = sampleClip(withJoints, 3);
    expect(poseJointCount(neutral)).toBe(3);
    expect(neutral.position[0]).toEqual({ x: 0, y: 0, z: 0 });
    expect(neutral.scale[2]).toEqual({ x: 1, y: 1, z: 1 });

    const frozen = createClip({
      name: 'frozen',
      duration: 0,
      tracks: [positionTrack(0, [{ time: 0, value: { x: 5, y: 0, z: 0 } }])],
      events: [{ name: 'muzzle', time: 0 }],
    });
    expect(sampleClip(frozen, 12).position[0].x).toBeCloseTo(5, 6);
    expect(eventsBetween(frozen, 0, 12, false)).toEqual([]);
  });

  it('空片段带 base 时保留 base 关节数', () => {
    const empty = createClip({ name: 'empty' });
    const base = restPose(testSkeleton());
    expect(poseJointCount(sampleClip(empty, 1, { base }))).toBe(JOINT_COUNT);
  });

  it('sampleClipInto 就地覆盖目标姿势', () => {
    const clip = moveClip('walk', JOINT.root, { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 1);
    const target = identityPose(JOINT_COUNT);
    const returned = sampleClipInto(target, clip, 0.5);
    expect(returned).toBe(target);
    expect(target.position[JOINT.root].x).toBeCloseTo(5, 6);
  });
});

describe('clip events', () => {
  function eventClip() {
    return createClip({
      name: 'fire',
      duration: 1,
      jointCount: JOINT_COUNT,
      events: [
        { name: 'muzzle', time: 0.5, payload: { weapon: 'rifle' } },
        { name: 'reload', time: 0.8 },
      ],
    });
  }

  it('跨过时间点才触发，同一次播放只触发一次', () => {
    const clip = eventClip();
    expect(eventsBetween(clip, 0, 0.4, false)).toHaveLength(0);
    const crossed = eventsBetween(clip, 0.4, 0.6, false);
    expect(crossed.map((event) => event.name)).toEqual(['muzzle']);
    expect(crossed[0].payload).toEqual({ weapon: 'rifle' });
    // 继续推进不会重复触发同一事件
    expect(eventsBetween(clip, 0.6, 0.75, false)).toHaveLength(0);
    // 从事件时间点开始也不重复
    expect(eventsBetween(clip, 0.5, 0.7, false)).toHaveLength(0);
    expect(eventsBetween(clip, 0.7, 0.9, false).map((event) => event.name)).toEqual(['reload']);
  });

  it('循环播放时按圈重复触发，且按发生时间排序', () => {
    const clip = eventClip();
    const fired = eventsBetween(clip, 0, 2, true);
    expect(fired.map((event) => event.name)).toEqual(['muzzle', 'reload', 'muzzle', 'reload']);
    expect(fired.map((event) => event.at)).toEqual([0.5, 0.8, 1.5, 1.8]);
  });

  it('循环边界上不重复：单圈区间只触发一次', () => {
    const clip = eventClip();
    expect(eventsBetween(clip, 0, 1, true).map((event) => event.name)).toEqual(['muzzle', 'reload']);
    const second = eventsBetween(clip, 1, 2, true);
    expect(second).toHaveLength(2);
    expect(second[0].at).toBeCloseTo(1.5, 6);
    expect(eventsBetween(clip, 1, 1, true)).toHaveLength(0);
  });

  it('负时间起点在循环模式下仍能命中事件', () => {
    const clip = eventClip();
    const fired = eventsBetween(clip, -0.2, 0.6, true);
    expect(fired.map((event) => event.name)).toEqual(['muzzle']);
    expect(fired[0].at).toBeCloseTo(0.5, 6);
  });

  it('非循环片段越过时长后不再重复事件', () => {
    const clip = eventClip();
    expect(eventsBetween(clip, 0, 3, false).map((event) => event.name)).toEqual([
      'muzzle',
      'reload',
    ]);
  });
});
