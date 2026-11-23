/**
 * 程序化人体动画片段（关键帧手写，不依赖任何外部动画文件）。
 *
 * 全部用 E1 运行时的 createClip / rotationTrack / positionTrack 构建：
 * - idle / walk / run：layer 0 的全身 locomotion，按速度权重混合；
 * - aim / reload：上半身遮罩层的覆盖姿势；
 * - fire：上半身遮罩层的 additive 后坐增量；
 * - death：全身一次性倒地，不循环。
 *
 * 不滑步的依据：walk/run 片段按“每步位移 ÷ 标称速度”定时长，
 * 混合权重来自 velocityWeights（相邻阈值线性插值），因此任意速度下
 * 加权标称速度恰好等于实际速度，片段按 1 倍速播放即与位移同步。
 */
import {
  conjugateQuat,
  createClip,
  multiplyQuat,
  positionTrack,
  quatFromAxisAngle,
  restPose,
  rotationTrack,
  sampleClip,
  type AnimationClip,
  type AnyTrack,
  type Pose,
  type Quat,
  type Skeleton,
  type VelocityStop,
} from '../engine/anim';
import type { HumanJoint, HumanMasks } from './rig';
import { HUMAN_DIMENSIONS } from './rig';

/** 步态参数：每步位移（米）决定步频，标称速度决定混合阈值。 */
export const LOCOMOTION = {
  walk: { speed: 1.6, stride: 0.72 },
  run: { speed: 4.1, stride: 1.32 },
} as const;

/** 速度混合阈值（idle → walk → run），交给 E1 velocityWeights 使用。 */
export const LOCOMOTION_SPEEDS = [0, LOCOMOTION.walk.speed, LOCOMOTION.run.speed];

/** 每步时长（秒）：位移 ÷ 速度。 */
export function stepDuration(kind: 'walk' | 'run', speed: number): number {
  const stride = LOCOMOTION[kind].stride;
  const clamped = Number.isFinite(speed) ? Math.max(speed, 0.01) : 0.01;
  return stride / clamped;
}

/** 一个完整步态周期（两步）时长。 */
export const WALK_DURATION = (LOCOMOTION.walk.stride * 2) / LOCOMOTION.walk.speed;
export const RUN_DURATION = (LOCOMOTION.run.stride * 2) / LOCOMOTION.run.speed;

/**
 * 片段时间倍率：idle/walk/run 混合权重已保证标称速度 = 实际速度，
 * 只有超过跑步标称速度时才需要额外加速（例如被击退或调试超速）。
 */
export function locomotionTimeScale(speed: number): number {
  if (!Number.isFinite(speed) || speed <= LOCOMOTION.run.speed) return 1;
  return Math.min(1.6, speed / LOCOMOTION.run.speed);
}

/** 持枪时上臂前抬角度（弧度）；武器挂点用它抵消手臂旋转。 */
export const AIM_ARM_PITCH = 1.32;

/** 换弹片段时长与游戏内换弹时间对齐（rifle 2.4s / pistol 1.9s）。 */
export const RELOAD_SECONDS: Record<'rifle' | 'pistol', number> = { rifle: 2.4, pistol: 1.9 };
export const RELOAD_CLIP_DURATION = 2.4;

export interface HumanClips {
  idle: AnimationClip;
  walk: AnimationClip;
  run: AnimationClip;
  aim: AnimationClip;
  fire: AnimationClip;
  reload: AnimationClip;
  death: AnimationClip;
  /** 瞄准 pitch 的三档增量姿势（-0.9 / 0 / +0.9 弧度），供 velocityBlend 使用。 */
  aimPitchStops: VelocityStop[];
  /** 蹲伏增量姿势（additive，遮罩为骨盆与腿脚）。 */
  crouchPose: Pose;
}

interface AngleKey {
  t: number;
  x?: number;
  y?: number;
  z?: number;
}

interface VecKey {
  t: number;
  x?: number;
  y?: number;
  z?: number;
}

