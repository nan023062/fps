/**
 * CharacterState：角色控制的唯一可写状态（纯数据，不依赖 Three.js / DOM）。
 *
 * 这里只放“角色当前长什么样”的事实 + 显式状态转换函数：
 * - 位置、速度、视角（yaw/pitch）、碰撞盒高度与视高；
 * - 地面 / 空中（airborne = !grounded）、蹲伏量、死亡、换弹、手持武器；
 * - 落地、起跳、蹲下、死亡、重生等转换只通过下面的函数修改，避免各处手改字段。
 *
 * 手感数值（速度、跳跃、蹲伏视高）从这里导出，马达只读取、不重新定义。
 */
import { clamp, vec3, type Vec3 } from '../core/math';
import type { WeaponId } from '../game/types';

/** 站立碰撞盒高度（米）。 */
export const STAND_HEIGHT = 1.8;
/** 全蹲碰撞盒高度（米）。 */
export const CROUCH_HEIGHT = 1.2;
/** 站立视高（米，脚底到眼睛）。 */
export const STAND_EYE_HEIGHT = 1.62;
/** 全蹲时视点下沉量（米）；1.62 - 0.52 = 1.1。 */
export const CROUCH_EYE_DROP = 0.52;
/** 蹲伏量每秒变化速度（1/秒），即约 0.14 秒完成站立↔全蹲。 */
export const CROUCH_RATE = 7;
/** 抬头/低头极限（弧度），约 ±83°。 */
export const PITCH_LIMIT = 1.45;

export interface CharacterState {
  /** 脚底世界坐标（米）。 */
  position: Vec3;
  /** 速度（米/秒，世界坐标）。 */
  velocity: Vec3;
  /** 水平朝向（弧度，0 面向 -Z，与相机一致）。 */
  yaw: number;
  /** 垂直瞄准角（弧度，正为抬头）。 */
  pitch: number;
  /** 碰撞盒高度（米），随蹲伏量插值。 */
  height: number;
  /** 视点相对脚底的高度（米），随蹲伏量插值。 */
  eyeHeight: number;
  /** 0=站立 1=全蹲（平滑值；碰撞盒与视高都用它）。 */
  crouchAmount: number;
  /** 蹲伏键是否按住（决定目标速度，未平滑）。 */
  crouchHeld: boolean;
  /** 是否站在地面上；false 即 airborne。 */
  grounded: boolean;
  /** 已阵亡（不可移动、不可开火）。 */
  dead: boolean;
  /** 换弹进行中（由武器层同步过来的只读镜像）。 */
  reloading: boolean;
  weaponId: WeaponId;
}

export function createCharacterState(spawn: Vec3, yaw = 0): CharacterState {
  return {
    position: { ...spawn },
    velocity: vec3(),
    yaw,
    pitch: 0,
    height: STAND_HEIGHT,
    eyeHeight: STAND_EYE_HEIGHT,
    crouchAmount: 0,
    crouchHeld: false,
    grounded: true,
    dead: false,
    reloading: false,
    weaponId: 'rifle',
  };
}

/** 蹲伏量对应的碰撞盒高度；夹取到 0..1，避免脏值撑破盒体。 */
export function heightForCrouch(crouchAmount: number): number {
  const t = clamp(Number.isFinite(crouchAmount) ? crouchAmount : 0, 0, 1);
  return STAND_HEIGHT - (STAND_HEIGHT - CROUCH_HEIGHT) * t;
}

/** 蹲伏量对应的视高；站立 1.62，全蹲 1.10。 */
export function eyeHeightForCrouch(crouchAmount: number): number {
  const t = clamp(Number.isFinite(crouchAmount) ? crouchAmount : 0, 0, 1);
  return STAND_EYE_HEIGHT - CROUCH_EYE_DROP * t;
}

/** 把蹲伏量同步到 height / eyeHeight（任何改 crouchAmount 的路径都要过这里）。 */
export function applyStance(state: CharacterState): CharacterState {
  state.crouchAmount = clamp(Number.isFinite(state.crouchAmount) ? state.crouchAmount : 0, 0, 1);
  state.height = heightForCrouch(state.crouchAmount);
  state.eyeHeight = eyeHeightForCrouch(state.crouchAmount);
  return state;
}

