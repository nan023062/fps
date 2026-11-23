/**
 * 姿势混合：crossfade、权重混合、1D 速度混合与上半身遮罩层。
 *
 * 全部为纯函数，输入输出都是 Pose；调用方（AnimationMixer / CharacterView）
 * 决定何时把结果写到 Three.js 骨骼上。
 */
import type { Pose } from './skeleton';
import {
  clonePose,
  ensurePoseLength,
  identityPose,
  poseJointCount,
  descendantIndices,
  requireJoint,
} from './skeleton';
import type { Skeleton } from './skeleton';
import type { Quat, Vec3 } from './math';
import {
  clamp01,
  conjugateQuat,
  divideVec3,
  lerpVec3,
  multiplyQuat,
  multiplyVec3,
  normalizeQuat,
  slerpQuat,
} from './math';

/** 关节遮罩：true 表示该关节被该层覆盖。 */
export interface BoneMask {
  joints: boolean[];
}

export type LayerMode = 'override' | 'additive';

export function createMaskFromJoints(count: number, indices: number[]): BoneMask {
  const joints = new Array<boolean>(Math.max(count, 0)).fill(false);
  for (const index of indices) {
    if (index < 0) {
      continue;
    }
    while (joints.length <= index) {
      joints.push(false);
    }
    joints[index] = true;
  }
  return { joints };
}

/**
 * 按关节名建遮罩；默认包含后代关节（例如 spine 覆盖整条上半身）。
 * 未知关节名在开发期即抛错，避免拼写错误导致“层静默失效”。
 */
export function createBoneMask(
  skeleton: Skeleton,
  jointNames: string[],
  options: { includeDescendants?: boolean } = {},
): BoneMask {
  const includeDescendants = options.includeDescendants ?? true;
  const indices: number[] = [];
  for (const name of jointNames) {
    const index = requireJoint(skeleton, name);
    indices.push(index);
    if (includeDescendants) {
      indices.push(...descendantIndices(skeleton, index));
    }
  }
  return createMaskFromJoints(skeleton.joints.length, indices);
}

/** 全身遮罩，用于“整层覆盖”而不做逐关节判断。 */
export function fullBodyMask(count: number): BoneMask {
  return { joints: new Array<boolean>(Math.max(count, 0)).fill(true) };
}

export function maskCovers(mask: BoneMask, joint: number): boolean {
  return mask.joints[joint] === true;
}

function maskCount(mask: BoneMask): number {
  let count = 0;
  for (const value of mask.joints) {
    if (value) {
      count += 1;
    }
  }
  return count;
}

export function maskedJointCount(mask: BoneMask): number {
  return maskCount(mask);
}

export interface PoseWeight {
  pose: Pose;
  weight: number;
}

export interface VelocityStop {
  /** 该姿势对应的速度阈值，按升序传入（idle/walk/run）。 */
  speed: number;
  pose: Pose;
}

/**
 * 权重混合：位置/缩放按权重求和后归一化，旋转按半球对齐后加权求和再归一化
 * （等价于多姿势 nlerp）。
 * - 权重全部为 0：返回第一个姿势的拷贝，避免整具骨架塌到中性值。
 * - 没有有效姿势：返回中性姿势。
 */
export function blendPoses(entries: PoseWeight[]): Pose {
  const valid = entries.filter((entry) => entry.weight > 0 && poseJointCount(entry.pose) > 0);
  const declaredCount = entries.reduce((max, entry) => Math.max(max, poseJointCount(entry.pose)), 0);
  if (valid.length === 0) {
    if (entries.length > 0) {
      return clonePose(entries[0].pose);
    }
    return identityPose(declaredCount);
  }
  if (valid.length === 1) {
    return clonePose(valid[0].pose);
  }
  const count = valid.reduce((max, entry) => Math.max(max, poseJointCount(entry.pose)), 0);
  const totalWeight = valid.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(totalWeight > 0)) {
    return clonePose(valid[0].pose);
  }
  const result: Pose = { position: [], rotation: [], scale: [] };
  const reference = valid[0].pose;
  for (let joint = 0; joint < count; joint += 1) {
    let px = 0;
    let py = 0;
    let pz = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let qx = 0;
    let qy = 0;
    let qz = 0;
    let qw = 0;
    const refQuat = jointAt(reference, joint)?.rotation ?? { x: 0, y: 0, z: 0, w: 1 };
    for (const entry of valid) {
      const sample = jointAt(entry.pose, joint);
      if (!sample) {
        continue;
      }
      const w = entry.weight / totalWeight;
      px += sample.position.x * w;
      py += sample.position.y * w;
      pz += sample.position.z * w;
      sx += sample.scale.x * w;
      sy += sample.scale.y * w;
      sz += sample.scale.z * w;
      const sign = sample.rotation.x * refQuat.x + sample.rotation.y * refQuat.y
        + sample.rotation.z * refQuat.z + sample.rotation.w * refQuat.w < 0 ? -1 : 1;
      qx += sample.rotation.x * w * sign;
      qy += sample.rotation.y * w * sign;
      qz += sample.rotation.z * w * sign;
      qw += sample.rotation.w * w * sign;
    }
    result.position.push({ x: px, y: py, z: pz });
    result.scale.push({ x: sx, y: sy, z: sz });
    result.rotation.push(normalizeQuat({ x: qx, y: qy, z: qz, w: qw }));
  }
  return result;
}