function quatEuler(x = 0, y = 0, z = 0): Quat {
  const qx = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, x);
  const qy = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, y);
  const qz = quatFromAxisAngle({ x: 0, y: 0, z: 1 }, z);
  return multiplyQuat(multiplyQuat(qz, qy), qx);
}

function rotTrack(joint: number, keys: AngleKey[]): AnyTrack {
  return rotationTrack(
    joint,
    keys.map((key) => ({ time: key.t, value: quatEuler(key.x, key.y, key.z) })),
    'slerp',
  );
}

function posTrack(joint: number, keys: VecKey[]): AnyTrack {
  return positionTrack(
    joint,
    keys.map((key) => ({
      time: key.t,
      value: { x: key.x ?? 0, y: key.y ?? 0, z: key.z ?? 0 },
    })),
  );
}

function angleAt(keys: AngleKey[], time: number, duration: number): AngleKey {
  const wrapped = duration > 0 ? ((time % duration) + duration) % duration : 0;
  let before = keys[0];
  let after = keys[0];
  for (const key of keys) {
    if (key.t <= wrapped) before = key;
  }
  for (const key of keys) {
    if (key.t >= wrapped) {
      after = key;
      break;
    }
  }
  if (before === after) return before;
  const span = after.t - before.t;
  const ratio = span <= 0 ? 0 : (wrapped - before.t) / span;
  const mix = (a = 0, b = 0): number => a + (b - a) * ratio;
  return {
    t: wrapped,
    x: mix(before.x, after.x),
    y: mix(before.y, after.y),
    z: mix(before.z, after.z),
  };
}

/**
 * 把左腿的周期关键帧平移到右腿（相位差半个周期），
 * 保证循环片段在 t=0 处也有精确取值，避免夹到末帧造成“节奏抖动”。
 */
function phaseShift(keys: AngleKey[], offset: number, duration: number): AngleKey[] {
  return keys.map((key) => {
    const time = (((key.t + offset) % duration) + duration) % duration;
    return { ...key, t: time };
  }).sort((a, b) => a.t - b.t);
}

function cycleKeys(keys: AngleKey[], duration: number, times: number[]): AngleKey[] {
  return times.map((t) => {
    const value = angleAt(keys, t, duration);
    return { t, x: value.x, y: value.y, z: value.z };
  });
}

/** 持枪瞄准姿势的固定关节角（弧度）；武器挂点用它反解补偿旋转。 */
export const AIM_STANCE = {
  upperArmR: { x: AIM_ARM_PITCH, y: 0.02, z: -0.1 },
  lowerArmR: { x: 0.16, y: -0.18, z: 0 },
  handR: { x: 0.12, y: 0, z: 0 },
  upperArmL: { x: AIM_ARM_PITCH + 0.08, y: -0.34, z: 0 },
  lowerArmL: { x: 0.55, y: -0.3, z: 0 },
  handL: { x: 0.16, y: 0, z: 0.22 },
  spine: { x: 0.05, y: 0, z: 0 },
  chest: { x: 0.06, y: 0, z: 0 },
  head: { x: -0.06, y: 0, z: 0 },
} as const;

interface ClipContext {
  skeleton: Skeleton;
  index: Record<HumanJoint, number>;
  masks: HumanMasks;
}

/**
 * 持枪姿势下“骰柱→胸→上臂→前臂→手”的累计旋转（与动画片段用同一套
 * quatEuler 构造顺序）。武器挂点取它的逆，枪管即沿角色正面（-Z）。
 * 用共轭而不是手工调欧拉角，避免旋转顺序耦合导致枪口歪斜。
 */
export function aimWeaponMountRotation(): Quat {
  const local = (value: { x?: number; y?: number; z?: number }): Quat =>
    quatEuler(value.x, value.y, value.z);
  const chain = multiplyQuat(
    multiplyQuat(
      multiplyQuat(
        multiplyQuat(local(AIM_STANCE.spine), local(AIM_STANCE.chest)),
        local(AIM_STANCE.upperArmR),
      ),
      local(AIM_STANCE.lowerArmR),
    ),
    local(AIM_STANCE.handR),
  );
  return conjugateQuat(chain);
}

