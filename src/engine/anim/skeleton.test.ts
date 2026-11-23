import { describe, expect, it } from 'vitest';
import {
  copyPoseInto,
  createJoint,
  createSkeleton,
  descendantIndices,
  ensurePoseLength,
  identityPose,
  jointDepth,
  jointIndex,
  parentChain,
  poseJointCount,
  requireJoint,
  restPose,
} from './skeleton';
import { createBoneMask, maskCovers, maskedJointCount } from './blending';
import { JOINT, JOINT_COUNT, testSkeleton } from './fixtures';

describe('skeleton structure', () => {
  it('按名字解析关节下标与父链', () => {
    const skeleton = testSkeleton();
    expect(jointIndex(skeleton, 'head')).toBe(JOINT.head);
    expect(jointIndex(skeleton, 'missing')).toBe(-1);
    expect(() => requireJoint(skeleton, 'missing')).toThrow(/unknown joint/);
    expect(parentChain(skeleton, JOINT.head)).toEqual([JOINT.spine, JOINT.hips, JOINT.root]);
    expect(jointDepth(skeleton, JOINT.root)).toBe(0);
    expect(jointDepth(skeleton, JOINT.head)).toBe(3);
  });

  it('拒绝父子顺序错误、越界父下标与重名关节', () => {
    expect(() =>
      createSkeleton([
        createJoint('child', 1),
        createJoint('parent', null),
      ]),
    ).toThrow(/must come after its parent/);
    expect(() => createSkeleton([createJoint('root', 3)])).toThrow(/out of range parent/);
    expect(() =>
      createSkeleton([createJoint('root', null), createJoint('root', 0)]),
    ).toThrow(/duplicate joint name/);
    expect(() => createSkeleton([])).toThrow(/at least one joint/);
  });

  it('descendantIndices 只返回后代，不含自身与旁支', () => {
    const skeleton = testSkeleton();
    expect(descendantIndices(skeleton, JOINT.spine)).toEqual([
      JOINT.head,
      JOINT.leftArm,
      JOINT.rightArm,
    ]);
    expect(descendantIndices(skeleton, JOINT.hips)).not.toContain(JOINT.root);
    expect(descendantIndices(skeleton, JOINT.head)).toEqual([]);
  });
});

describe('pose helpers', () => {
  it('restPose 来自默认局部变换，且与骨架解耦', () => {
    const skeleton = testSkeleton();
    const pose = restPose(skeleton);
    expect(poseJointCount(pose)).toBe(JOINT_COUNT);
    expect(pose.position[JOINT.hips]).toEqual({ x: 0, y: 1, z: 0 });
    expect(pose.rotation[JOINT.root]).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(pose.scale[JOINT.root]).toEqual({ x: 1, y: 1, z: 1 });
    pose.position[JOINT.hips].y = 99;
    expect(skeleton.joints[JOINT.hips].local.position.y).toBe(1);
    expect(restPose(skeleton).position[JOINT.hips].y).toBe(1);
  });

  it('identityPose 与 ensurePoseLength 用中性值补齐/截断', () => {
    const pose = identityPose(2);
    ensurePoseLength(pose, 4);
    expect(poseJointCount(pose)).toBe(4);
    expect(pose.position[3]).toEqual({ x: 0, y: 0, z: 0 });
    expect(pose.rotation[3]).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(pose.scale[3]).toEqual({ x: 1, y: 1, z: 1 });
    ensurePoseLength(pose, 1);
    expect(poseJointCount(pose)).toBe(1);
  });

  it('copyPoseInto 就地写目标并保持两者独立', () => {
    const target = identityPose(JOINT_COUNT);
    const source = restPose(testSkeleton());
    copyPoseInto(target, source);
    expect(target.position[JOINT.hips]).toEqual({ x: 0, y: 1, z: 0 });
    target.position[JOINT.hips].y = 5;
    expect(source.position[JOINT.hips].y).toBe(1);
  });
});

describe('bone mask', () => {
  it('按关节名建遮罩时默认覆盖全部后代', () => {
    const skeleton = testSkeleton();
    const mask = createBoneMask(skeleton, ['spine']);
    expect(maskCovers(mask, JOINT.spine)).toBe(true);
    expect(maskCovers(mask, JOINT.head)).toBe(true);
    expect(maskCovers(mask, JOINT.leftArm)).toBe(true);
    expect(maskCovers(mask, JOINT.rightArm)).toBe(true);
    expect(maskCovers(mask, JOINT.hips)).toBe(false);
    expect(maskCovers(mask, JOINT.leftLeg)).toBe(false);
    expect(maskCovers(mask, JOINT.root)).toBe(false);
    expect(maskedJointCount(mask)).toBe(4);
  });

  it('includeDescendants:false 时只覆盖指定关节', () => {
    const skeleton = testSkeleton();
    const mask = createBoneMask(skeleton, ['spine'], { includeDescendants: false });
    expect(maskCovers(mask, JOINT.spine)).toBe(true);
    expect(maskCovers(mask, JOINT.head)).toBe(false);
    expect(maskedJointCount(mask)).toBe(1);
  });

  it('未知关节名直接抛错，避免遮罩静默失效', () => {
    const skeleton = testSkeleton();
    expect(() => createBoneMask(skeleton, ['spinee'])).toThrow(/unknown joint/);
  });
});
