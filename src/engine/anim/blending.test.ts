import { describe, expect, it } from 'vitest';
import {
  applyMaskedLayer,
  blendPoses,
  createBoneMask,
  createMaskFromJoints,
  crossFadePose,
  fullBodyMask,
  maskCovers,
  maskedJointCount,
  velocityBlend,
  velocityWeights,
} from './blending';
import { clonePose, identityPose, restPose } from './skeleton';
import type { Pose } from './skeleton';
import { quatAngleBetween, quatFromAxisAngle } from './math';
import { JOINT, JOINT_COUNT, testSkeleton } from './fixtures';

const Y_AXIS = { x: 0, y: 1, z: 0 };

/** 所有关节位置相同的常量姿势，便于观察权重。 */
function offsetPose(count: number, x: number, y = 0, z = 0): Pose {
  const pose = identityPose(count);
  for (const position of pose.position) {
    position.x = x;
    position.y = y;
    position.z = z;
  }
  return pose;
}

function spinPose(count: number, angle: number): Pose {
  const pose = identityPose(count);
  const rotation = quatFromAxisAngle(Y_AXIS, angle);
  for (let i = 0; i < count; i += 1) {
    pose.rotation[i] = { ...rotation };
  }
  return pose;
}

describe('crossFadePose', () => {
  it('中点为两姿势的等权混合', () => {
    const a = offsetPose(JOINT_COUNT, 0);
    const b = offsetPose(JOINT_COUNT, 10);
    const mid = crossFadePose(a, b, 0.5);
    expect(mid.position[JOINT.root].x).toBeCloseTo(5, 6);
    expect(mid.position[JOINT.head].x).toBeCloseTo(5, 6);
    expect(mid.scale[JOINT.root].x).toBeCloseTo(1, 6);
  });

  it('旋转按 slerp 混合，中点角度为半角', () => {
    const a = spinPose(JOINT_COUNT, 0);
    const b = spinPose(JOINT_COUNT, Math.PI / 2);
    const mid = crossFadePose(a, b, 0.5);
    expect(quatAngleBetween(mid.rotation[JOINT.spine], quatFromAxisAngle(Y_AXIS, Math.PI / 4)))
      .toBeCloseTo(0, 6);
  });

  it('t 夹到 [0,1] 且返回新对象', () => {
    const a = offsetPose(JOINT_COUNT, 1);
    const b = offsetPose(JOINT_COUNT, 3);
    const atStart = crossFadePose(a, b, -1);
    const atEnd = crossFadePose(a, b, 2);
    expect(atStart.position[JOINT.root].x).toBe(1);
    expect(atEnd.position[JOINT.root].x).toBe(3);
    atStart.position[JOINT.root].x = 42;
    expect(a.position[JOINT.root].x).toBe(1);
  });
});

describe('blendPoses', () => {
  it('按权重归一化：1:3 混合得到 7.5', () => {
    const a = offsetPose(JOINT_COUNT, 0);
    const b = offsetPose(JOINT_COUNT, 10);
    const blended = blendPoses([
      { pose: a, weight: 1 },
      { pose: b, weight: 3 },
    ]);
    expect(blended.position[JOINT.root].x).toBeCloseTo(7.5, 6);
    expect(blended.position[JOINT.rightLeg].x).toBeCloseTo(7.5, 6);
  });

  it('忽略零/负权重，全零时返回第一个姿势的拷贝', () => {
    const a = offsetPose(JOINT_COUNT, 2);
    const b = offsetPose(JOINT_COUNT, 8);
    const onlyA = blendPoses([
      { pose: a, weight: 2 },
      { pose: b, weight: 0 },
    ]);
    expect(onlyA.position[JOINT.root].x).toBeCloseTo(2, 6);
    const allZero = blendPoses([
      { pose: a, weight: 0 },
      { pose: b, weight: 0 },
    ]);
    expect(allZero.position[JOINT.root].x).toBe(2);
    allZero.position[JOINT.root].x = 77;
    expect(a.position[JOINT.root].x).toBe(2);
  });

  it('没有输入时返回中性姿势，不抛错', () => {
    const empty = blendPoses([]);
    expect(empty.position).toHaveLength(0);
    const zeros = blendPoses([{ pose: identityPose(2), weight: 0 }]);
    expect(zeros.position[JOINT.root].x).toBe(0);
  });

  it('两个等权旋转求和归一化后为半角', () => {
    const blended = blendPoses([
      { pose: spinPose(JOINT_COUNT, 0), weight: 0.5 },
      { pose: spinPose(JOINT_COUNT, Math.PI / 2), weight: 0.5 },
    ]);
    const q = blended.rotation[JOINT.head];
    expect(quatAngleBetween(q, quatFromAxisAngle(Y_AXIS, Math.PI / 4))).toBeCloseTo(0, 6);
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 6);
  });
});