function aimTracks(index: Record<HumanJoint, number>, duration: number): AnyTrack[] {
  const sway = (base: number, amplitude: number): AngleKey[] => [
    { t: 0, x: base },
    { t: duration * 0.5, x: base + amplitude },
    { t: duration, x: base },
  ];
  return [
    rotTrack(index.spine, sway(AIM_STANCE.spine.x, 0.01)),
    rotTrack(index.chest, [
      { t: 0, x: AIM_STANCE.chest.x, y: 0, z: 0 },
      { t: duration * 0.5, x: AIM_STANCE.chest.x + 0.015, y: 0.01, z: 0 },
      { t: duration, x: AIM_STANCE.chest.x, y: 0, z: 0 },
    ]),
    rotTrack(index.head, [
      { t: 0, x: AIM_STANCE.head.x, y: 0.01, z: 0 },
      { t: duration * 0.5, x: AIM_STANCE.head.x + 0.01, y: -0.015, z: 0 },
      { t: duration, x: AIM_STANCE.head.x, y: 0.01, z: 0 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, ...AIM_STANCE.upperArmR },
      { t: duration * 0.5, x: AIM_STANCE.upperArmR.x + 0.012, y: AIM_STANCE.upperArmR.y, z: AIM_STANCE.upperArmR.z },
      { t: duration, ...AIM_STANCE.upperArmR },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, ...AIM_STANCE.lowerArmR },
      { t: duration, ...AIM_STANCE.lowerArmR },
    ]),
    rotTrack(index.handR, [
      { t: 0, ...AIM_STANCE.handR },
      { t: duration, ...AIM_STANCE.handR },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, ...AIM_STANCE.upperArmL },
      { t: duration * 0.5, x: AIM_STANCE.upperArmL.x + 0.015, y: AIM_STANCE.upperArmL.y, z: AIM_STANCE.upperArmL.z },
      { t: duration, ...AIM_STANCE.upperArmL },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, ...AIM_STANCE.lowerArmL },
      { t: duration, ...AIM_STANCE.lowerArmL },
    ]),
    rotTrack(index.handL, [
      { t: 0, ...AIM_STANCE.handL },
      { t: duration, ...AIM_STANCE.handL },
    ]),
  ];
}

function angleKey(value: { x?: number; y?: number; z?: number }): { x: number; y: number; z: number } {
  return { x: value.x ?? 0, y: value.y ?? 0, z: value.z ?? 0 };
}

function walkClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = WALK_DURATION;
  const half = duration / 2;
  const legKeys: AngleKey[] = [
    { t: 0, x: 0.45 },
    { t: half * 0.5, x: 0.08 },
    { t: half, x: -0.4 },
    { t: half * 1.5, x: 0.06 },
    { t: duration, x: 0.45 },
  ];
  const kneeKeys: AngleKey[] = [
    { t: 0, x: -0.06 },
    { t: half * 0.5, x: -0.14 },
    { t: half, x: -0.3 },
    { t: half * 1.5, x: -0.92 },
    { t: duration, x: -0.06 },
  ];
  const footKeys: AngleKey[] = [
    { t: 0, x: 0.16 },
    { t: half * 0.5, x: 0 },
    { t: half, x: -0.24 },
    { t: half * 1.5, x: 0.18 },
    { t: duration, x: 0.16 },
  ];
  const samples = [0, half * 0.5, half, half * 1.5, duration];
  const rightLeg = cycleKeys(phaseShift(legKeys, half, duration), duration, samples);
  const rightKnee = cycleKeys(phaseShift(kneeKeys, half, duration), duration, samples);
  const rightFoot = cycleKeys(phaseShift(footKeys, half, duration), duration, samples);

  const tracks: AnyTrack[] = [
    rotTrack(index.upperLegL, legKeys),
    rotTrack(index.lowerLegL, kneeKeys),
    rotTrack(index.footL, footKeys),
    rotTrack(index.upperLegR, rightLeg),
    rotTrack(index.lowerLegR, rightKnee),
    rotTrack(index.footR, rightFoot),
    posTrack(index.pelvis, [
      { t: 0, y: HUMAN_DIMENSIONS.hipHeight - 0.016 },
      { t: half * 0.5, y: HUMAN_DIMENSIONS.hipHeight + 0.004 },
      { t: half, y: HUMAN_DIMENSIONS.hipHeight - 0.016 },
      { t: half * 1.5, y: HUMAN_DIMENSIONS.hipHeight + 0.004 },
      { t: duration, y: HUMAN_DIMENSIONS.hipHeight - 0.016 },
    ]),
    rotTrack(index.pelvis, [
      { t: 0, y: 0.07, z: 0.025 },
      { t: half, y: -0.07, z: -0.025 },
      { t: duration, y: 0.07, z: 0.025 },
    ]),
    rotTrack(index.spine, [
      { t: 0, x: 0.06, y: -0.03 },
      { t: half, x: 0.06, y: 0.03 },
      { t: duration, x: 0.06, y: -0.03 },
    ]),
    rotTrack(index.chest, [
      { t: 0, x: 0.02, y: -0.05 },
      { t: half, x: 0.02, y: 0.05 },
      { t: duration, x: 0.02, y: -0.05 },
    ]),
    rotTrack(index.head, [
      { t: 0, y: 0.04 },
      { t: half, y: -0.04 },
      { t: duration, y: 0.04 },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, x: -0.28, z: 0.05 },
      { t: half, x: 0.28, z: 0.05 },
      { t: duration, x: -0.28, z: 0.05 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, x: 0.28, z: -0.05 },
      { t: half, x: -0.28, z: -0.05 },
      { t: duration, x: 0.28, z: -0.05 },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, x: 0.32 },
      { t: duration, x: 0.32 },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, x: 0.32 },
      { t: duration, x: 0.32 },
    ]),
  ];

  return createClip({
    name: 'walk',
    duration,
    loop: true,
    tracks,
    jointCount: context.skeleton.joints.length,
    events: [
      { name: 'footstep', time: 0.02, payload: { foot: 'left', gait: 'walk' } },
      { name: 'footstep', time: half + 0.02, payload: { foot: 'right', gait: 'walk' } },
    ],
  });
}

function runClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = RUN_DURATION;
  const half = duration / 2;
  const legKeys: AngleKey[] = [
    { t: 0, x: 0.86 },
    { t: duration * 0.25, x: 0.18 },
    { t: half, x: -0.58 },
    { t: duration * 0.75, x: 0.24 },
    { t: duration, x: 0.86 },
  ];
  const kneeKeys: AngleKey[] = [
    { t: 0, x: -0.38 },
    { t: duration * 0.25, x: -0.5 },
    { t: half, x: -0.7 },
    { t: duration * 0.62, x: -1.55 },
    { t: duration * 0.82, x: -0.9 },
    { t: duration, x: -0.38 },
  ];
  const footKeys: AngleKey[] = [
    { t: 0, x: 0.22 },
    { t: duration * 0.25, x: -0.12 },
    { t: half, x: -0.34 },
    { t: duration * 0.75, x: 0.24 },
    { t: duration, x: 0.22 },
  ];
  const samples = [0, duration * 0.25, half, duration * 0.75, duration];
  const rightLeg = cycleKeys(phaseShift(legKeys, half, duration), duration, samples);
  const rightKnee = cycleKeys(phaseShift(kneeKeys, half, duration), duration, samples);
  const rightFoot = cycleKeys(phaseShift(footKeys, half, duration), duration, samples);

  const tracks: AnyTrack[] = [
    rotTrack(index.upperLegL, legKeys),
    rotTrack(index.lowerLegL, kneeKeys),
    rotTrack(index.footL, footKeys),
    rotTrack(index.upperLegR, rightLeg),
    rotTrack(index.lowerLegR, rightKnee),
    rotTrack(index.footR, rightFoot),
    posTrack(index.pelvis, [
      { t: 0, y: HUMAN_DIMENSIONS.hipHeight - 0.035 },
      { t: duration * 0.25, y: HUMAN_DIMENSIONS.hipHeight + 0.02 },
      { t: half, y: HUMAN_DIMENSIONS.hipHeight - 0.035 },
      { t: duration * 0.75, y: HUMAN_DIMENSIONS.hipHeight + 0.02 },
      { t: duration, y: HUMAN_DIMENSIONS.hipHeight - 0.035 },
    ]),
    rotTrack(index.pelvis, [
      { t: 0, y: 0.13, z: 0.05 },
      { t: half, y: -0.13, z: -0.05 },
      { t: duration, y: 0.13, z: 0.05 },
    ]),
    rotTrack(index.spine, [
      { t: 0, x: 0.18, y: -0.06 },
      { t: half, x: 0.18, y: 0.06 },
      { t: duration, x: 0.18, y: -0.06 },
    ]),
    rotTrack(index.chest, [
      { t: 0, x: -0.06, y: -0.1 },
      { t: half, x: -0.06, y: 0.1 },
      { t: duration, x: -0.06, y: -0.1 },
    ]),
    rotTrack(index.head, [
      { t: 0, x: -0.1, y: 0.05 },
      { t: half, x: -0.1, y: -0.05 },
      { t: duration, x: -0.1, y: 0.05 },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, x: -0.75, z: 0.12 },
      { t: half, x: 0.65, z: 0.12 },
      { t: duration, x: -0.75, z: 0.12 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, x: 0.65, z: -0.12 },
      { t: half, x: -0.75, z: -0.12 },
      { t: duration, x: 0.65, z: -0.12 },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, x: 1.05 },
      { t: half, x: 1.25 },
      { t: duration, x: 1.05 },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, x: 1.25 },
      { t: half, x: 1.05 },
      { t: duration, x: 1.25 },
    ]),
  ];

  return createClip({
    name: 'run',
    duration,
    loop: true,
    tracks,
    jointCount: context.skeleton.joints.length,
    events: [
      { name: 'footstep', time: 0.02, payload: { foot: 'left', gait: 'run' } },
      { name: 'footstep', time: half + 0.02, payload: { foot: 'right', gait: 'run' } },
    ],
  });
}

function idleClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = 4;
  const hip = HUMAN_DIMENSIONS.hipHeight;
  const tracks: AnyTrack[] = [
    posTrack(index.pelvis, [
      { t: 0, y: hip - 0.006 },
      { t: 1, y: hip + 0.004 },
      { t: 2, y: hip - 0.006 },
      { t: 3, y: hip + 0.004 },
      { t: duration, y: hip - 0.006 },
    ]),
    rotTrack(index.spine, [
      { t: 0, x: 0.03 },
      { t: 2, x: 0.055 },
      { t: duration, x: 0.03 },
    ]),
    rotTrack(index.chest, [
      { t: 0, x: 0.01 },
      { t: 2, x: 0.03 },
      { t: duration, x: 0.01 },
    ]),
    rotTrack(index.head, [
      { t: 0, y: 0.02 },
      { t: 1.4, y: -0.07 },
      { t: 2.8, y: 0.05 },
      { t: duration, y: 0.02 },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, x: 0.02, z: 0.06 },
      { t: 2, x: 0.05, z: 0.06 },
      { t: duration, x: 0.02, z: 0.06 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, x: 0.02, z: -0.06 },
      { t: 2, x: 0.05, z: -0.06 },
      { t: duration, x: 0.02, z: -0.06 },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, x: 0.16 },
      { t: duration, x: 0.16 },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, x: 0.16 },
      { t: duration, x: 0.16 },
    ]),
    rotTrack(index.upperLegL, [
      { t: 0, x: 0.02 },
      { t: duration, x: 0.02 },
    ]),
    rotTrack(index.upperLegR, [
      { t: 0, x: 0.02 },
      { t: duration, x: 0.02 },
    ]),
  ];
  return createClip({
    name: 'idle',
    duration,
    loop: true,
    tracks,
    jointCount: context.skeleton.joints.length,
  });
}

