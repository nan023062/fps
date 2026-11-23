/**
 * 人体骨架定义（只依赖 E1 纯动画运行时，不依赖 Three.js）。
 *
 * 关节覆盖任务要求：root / 骨盆 / 脊柱 / 胸 / 头 / 双臂上下段 / 双腿上下段 / 脚，
 * 另外加入左右手关节作为武器挂点宿主（handR 上挂武器）。
 *
 * 约定（与关卡和相机一致）：
 * - +Y 向上，角色正面朝 -Z（与 yaw 0 的相机前向一致）；
 * - 关节 local.position 相对父关节，单位米；
 * - rest pose 双臂自然下垂、双腿直立，动画片段负责把手臂抬到持枪姿态。
 */
import {
  createBoneMask,
  createJoint,
  createSkeleton,
  createMaskFromJoints,
  requireJoint,
  type BoneMask,
  type Joint,
  type Skeleton,
} from '../engine/anim';
import type { Vec3 } from '../engine/anim';

export type HumanJoint =
  | 'root'
  | 'pelvis'
  | 'spine'
  | 'chest'
  | 'head'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR'
  | 'upperLegL'
  | 'lowerLegL'
  | 'footL'
  | 'upperLegR'
  | 'lowerLegR'
  | 'footR';

/** 关键高度（米）：给几何与动画共用，避免两处写死不同数值。 */
export const HUMAN_DIMENSIONS = {
  hipHeight: 0.94,
  spineHeight: 0.14,
  chestHeight: 0.22,
  headHeight: 0.26,
  shoulderHeight: 0.1,
  shoulderOffset: 0.235,
  upperArmLength: 0.26,
  lowerArmLength: 0.24,
  hipOffset: 0.11,
  hipDrop: 0.06,
  upperLegLength: 0.38,
  lowerLegLength: 0.38,
  footLift: 0.02,
  /** 视觉总高（头盔顶部），供调试与相机参考。 */
  height: 1.82,
} as const;

function v(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/**
 * 关节顺序即骨架拓扑序：父关节必须排在子关节之前（createSkeleton 会校验）。
 * 这个数组同时决定 Pose 数组下标与 Three.js 骨骼数组下标。
 */
export const HUMAN_JOINTS: Joint[] = [
  createJoint('root', null, { position: v(0, 0, 0) }),
  createJoint('pelvis', 0, { position: v(0, HUMAN_DIMENSIONS.hipHeight, 0) }),
  createJoint('spine', 1, { position: v(0, HUMAN_DIMENSIONS.spineHeight, 0) }),
  createJoint('chest', 2, { position: v(0, HUMAN_DIMENSIONS.chestHeight, 0) }),
  createJoint('head', 3, { position: v(0, HUMAN_DIMENSIONS.headHeight, 0) }),
  createJoint('upperArmL', 3, {
    position: v(-HUMAN_DIMENSIONS.shoulderOffset, HUMAN_DIMENSIONS.shoulderHeight, 0),
  }),
  createJoint('lowerArmL', 5, { position: v(0, -HUMAN_DIMENSIONS.upperArmLength, 0) }),
  createJoint('handL', 6, { position: v(0, -HUMAN_DIMENSIONS.lowerArmLength, 0) }),
  createJoint('upperArmR', 3, {
    position: v(HUMAN_DIMENSIONS.shoulderOffset, HUMAN_DIMENSIONS.shoulderHeight, 0),
  }),
  createJoint('lowerArmR', 8, { position: v(0, -HUMAN_DIMENSIONS.upperArmLength, 0) }),
  createJoint('handR', 9, { position: v(0, -HUMAN_DIMENSIONS.lowerArmLength, 0) }),
  createJoint('upperLegL', 1, {
    position: v(-HUMAN_DIMENSIONS.hipOffset, -HUMAN_DIMENSIONS.hipDrop, 0),
  }),
  createJoint('lowerLegL', 11, { position: v(0, -HUMAN_DIMENSIONS.upperLegLength, 0) }),
  createJoint('footL', 12, { position: v(0, -HUMAN_DIMENSIONS.lowerLegLength, HUMAN_DIMENSIONS.footLift) }),
  createJoint('upperLegR', 1, {
    position: v(HUMAN_DIMENSIONS.hipOffset, -HUMAN_DIMENSIONS.hipDrop, 0),
  }),
  createJoint('lowerLegR', 14, { position: v(0, -HUMAN_DIMENSIONS.upperLegLength, 0) }),
  createJoint('footR', 15, { position: v(0, -HUMAN_DIMENSIONS.lowerLegLength, HUMAN_DIMENSIONS.footLift) }),
];

export function createHumanSkeleton(): Skeleton {
  return createSkeleton(HUMAN_JOINTS.map((joint) => ({
    name: joint.name,
    parent: joint.parent,
    local: {
      position: { ...joint.local.position },
      rotation: { ...joint.local.rotation },
      scale: { ...joint.local.scale },
    },
  })));
}

/** 关节名 → Pose 下标，构建一次即可复用。 */
export function humanJointIndex(): Record<HumanJoint, number> {
  const skeleton = createHumanSkeleton();
  const entries = HUMAN_JOINTS.map((joint) => [joint.name, requireJoint(skeleton, joint.name)]);
  return Object.fromEntries(entries) as Record<HumanJoint, number>;
}

/**
 * 每个关节的 rest 世界坐标（累加父链 local.position）。
 * 蒙皮绑定与几何分区都用它，保证网格与骨骼在同一坐标系。
 */
export function humanRestWorldPositions(skeleton: Skeleton): Record<HumanJoint, Vec3> {
  const result = {} as Record<HumanJoint, Vec3>;
  skeleton.joints.forEach((joint, index) => {
    const local = joint.local.position;
    let x = local.x;
    let y = local.y;
    let z = local.z;
    let parent = joint.parent;
    let guard = 0;
    while (parent !== null && guard < 64) {
      const above = skeleton.joints[parent];
      x += above.local.position.x;
      y += above.local.position.y;
      z += above.local.position.z;
      parent = above.parent;
      guard += 1;
    }
    result[joint.name as HumanJoint] = { x, y, z };
    void index;
  });
  return result;
}

export interface HumanMasks {
  /** 上半身：spine 及其后代（chest/head/双臂/双手），腿部与骨盆不受影响。 */
  upperBody: BoneMask;
  /** 开火后坐：胸与双臂，不含腿。 */
  recoil: BoneMask;
  /** 蹲伏：骨盆与双腿双脚。 */
  crouch: BoneMask;
}

export function createHumanMasks(skeleton: Skeleton): HumanMasks {
  const index = (name: HumanJoint): number => requireJoint(skeleton, name);
  return {
    upperBody: createBoneMask(skeleton, ['spine']),
    recoil: createMaskFromJoints(skeleton.joints.length, [
      index('chest'),
      index('upperArmL'),
      index('lowerArmL'),
      index('upperArmR'),
      index('lowerArmR'),
      index('head'),
    ]),
    crouch: createMaskFromJoints(skeleton.joints.length, [
      index('pelvis'),
      index('upperLegL'),
      index('lowerLegL'),
      index('footL'),
      index('upperLegR'),
      index('lowerLegR'),
      index('footR'),
    ]),
  };
}

/** 双手挂点关节名；右手用于武器，左手可用于副手或换弹动作。 */
export const WEAPON_HAND: HumanJoint = 'handR';