describe('velocityWeights / velocityBlend (idle/walk/run)', () => {
  const speeds = [0, 4, 8];

  it('恰好落在阈值上时该档为 1', () => {
    expect(velocityWeights(0, speeds)).toEqual([1, 0, 0]);
    expect(velocityWeights(4, speeds)).toEqual([0, 1, 0]);
    expect(velocityWeights(8, speeds)).toEqual([0, 0, 1]);
  });

  it('相邻阈值之间线性过渡并归一化', () => {
    const slow = velocityWeights(2, speeds);
    expect(slow[0]).toBeCloseTo(0.5, 6);
    expect(slow[1]).toBeCloseTo(0.5, 6);
    expect(slow[2]).toBeCloseTo(0, 6);
    const fast = velocityWeights(6, speeds);
    expect(fast[1]).toBeCloseTo(0.5, 6);
    expect(fast[2]).toBeCloseTo(0.5, 6);
  });

  it('越界夹到两端，权重和始终为 1', () => {
    expect(velocityWeights(-3, speeds)).toEqual([1, 0, 0]);
    expect(velocityWeights(100, speeds)).toEqual([0, 0, 1]);
    for (let speed = -2; speed <= 10; speed += 0.5) {
      const weights = velocityWeights(speed, speeds);
      const sum = weights.reduce((total, value) => total + value, 0);
      expect(sum).toBeCloseTo(1, 9);
      expect(weights.every((value) => value >= 0)).toBe(true);
    }
  });

  it('run 权重随速度单调不减，idle 权重单调不增', () => {
    let lastRun = -1;
    let lastIdle = 2;
    for (let speed = 0; speed <= 8; speed += 0.25) {
      const [idle, , run] = velocityWeights(speed, speeds);
      expect(run).toBeGreaterThanOrEqual(lastRun - 1e-9);
      expect(idle).toBeLessThanOrEqual(lastIdle + 1e-9);
      lastRun = run;
      lastIdle = idle;
    }
  });

  it('velocityBlend 在相邻速度间插值姿势', () => {
    const stops = [
      { speed: 0, pose: offsetPose(JOINT_COUNT, 0, 0) },
      { speed: 4, pose: offsetPose(JOINT_COUNT, 0, 2) },
      { speed: 8, pose: offsetPose(JOINT_COUNT, 0, 4) },
    ];
    expect(velocityBlend(0, stops).position[JOINT.hips].y).toBeCloseTo(0, 6);
    expect(velocityBlend(2, stops).position[JOINT.hips].y).toBeCloseTo(1, 6);
    expect(velocityBlend(6, stops).position[JOINT.hips].y).toBeCloseTo(3, 6);
    expect(velocityBlend(9, stops).position[JOINT.hips].y).toBeCloseTo(4, 6);
    expect(velocityBlend(0, []).position).toHaveLength(0);
  });
});