function aimClip(context: ClipContext): AnimationClip {
  const duration = 1.2;
  return createClip({
    name: 'aim',
    duration,
    loop: true,
    tracks: aimTracks(context.index, duration),
    jointCount: context.skeleton.joints.length,
  });
}

function fireClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = 0.24;
  // additive 增量：所有键在 t=0 与 t=duration 处都回到中性值，
  // 因此重复开火不会累积偏移，也不会影响 unmasked 的下半身。
  const tracks: AnyTrack[] = [
    rotTrack(index.chest, [
      { t: 0, x: 0 },
      { t: 0.03, x: 0.075 },
      { t: 0.1, x: 0.03 },
      { t: duration, x: 0 },
    ]),
    rotTrack(index.head, [
      { t: 0, x: 0 },
      { t: 0.03, x: 0.05 },
      { t: 0.12, x: 0.02 },
      { t: duration, x: 0 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, x: 0 },
      { t: 0.03, x: 0.13 },
      { t: 0.1, x: 0.05 },
      { t: duration, x: 0 },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, x: 0 },
      { t: 0.035, x: 0.1 },
      { t: 0.11, x: 0.04 },
      { t: duration, x: 0 },
    ]),
  ];
  return createClip({
    name: 'fire',
    duration,
    loop: false,
    tracks,
    jointCount: context.skeleton.joints.length,
    events: [{ name: 'muzzle', time: 0.02 }],
  });
}

function reloadClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = RELOAD_CLIP_DURATION;
  const tracks: AnyTrack[] = [
    rotTrack(index.spine, [
      { t: 0, ...angleKey(AIM_STANCE.spine) },
      { t: 0.5, x: 0.08, y: -0.06 },
      { t: 1.6, x: 0.1, y: -0.04 },
      { t: duration, ...angleKey(AIM_STANCE.spine) },
    ]),
    rotTrack(index.chest, [
      { t: 0, ...angleKey(AIM_STANCE.chest) },
      { t: 0.5, x: 0.14, z: -0.05 },
      { t: 1.6, x: 0.16, z: -0.04 },
      { t: duration, ...angleKey(AIM_STANCE.chest) },
    ]),
    rotTrack(index.head, [
      { t: 0, ...angleKey(AIM_STANCE.head) },
      { t: 0.6, x: -0.25, y: 0.18 },
      { t: 1.7, x: -0.22, y: 0.16 },
      { t: duration, ...angleKey(AIM_STANCE.head) },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, ...AIM_STANCE.upperArmR },
      { t: 0.45, x: 1.05, y: 0.05, z: -0.28 },
      { t: 1.5, x: 1.0, y: 0.05, z: -0.3 },
      { t: duration, ...AIM_STANCE.upperArmR },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, ...AIM_STANCE.lowerArmR },
      { t: 0.45, x: 0.72, y: -0.3 },
      { t: 1.5, x: 0.68, y: -0.34 },
      { t: duration, ...AIM_STANCE.lowerArmR },
    ]),
    rotTrack(index.handR, [
      { t: 0, ...AIM_STANCE.handR },
      { t: 0.45, x: -0.35, z: 0.3 },
      { t: 1.5, x: -0.3, z: 0.34 },
      { t: duration, ...AIM_STANCE.handR },
    ]),
    rotTrack(index.upperArmL, [
      { t: 0, ...AIM_STANCE.upperArmL },
      { t: 0.8, x: 0.72, y: -0.62, z: 0.12 },
      { t: 1.3, x: 0.62, y: -0.5, z: 0.1 },
      { t: duration, ...AIM_STANCE.upperArmL },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, ...AIM_STANCE.lowerArmL },
      { t: 0.8, x: 1.55, y: -0.5 },
      { t: 1.3, x: 1.25, y: -0.42 },
      { t: duration, ...AIM_STANCE.lowerArmL },
    ]),
    rotTrack(index.handL, [
      { t: 0, ...AIM_STANCE.handL },
      { t: 0.8, x: 0.1, y: 0.2, z: 0.4 },
      { t: 1.3, x: 0.12, y: 0.1, z: 0.3 },
      { t: duration, ...AIM_STANCE.handL },
    ]),
  ];
  return createClip({
    name: 'reload',
    duration,
    loop: true,
    tracks,
    jointCount: context.skeleton.joints.length,
  });
}

