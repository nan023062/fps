/**
 * 动画单元测试共用的确定性夹具：固定骨架、固定关节下标、固定片段。
 * 不含真实时间与随机数，任何用例都可重复执行。
 */
import type { AnimationClip, ClipEvent } from './clip';
import { createClip } from './clip';
import type { Skeleton } from './skeleton';
import { createJoint, createSkeleton } from './skeleton';
import { positionTrack, rotationTrack } from './track';
import type { Vec3 } from './math';
import { quatFromAxisAngle } from './math';

/** 关节下标常量：关节顺序即拓扑序，父下标小于子下标。 */
export const JOINT = {
  root: 0,
  hips: 1,
  spine: 2,
  head: 3,
  leftArm: 4,
  rightArm: 5,
  leftLeg: 6,
  rightLeg: 7,
} as const;

export const JOINT_COUNT = 8;

/** 上半身关节名：spine 覆盖 head 与双臂。 */
export const UPPER_BODY_JOINTS = ['spine'] as const;

export function testSkeleton(): Skeleton {
  return createSkeleton([
    createJoint('root', null),
    createJoint('hips', JOINT.root, { position: { x: 0, y: 1, z: 0 } }),
    createJoint('spine', JOINT.hips, { position: { x: 0, y: 0.3, z: 0 } }),
    createJoint('head', JOINT.spine, { position: { x: 0, y: 0.4, z: 0 } }),
    createJoint('leftArm', JOINT.spine, { position: { x: 0.2, y: 0.2, z: 0 } }),
    createJoint('rightArm', JOINT.spine, { position: { x: -0.2, y: 0.2, z: 0 } }),
    createJoint('leftLeg', JOINT.hips, { position: { x: 0.15, y: 0, z: 0 } }),
    createJoint('rightLeg', JOINT.hips, { position: { x: -0.15, y: 0, z: 0 } }),
  ]);
}

/** 单通道位置片段：t=0 为 from，t=duration 为 to。 */
export function moveClip(
  name: string,
  joint: number,
  from: Vec3,
  to: Vec3,
  duration = 1,
  options: { loop?: boolean; events?: ClipEvent[] } = {},
): AnimationClip {
  return createClip({
    name,
    duration,
    loop: options.loop ?? true,
    jointCount: JOINT_COUNT,
    tracks: [
      positionTrack(joint, [
        { time: 0, value: from },
        { time: duration, value: to },
      ]),
    ],
    events: options.events,
  });
}

/** 常量姿势片段：整段保持同一位置，便于观察混合权重。 */
export function constantClip(
  name: string,
  joint: number,
  value: Vec3,
  duration = 1,
): AnimationClip {
  return createClip({
    name,
    duration,
    loop: true,
    jointCount: JOINT_COUNT,
    tracks: [positionTrack(joint, [{ time: 0, value: value }])],
  });
}

/** 绕 Y 轴旋转的片段，用于验证 slerp 与旋转混合。 */
export function turnClip(
  name: string,
  joint: number,
  angle: number,
  duration = 1,
): AnimationClip {
  return createClip({
    name,
    duration,
    loop: true,
    jointCount: JOINT_COUNT,
    tracks: [
      rotationTrack(joint, [
        { time: 0, value: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, 0) },
        { time: duration, value: quatFromAxisAngle({ x: 0, y: 1, z: 0 }, angle) },
      ]),
    ],
  });
}
