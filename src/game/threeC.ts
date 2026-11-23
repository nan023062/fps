/**
 * 3C 契约：控制状态 → 渲染状态 / 相机目标的唯一映射（纯函数，无副作用）。
 *
 * 依赖方向严格单向：
 *   src/player（控制） → src/game/threeC（契约） → src/character/state、src/engine/camera/target（只取类型）
 * 控制层不知道 Three.js、动画与相机的存在；渲染/相机层只消费这里写出的纯数据。
 *
 * 这里的函数都是“就地写进调用方持有的对象”，避免每帧为每个角色分配新对象。
 */
import type {
  CharacterRenderState,
  CharacterTeam,
  CharacterWeaponId,
} from '../character/state';
import type { CameraTarget, SpectateCandidate, SpectateState } from '../engine/camera/target';
import { STAND_EYE_HEIGHT, horizontalSpeed, type CharacterState } from '../player/state';

/** 控制状态的正式别名：3C 契约的输入类型。 */
export type CharacterControlState = CharacterState;

/** 角色渲染状态里允许由表现层补充的量（速度可由控制状态自算，这里可覆盖）。 */
export interface RenderStateExtras {
  /** 水平速度（米/秒）；缺省时用控制状态的速度大小。 */
  speed?: number;
  /** 本帧是否刚开火（表现层根据弹匣下降判定）。 */
  firing?: boolean;
  /** 0–2 体型/护具变化；缺省保留目标对象原值。 */
  variant?: number;
}

/** 任意“可渲染角色”的姿态来源（Bot 结构满足它，控制状态也能适配）。 */
export interface ActorPoseSource {
  position: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  alive: boolean;
  team: CharacterTeam;
  weapon: { id: CharacterWeaponId; reloading: boolean };
}

const MAX_RENDER_SPEED = 24;

/** 相机目标里允许由表现层给出的纯表现量。 */
export interface CameraTargetExtras {
  /** 基础 FOV；缺省保留目标对象原值。 */
  fov?: number;
  /** 视觉后坐力偏移（弧度），玩法层不参与命中计算。 */
  recoil?: { pitch: number; yaw: number };
  /** 抖动能量 0..1。 */
  shake?: number;
  /** 观战状态；只有死亡时会被写入。 */
  spectate?: SpectateState | null;
}

/** 死亡后相机停在倒地位置的视点高度（米）。 */
export const DEATH_EYE_HEIGHT = 1.6;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min > 0 ? min : 0;
  return Math.min(max, Math.max(min, value));
}

/**
 * CharacterState → CharacterRenderState（就地写）。
 *
 * 覆盖验收要求的全部字段：位置、朝向、速度、蹲伏、瞄准、武器、存活、换弹、开火。
 * 队伍与体型属于身份信息，由调用方初始化的目标对象保留（不在这里改写归属）。
 */
export function applyCharacterRenderState(
  out: CharacterRenderState,
  state: CharacterState,
  extras: RenderStateExtras = {},
): CharacterRenderState {
  out.position.x = state.position.x;
  out.position.y = state.position.y;
  out.position.z = state.position.z;
  out.yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
  out.aimPitch = Number.isFinite(state.pitch) ? state.pitch : 0;
  out.speed = clampNumber(extras.speed ?? horizontalSpeed(state), 0, MAX_RENDER_SPEED);
  out.crouch = clampNumber(state.crouchAmount, 0, 1);
  out.alive = !state.dead;
  out.reloading = !state.dead && state.reloading;
  out.weaponId = state.weaponId;
  out.firing = extras.firing ?? false;
  if (extras.variant !== undefined) {
    out.variant = extras.variant;
  }
  return out;
}

/** 任意姿态来源（Bot 等非玩家角色）→ CharacterRenderState；玩家不经过这条路径。 */
export function applyActorRenderState(
  out: CharacterRenderState,
  actor: ActorPoseSource,
  extras: RenderStateExtras & { crouch?: number } = {},
): CharacterRenderState {
  out.position.x = actor.position.x;
  out.position.y = actor.position.y;
  out.position.z = actor.position.z;
  out.yaw = Number.isFinite(actor.yaw) ? actor.yaw : 0;
  out.aimPitch = Number.isFinite(actor.pitch) ? actor.pitch : 0;
  out.alive = actor.alive;
  out.team = actor.team;
  out.weaponId = actor.weapon.id;
  out.reloading = actor.alive && actor.weapon.reloading;
  out.speed = clampNumber(extras.speed ?? 0, 0, MAX_RENDER_SPEED);
  out.crouch = clampNumber(extras.crouch ?? 0, 0, 1);
  out.firing = extras.firing ?? false;
  if (extras.variant !== undefined) {
    out.variant = extras.variant;
  }
  return out;
}

/**
 * CharacterState → CameraTarget（就地写）。
 *
 * - 存活：eye 是站立视点（脚底 + 1.62，不含蹲伏下沉），蹲伏只通过 crouch 表达，
 *   由相机按 crouchDrop 下沉；CharacterState.eyeHeight 仍记录当前（蹲伏后的）视高，
 *   供第一人称视图模型与动画使用；
 * - 死亡：eye 落在倒地位置，alive=false，并把观战候选交给相机解算；
 * - recoil / shake / fov 是纯表现量，缺省时保留目标对象当前值（默认 0 / 原 FOV）。
 */
export function applyCameraTarget(
  out: CameraTarget,
  state: CharacterState,
  extras: CameraTargetExtras = {},
): CameraTarget {
  const alive = !state.dead;
  out.eye.x = state.position.x;
  out.eye.y = state.position.y + (alive ? STAND_EYE_HEIGHT : DEATH_EYE_HEIGHT);
  out.eye.z = state.position.z;
  out.yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
  out.pitch = Number.isFinite(state.pitch) ? state.pitch : 0;
  out.velocity.x = state.velocity.x;
  out.velocity.y = state.velocity.y;
  out.velocity.z = state.velocity.z;
  out.crouch = alive ? clampNumber(state.crouchAmount, 0, 1) : 0;
  out.recoil.pitch = extras.recoil?.pitch ?? 0;
  out.recoil.yaw = extras.recoil?.yaw ?? 0;
  out.shake = clampNumber(extras.shake ?? 0, 0, 1);
  if (extras.fov !== undefined) {
    out.fov = extras.fov;
  }
  out.alive = alive;
  out.spectate = alive ? null : (extras.spectate ?? null);
  return out;
}

/** 存活队友 → 观战状态；preferredId 失效时由相机回退到第一个存活目标。 */
export function buildSpectateState(
  allies: readonly SpectateCandidate[],
  preferredId: string | null,
): SpectateState {
  return { candidates: allies, preferredId };
}