function deathClip(context: ClipContext): AnimationClip {
  const { index } = context;
  const duration = 1.25;
  const hip = HUMAN_DIMENSIONS.hipHeight;
  const tracks: AnyTrack[] = [
    // 骨盆向后倒（+X 旋转把躯干转向 +Z），同时下沉到地面高度。
    rotTrack(index.pelvis, [
      { t: 0, x: 0 },
      { t: 0.2, x: 0.35, z: 0.06 },
      { t: 0.55, x: 1.0, z: 0.12 },
      { t: 0.9, x: 1.42, z: 0.16 },
      { t: duration, x: 1.5, z: 0.18 },
    ]),
    posTrack(index.pelvis, [
      { t: 0, x: 0, y: hip, z: 0 },
      { t: 0.2, x: 0, y: hip - 0.16, z: 0.04 },
      { t: 0.55, x: 0, y: hip - 0.5, z: 0.16 },
      { t: 0.9, x: 0, y: 0.26, z: 0.3 },
      { t: duration, x: 0, y: 0.22, z: 0.34 },
    ]),
    rotTrack(index.spine, [
      { t: 0, x: 0.03 },
      { t: 0.5, x: -0.18 },
      { t: duration, x: -0.1 },
    ]),
    rotTrack(index.chest, [
      { t: 0, x: 0 },
      { t: 0.5, x: -0.22 },
      { t: duration, x: -0.12 },
    ]),
    rotTrack(index.head, [
      { t: 0, x: 0 },
      { t: 0.5, x: -0.35, z: 0.2 },
      { t: duration, x: -0.15, z: 0.28 },
    ]),
    // 双腿屈起，避免倒地后脚穿到地面以下。
    rotTrack(index.upperLegL, [
      { t: 0, x: 0.02 },
      { t: 0.3, x: 0.45 },
      { t: 0.75, x: 0.62, z: 0.12 },
      { t: duration, x: 0.55, z: 0.16 },
    ]),
    rotTrack(index.lowerLegL, [
      { t: 0, x: 0 },
      { t: 0.3, x: -0.9 },
      { t: 0.75, x: -1.5 },
      { t: duration, x: -1.35 },
    ]),
    rotTrack(index.footL, [
      { t: 0, x: 0 },
      { t: 0.4, x: 0.5 },
      { t: duration, x: 0.45 },
    ]),
    rotTrack(index.upperLegR, [
      { t: 0, x: 0.02 },
      { t: 0.28, x: 0.42 },
      { t: 0.72, x: 0.58, z: -0.1 },
      { t: duration, x: 0.5, z: -0.14 },
    ]),
    rotTrack(index.lowerLegR, [
      { t: 0, x: 0 },
      { t: 0.28, x: -0.8 },
      { t: 0.72, x: -1.4 },
      { t: duration, x: -1.28 },
    ]),
    rotTrack(index.footR, [
      { t: 0, x: 0 },
      { t: 0.4, x: 0.45 },
      { t: duration, x: 0.4 },
    ]),
    // 手臂外张，头与枪一起落地。
    rotTrack(index.upperArmL, [
      { t: 0, x: 0.02, z: 0.06 },
      { t: 0.25, x: 0.35, z: 0.6 },
      { t: 0.8, x: 0.2, z: 1.05 },
      { t: duration, x: 0.15, z: 1.1 },
    ]),
    rotTrack(index.lowerArmL, [
      { t: 0, x: 0.16 },
      { t: 0.4, x: 0.42 },
      { t: duration, x: 0.25 },
    ]),
    rotTrack(index.upperArmR, [
      { t: 0, x: 0 },
      { t: 0.25, x: 0.45, z: -0.45 },
      { t: 0.8, x: 0.2, z: -0.9 },
      { t: duration, x: 0.16, z: -0.95 },
    ]),
    rotTrack(index.lowerArmR, [
      { t: 0, x: 0.16 },
      { t: 0.4, x: 0.35 },
      { t: duration, x: 0.3 },
    ]),
  ];
  return createClip({
    name: 'death',
    duration,
    loop: false,
    tracks,
    jointCount: context.skeleton.joints.length,
    events: [{ name: 'death', time: 0.9 }],
  });
}