/** 两姿势按 t 交叉淡化：t=0 为 a，t=1 为 b。 */
export function crossFadePose(a: Pose, b: Pose, t: number): Pose {
  const k = clamp01(t);
  if (k <= 0) {
    return clonePose(a);
  }
  if (k >= 1) {
    return clonePose(b);
  }
  return blendPoses([
    { pose: a, weight: 1 - k },
    { pose: b, weight: k },
  ]);
}

/**
 * 1D 速度混合权重：在相邻阈值之间线性过渡，越界夹到两端，最后归一化。
 * speeds 必须升序，常见为 [0（idle）, 4（walk）, 7（run）]。
 */
export function velocityWeights(speed: number, speeds: number[]): number[] {
  const count = speeds.length;
  if (count === 0) {
    return [];
  }
  if (count === 1) {
    return [1];
  }
  const weights = new Array<number>(count).fill(0);
  const clampedSpeed = Number.isFinite(speed) ? speed : 0;
  if (clampedSpeed <= speeds[0]) {
    weights[0] = 1;
  } else if (clampedSpeed >= speeds[count - 1]) {
    weights[count - 1] = 1;
  } else {
    for (let i = 0; i < count - 1; i += 1) {
      const low = speeds[i];
      const high = speeds[i + 1];
      if (clampedSpeed >= low && clampedSpeed <= high) {
        const span = high - low;
        const t = span <= 0 ? 0 : (clampedSpeed - low) / span;
        weights[i] = 1 - t;
        weights[i + 1] = t;
        break;
      }
    }
  }
  const total = weights.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    weights[0] = 1;
    return weights;
  }
  return weights.map((value) => value / total);
}

/** 1D 速度混合：按 velocityWeights 加权混合对应姿势。 */
export function velocityBlend(speed: number, stops: VelocityStop[]): Pose {
  if (stops.length === 0) {
    return identityPose(0);
  }
  const weights = velocityWeights(speed, stops.map((stop) => stop.speed));
  return blendPoses(stops.map((stop, index) => ({ pose: stop.pose, weight: weights[index] })));
}

export interface LayerOptions {
  mode?: LayerMode;
  /** 层权重，0 表示该层不生效。 */
  weight?: number;
  /** additive 模式的参考姿势，默认为中性（rest 语义）。 */
  reference?: Pose;
}

/**
 * 把 layer 叠加到 base 上，只影响 mask 覆盖的关节：
 * - override：在遮罩关节上按 weight 从 base 淡入 layer。
 * - additive：以 reference 为参考，把 (reference⁻¹·layer) 的增量按 weight 叠加到 base。
 * 遮罩外的关节（例如上半身层下的腿与根）保持 base 原值。
 */
export function applyMaskedLayer(
  base: Pose,
  layer: Pose,
  mask: BoneMask,
  options: LayerOptions = {},
): Pose {
  const mode = options.mode ?? 'override';
  const weight = clamp01(options.weight ?? 1);
  const count = Math.max(poseJointCount(base), poseJointCount(layer));
  const result = clonePose(base);
  ensurePoseLength(result, count);
  const reference = options.reference ?? identityPose(count);
  if (poseJointCount(reference) < count) {
    ensurePoseLength(reference, count);
  }
  if (weight <= 0) {
    return result;
  }
  for (let joint = 0; joint < count; joint += 1) {
    if (!maskCovers(mask, joint)) {
      continue;
    }
    const layerJoint = jointAt(layer, joint);
    if (!layerJoint) {
      continue;
    }
    const target = result;
    const baseJoint = jointAt(target, joint) ?? neutralJoint();
    if (mode === 'override') {
      target.position[joint] = lerpVec3(baseJoint.position, layerJoint.position, weight);
      target.scale[joint] = lerpVec3(baseJoint.scale, layerJoint.scale, weight);
      target.rotation[joint] = slerpQuat(baseJoint.rotation, layerJoint.rotation, weight);
      continue;
    }
    const refJoint = jointAt(reference, joint) ?? neutralJoint();
    target.position[joint] = {
      x: baseJoint.position.x + (layerJoint.position.x - refJoint.position.x) * weight,
      y: baseJoint.position.y + (layerJoint.position.y - refJoint.position.y) * weight,
      z: baseJoint.position.z + (layerJoint.position.z - refJoint.position.z) * weight,
    };
    const delta = multiplyQuat(conjugateQuat(refJoint.rotation), layerJoint.rotation);
    const scaled = slerpQuat({ x: 0, y: 0, z: 0, w: 1 }, delta, weight);
    target.rotation[joint] = normalizeQuat(multiplyQuat(baseJoint.rotation, scaled));
    const ratio = divideVec3(layerJoint.scale, refJoint.scale);
    target.scale[joint] = multiplyVec3(
      baseJoint.scale,
      lerpVec3({ x: 1, y: 1, z: 1 }, ratio, weight),
    );
  }
  return result;
}

interface JointSample {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

function jointAt(pose: Pose, joint: number): JointSample | null {
  const position = pose.position[joint];
  if (!position) {
    return null;
  }
  return {
    position,
    rotation: pose.rotation[joint] ?? { x: 0, y: 0, z: 0, w: 1 },
    scale: pose.scale[joint] ?? { x: 1, y: 1, z: 1 },
  };
}

function neutralJoint(): JointSample {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    scale: { x: 1, y: 1, z: 1 },
  };
}
