/**
 * 关节、骨架与姿势数据模型。
 *
 * 骨架只描述层级与默认局部变换（rest pose）；Pose 是每帧可写的扁平数组，
 * 不含任何渲染对象，因此可以在 Worker、Node 测试或 Three.js 之外的宿主里运行。
 */
import type { Quat, Vec3 } from './math';
import { IDENTITY_QUAT, copyQuat, quat } from './math';

/** 单个关节的默认局部变换。 */
export interface LocalTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/**
 * 骨架关节：parent 为父关节在 joints 数组里的下标，null 表示根。
 * 约束：父下标必须小于自身下标（数组天然是拓扑序），createSkeleton 会校验。
 */
export interface Joint {
  name: string;
  parent: number | null;
  local: LocalTransform;
}

export interface Skeleton {
  joints: Joint[];
}

/** 每关节的局部变换数组，长度与骨架关节数一致。 */
export interface Pose {
  position: Vec3[];
  rotation: Quat[];
  scale: Vec3[];
}

export function identityLocal(): LocalTransform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: copyQuat(IDENTITY_QUAT),
    scale: { x: 1, y: 1, z: 1 },
  };
}

export function createJoint(
  name: string,
  parent: number | null,
  local: Partial<LocalTransform> = {},
): Joint {
  const base = identityLocal();
  return {
    name,
    parent,
    local: {
      position: { ...base.position, ...local.position },
      rotation: local.rotation ? copyQuat(local.rotation) : base.rotation,
      scale: { ...base.scale, ...local.scale },
    },
  };
}

/** 校验并冻结关节数组的结构（父子下标、重名）。不改变传入对象。 */
export function createSkeleton(joints: Joint[]): Skeleton {
  const seen = new Set<string>();
  joints.forEach((joint, index) => {
    if (seen.has(joint.name)) {
      throw new Error(`duplicate joint name: ${joint.name}`);
    }
    seen.add(joint.name);
    if (joint.parent !== null) {
      if (joint.parent < 0 || joint.parent >= joints.length) {
        throw new Error(`joint ${joint.name} has out of range parent ${joint.parent}`);
      }
      if (joint.parent >= index) {
        throw new Error(`joint ${joint.name} must come after its parent ${joint.parent}`);
      }
    }
  });
  if (joints.length === 0) {
    throw new Error('skeleton requires at least one joint');
  }
  return { joints };
}

export function jointCount(skeleton: Skeleton): number {
  return skeleton.joints.length;
}

/** 按名字找关节，找不到返回 -1。 */
export function jointIndex(skeleton: Skeleton, name: string): number {
  return skeleton.joints.findIndex((joint) => joint.name === name);
}

export function requireJoint(skeleton: Skeleton, name: string): number {
  const index = jointIndex(skeleton, name);
  if (index < 0) {
    throw new Error(`unknown joint: ${name}`);
  }
  return index;
}

export function parentChain(skeleton: Skeleton, index: number): number[] {
  const chain: number[] = [];
  let current = skeleton.joints[index]?.parent ?? null;
  let guard = 0;
  while (current !== null && guard < 256) {
    chain.push(current);
    current = skeleton.joints[current]?.parent ?? null;
    guard += 1;
  }
  return chain;
}

/** 关节深度（根为 0），用于 mask 的包含判断与排序。 */
export function jointDepth(skeleton: Skeleton, index: number): number {
  return parentChain(skeleton, index).length;
}

/** 返回 index 的全部后代（不含自身），按数组顺序。 */
export function descendantIndices(skeleton: Skeleton, index: number): number[] {
  const result: number[] = [];
  skeleton.joints.forEach((_joint, candidate) => {
    if (candidate === index) {
      return;
    }
    if (parentChain(skeleton, candidate).includes(index)) {
      result.push(candidate);
    }
  });
  return result;
}

/** 由骨架默认局部变换生成 rest pose。 */
export function restPose(skeleton: Skeleton): Pose {
  return {
    position: skeleton.joints.map((joint) => ({ ...joint.local.position })),
    rotation: skeleton.joints.map((joint) => copyQuat(joint.local.rotation)),
    scale: skeleton.joints.map((joint) => ({ ...joint.local.scale })),
  };
}

/** 指定关节数的中性姿势：位置 0、旋转单位、缩放 1。 */
export function identityPose(count: number): Pose {
  const pose: Pose = { position: [], rotation: [], scale: [] };
  for (let i = 0; i < count; i += 1) {
    pose.position.push({ x: 0, y: 0, z: 0 });
    pose.rotation.push(copyQuat(IDENTITY_QUAT));
    pose.scale.push({ x: 1, y: 1, z: 1 });
  }
  return pose;
}

export function clonePose(pose: Pose): Pose {
  return {
    position: pose.position.map((value) => ({ x: value.x, y: value.y, z: value.z })),
    rotation: pose.rotation.map((value) => copyQuat(value)),
    scale: pose.scale.map((value) => ({ x: value.x, y: value.y, z: value.z })),
  };
}

/** 把 source 拷入 target（就地写），并把 target 补/截到 source 长度。 */
export function copyPoseInto(target: Pose, source: Pose): Pose {
  const count = source.position.length;
  for (let i = 0; i < count; i += 1) {
    if (!target.position[i]) {
      target.position[i] = { x: 0, y: 0, z: 0 };
      target.rotation[i] = quat(0, 0, 0, 1);
      target.scale[i] = { x: 1, y: 1, z: 1 };
    }
    const p = source.position[i];
    const r = source.rotation[i] ?? IDENTITY_QUAT;
    const s = source.scale[i] ?? { x: 1, y: 1, z: 1 };
    target.position[i].x = p.x;
    target.position[i].y = p.y;
    target.position[i].z = p.z;
    target.rotation[i] = copyQuat(r);
    target.scale[i].x = s.x;
    target.scale[i].y = s.y;
    target.scale[i].z = s.z;
  }
  target.position.length = count;
  target.rotation.length = count;
  target.scale.length = count;
  return target;
}

/** 用中性值补齐/截断 pose 到指定关节数。 */
export function ensurePoseLength(pose: Pose, count: number): Pose {
  for (let i = pose.position.length; i < count; i += 1) {
    pose.position.push({ x: 0, y: 0, z: 0 });
    pose.rotation.push(copyQuat(IDENTITY_QUAT));
    pose.scale.push({ x: 1, y: 1, z: 1 });
  }
  if (pose.position.length > count) {
    pose.position.length = count;
    pose.rotation.length = count;
    pose.scale.length = count;
  }
  return pose;
}

export function poseJointCount(pose: Pose): number {
  return pose.position.length;
}