describe('masked upper body layer', () => {
  const skeleton = testSkeleton();

  it('override：只改遮罩关节，下半身与根保持 base', () => {
    const base = offsetPose(JOINT_COUNT, 1);
    const layer = offsetPose(JOINT_COUNT, 5);
    const mask = createBoneMask(skeleton, ['spine']);
    expect(maskedJointCount(mask)).toBe(4);
    const result = applyMaskedLayer(base, layer, mask, { mode: 'override', weight: 1 });
    expect(result.position[JOINT.spine].x).toBeCloseTo(5, 6);
    expect(result.position[JOINT.head].x).toBeCloseTo(5, 6);
    expect(result.position[JOINT.leftArm].x).toBeCloseTo(5, 6);
    expect(result.position[JOINT.root].x).toBeCloseTo(1, 6);
    expect(result.position[JOINT.hips].x).toBeCloseTo(1, 6);
    expect(result.position[JOINT.leftLeg].x).toBeCloseTo(1, 6);
    expect(result.position[JOINT.rightLeg].x).toBeCloseTo(1, 6);
  });

  it('override：weight 决定淡入比例，且不修改输入姿势', () => {
    const base = offsetPose(JOINT_COUNT, 0);
    const layer = offsetPose(JOINT_COUNT, 4);
    const mask = createMaskFromJoints(JOINT_COUNT, [JOINT.spine]);
    const result = applyMaskedLayer(base, layer, mask, { mode: 'override', weight: 0.25 });
    expect(result.position[JOINT.spine].x).toBeCloseTo(1, 6);
    expect(result.position[JOINT.root].x).toBeCloseTo(0, 6);
    expect(base.position[JOINT.spine].x).toBe(0);
    expect(layer.position[JOINT.spine].x).toBe(4);
  });

  it('additive：以 rest 为参考叠加增量，下半身完全不变', () => {
    const base = restPose(skeleton);
    const layer = clonePose(base);
    const delta = quatFromAxisAngle(Y_AXIS, Math.PI / 6);
    for (const joint of [JOINT.spine, JOINT.head, JOINT.leftArm]) {
      layer.position[joint].y += 0.4;
      layer.rotation[joint] = delta;
    }
    const mask = createBoneMask(skeleton, ['spine']);
    const result = applyMaskedLayer(base, layer, mask, {
      mode: 'additive',
      weight: 0.5,
      reference: base,
    });
    expect(result.position[JOINT.spine].y).toBeCloseTo(base.position[JOINT.spine].y + 0.2, 6);
    expect(quatAngleBetween(result.rotation[JOINT.head], quatFromAxisAngle(Y_AXIS, Math.PI / 12)))
      .toBeCloseTo(0, 6);
    for (const joint of [JOINT.root, JOINT.hips, JOINT.leftLeg, JOINT.rightLeg]) {
      expect(result.position[joint]).toEqual(base.position[joint]);
      expect(result.rotation[joint]).toEqual(base.rotation[joint]);
      expect(result.scale[joint]).toEqual(base.scale[joint]);
    }
  });

  it('additive：weight 1 时遮罩关节等于 layer 姿势', () => {
    const base = restPose(skeleton);
    const layer = clonePose(base);
    layer.position[JOINT.spine] = { x: 0.1, y: 0.2, z: 0.3 };
    layer.rotation[JOINT.spine] = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, 0.7);
    const mask = createBoneMask(skeleton, ['spine'], { includeDescendants: false });
    const result = applyMaskedLayer(base, layer, mask, {
      mode: 'additive',
      weight: 1,
      reference: base,
    });
    expect(result.position[JOINT.spine]).toEqual(layer.position[JOINT.spine]);
    expect(quatAngleBetween(result.rotation[JOINT.spine], layer.rotation[JOINT.spine]))
      .toBeCloseTo(0, 6);
  });

  it('weight 0 时完全不生效，全身遮罩覆盖所有关节', () => {
    const base = restPose(skeleton);
    const layer = offsetPose(JOINT_COUNT, 9);
    const upper = createBoneMask(skeleton, ['spine']);
    const untouched = applyMaskedLayer(base, layer, upper, { mode: 'override', weight: 0 });
    expect(untouched.position[JOINT.spine]).toEqual(base.position[JOINT.spine]);
    const mask = fullBodyMask(JOINT_COUNT);
    expect(maskedJointCount(mask)).toBe(JOINT_COUNT);
    const all = applyMaskedLayer(base, layer, mask, { mode: 'override', weight: 1 });
    expect(all.position[JOINT.leftLeg].x).toBe(9);
    expect(maskCovers(mask, JOINT.root)).toBe(true);
  });
});