/**
 * 蹲下/站起：把 crouchAmount 按 CROUCH_RATE 线性逼近目标，并刷新盒体与视高。
 * 返回是否发生了变化，便于调用方判断（不影响手感数值本身）。
 */
export function updateCrouch(
  state: CharacterState,
  dt: number,
  crouchHeld: boolean,
  rate = CROUCH_RATE,
): boolean {
  state.crouchHeld = crouchHeld;
  if (state.dead) {
    return false;
  }
  const target = crouchHeld ? 1 : 0;
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) * rate;
  const before = state.crouchAmount;
  state.crouchAmount = clamp(
    state.crouchAmount + clamp(target - state.crouchAmount, -step, step),
    0,
    1,
  );
  applyStance(state);
  return state.crouchAmount !== before;
}

/** 落地转换：贴地、清掉向下的速度，并保留水平动量。 */
export function landCharacter(state: CharacterState): CharacterState {
  state.grounded = true;
  if (state.velocity.y < 0) {
    state.velocity.y = 0;
  }
  return state;
}

/** 起跳转换：给跳跃冲量并标记离地。冲量由马达配置决定，这里只做状态切换。 */
export function launchCharacter(state: CharacterState, jumpSpeed: number): CharacterState {
  state.velocity.y = jumpSpeed;
  state.grounded = false;
  return state;
}

/** 蹲下开关（直接设目标蹲伏量，平滑仍由 updateCrouch 负责）。 */
export function setCrouch(state: CharacterState, crouchAmount: number): CharacterState {
  state.crouchAmount = crouchAmount;
  return applyStance(state);
}

/** 死亡转换：停止移动输入相关量，保留倒地位置供观战/复活使用。 */
export function killCharacter(state: CharacterState): CharacterState {
  state.dead = true;
  state.reloading = false;
  state.crouchHeld = false;
  state.velocity = vec3();
  return state;
}

/** 重生转换：回到出生点、满状态、站立视角。 */
export function respawnCharacter(
  state: CharacterState,
  spawn: Vec3,
  yaw = 0,
  weaponId: WeaponId = 'rifle',
): CharacterState {
  state.position = { ...spawn };
  state.velocity = vec3();
  state.yaw = yaw;
  state.pitch = 0;
  state.crouchAmount = 0;
  state.crouchHeld = false;
  state.grounded = true;
  state.dead = false;
  state.reloading = false;
  state.weaponId = weaponId;
  return applyStance(state);
}

/** 视角增量应用（弧度）；pitch 夹取到 PITCH_LIMIT，yaw 不做环绕裁剪（与既有手感一致）。 */
export function applyLookDelta(state: CharacterState, yawDelta: number, pitchDelta: number): CharacterState {
  const yaw = Number.isFinite(yawDelta) ? yawDelta : 0;
  const pitch = Number.isFinite(pitchDelta) ? pitchDelta : 0;
  state.yaw += yaw;
  state.pitch = clamp(state.pitch + pitch, -PITCH_LIMIT, PITCH_LIMIT);
  return state;
}

/** 视点世界坐标：脚底 + 当前视高。 */
export function eyePosition(state: CharacterState): Vec3 {
  return { x: state.position.x, y: state.position.y + state.eyeHeight, z: state.position.z };
}

/** 水平速度占跑速比例（0..1），供扩散与动画使用。 */
export function speedRatio(state: CharacterState, runSpeed: number): number {
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  if (!Number.isFinite(speed) || runSpeed <= 0) {
    return 0;
  }
  return clamp(speed / runSpeed, 0, 1);
}

/** 水平速度（米/秒），动画与 3C 契约使用。 */
export function horizontalSpeed(state: CharacterState): number {
  const speed = Math.hypot(state.velocity.x, state.velocity.z);
  return Number.isFinite(speed) ? speed : 0;
}

/** airborne 是 grounded 的派生状态，不单独存字段以免两份事实不一致。 */
export function isAirborne(state: CharacterState): boolean {
  return !state.grounded;
}