function aimPitchPoses(context: ClipContext): VelocityStop[] {
  const base = restPose(context.skeleton);
  const stops: Array<{ speed: number; clip: AnimationClip }> = [];
  const angles = [
    { speed: -0.9, chest: -0.35, head: -0.45, arm: -0.55 },
    { speed: 0, chest: 0, head: 0, arm: 0 },
    { speed: 0.9, chest: 0.3, head: 0.35, arm: 0.6 },
  ];
  for (const entry of angles) {
    const tracks: AnyTrack[] = [
      rotTrack(context.index.chest, [{ t: 0, x: entry.chest }]),
      rotTrack(context.index.head, [{ t: 0, x: entry.head }]),
      rotTrack(context.index.upperArmL, [{ t: 0, x: entry.arm }]),
      rotTrack(context.index.upperArmR, [{ t: 0, x: entry.arm }]),
    ];
    const clip = createClip({
      name: `aim-pitch:${entry.speed}`,
      duration: 0,
      loop: false,
      tracks,
      jointCount: context.skeleton.joints.length,
    });
    stops.push({ speed: entry.speed, clip });
  }
  return stops.map((entry) => ({
    speed: entry.speed,
    // 以 rest 为底采样：未写轨道的关节保留 rest 值，additive 增量才为 0，
    // 否则遮罩内的关节位置会被错误地归零（整条上半身塔缩到骨盆）。
    pose: sampleClip(entry.clip, 0, { loop: false, base }),
  }));
}

function crouchPose(context: ClipContext): Pose {
  const hip = HUMAN_DIMENSIONS.hipHeight;
  const tracks: AnyTrack[] = [
    posTrack(context.index.pelvis, [{ t: 0, x: 0, y: hip - 0.3, z: 0.05 }]),
    rotTrack(context.index.pelvis, [{ t: 0, x: -0.06 }]),
    rotTrack(context.index.spine, [{ t: 0, x: 0.14 }]),
    rotTrack(context.index.upperLegL, [{ t: 0, x: 0.62 }]),
    rotTrack(context.index.lowerLegL, [{ t: 0, x: -1.12 }]),
    rotTrack(context.index.footL, [{ t: 0, x: 0.5 }]),
    rotTrack(context.index.upperLegR, [{ t: 0, x: 0.62 }]),
    rotTrack(context.index.lowerLegR, [{ t: 0, x: -1.12 }]),
    rotTrack(context.index.footR, [{ t: 0, x: 0.5 }]),
  ];
  const clip = createClip({
    name: 'crouch',
    duration: 0,
    loop: false,
    tracks,
    jointCount: context.skeleton.joints.length,
  });
  return sampleClip(clip, 0, { loop: false, base: restPose(context.skeleton) });
}

/** 构建全部人体片段；同一个骨架只构建一次，供所有 CharacterView 共享。 */
export function createHumanClips(
  skeleton: Skeleton,
  index: Record<HumanJoint, number>,
  masks: HumanMasks,
): HumanClips {
  const context: ClipContext = { skeleton, index, masks };
  return {
    idle: idleClip(context),
    walk: walkClip(context),
    run: runClip(context),
    aim: aimClip(context),
    fire: fireClip(context),
    reload: reloadClip(context),
    death: deathClip(context),
    aimPitchStops: aimPitchPoses(context),
    crouchPose: crouchPose(context),
  };
}
