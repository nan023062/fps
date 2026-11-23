/**
 * CameraTarget：相机的唯一输入。
 *
 * 纯数据、无 Three.js、无 DOM，也不含任何伤害/回合/武器规则；
 * 玩法层只负责把“角色当前长什么样”写进来，相机只负责消费。
 */
import { clamp } from '../../core/math';
import type { Vec3 } from '../../core/math';
import type { Quat } from './math';

export interface CameraRecoil {
  /** 抬头偏移（弧度），正值向上。 */
  pitch: number;
  /** 偏航偏移（弧度）。 */
  yaw: number;
}

export interface SpectateCandidate {
  /** 稳定标识（观战时用于“当前跟随谁”以及隐藏对应模型）。 */
  id: string;
  /** 目标眼睛位置（存活时为视点，死亡时为倒地位置）。 */
  eye: Vec3;
  yaw: number;
  pitch: number;
  alive: boolean;
}

export interface SpectateState {
  candidates: readonly SpectateCandidate[];
  /** 期望跟随的 id；失效（缺省或已死亡）时回退到下一个存活目标。 */
  preferredId: string | null;
}

export interface CameraTarget {
  /** 站立视点位置（不含蹲伏下沉，蹲伏由 `crouch` 表达）。 */
  eye: Vec3;
  yaw: number;
  pitch: number;
  /** 角色速度（米/秒），供相机做跟随/视差，不参与任何规则计算。 */
  velocity: Vec3;
  /** 0=站立 1=全蹲。相机按 crouchDrop 下沉视点。 */
  crouch: number;
  /** 玩法层给出的额外视角偏移（例如开火后坐力）。 */
  recoil: CameraRecoil;
  /** 抖动强度 trauma，0..1；相机内部按 trauma² 取幅度。 */
  shake: number;
  /** 期望基础 FOV。 */
  fov: number;
  alive: boolean;
  /** 观战状态；死亡时给出候选队友，全部失效时回退到 eye（死亡位置）。 */
  spectate: SpectateState | null;
}

export interface CameraTargetInit extends Partial<Omit<CameraTarget, 'eye' | 'velocity' | 'recoil'>> {
  eye?: Partial<Vec3>;
  velocity?: Partial<Vec3>;
  recoil?: Partial<CameraRecoil>;
}

export const DEFAULT_CAMERA_FOV = 74;

export function createCameraTarget(init: CameraTargetInit = {}): CameraTarget {
  const eye = init.eye ?? {};
  const velocity = init.velocity ?? {};
  const recoil = init.recoil ?? {};
  return {
    eye: { x: eye.x ?? 0, y: eye.y ?? 1.62, z: eye.z ?? 0 },
    yaw: init.yaw ?? 0,
    pitch: init.pitch ?? 0,
    velocity: { x: velocity.x ?? 0, y: velocity.y ?? 0, z: velocity.z ?? 0 },
    crouch: init.crouch ?? 0,
    recoil: { pitch: recoil.pitch ?? 0, yaw: recoil.yaw ?? 0 },
    shake: init.shake ?? 0,
    fov: init.fov ?? DEFAULT_CAMERA_FOV,
    alive: init.alive ?? true,
    spectate: init.spectate ?? null,
  };
}

/** 把 target 归零到“站在原点看向 -Z 的活人”，便于跨回合/跨关卡复用同一个对象。 */
export function resetCameraTarget(target: CameraTarget): CameraTarget {
  target.eye.x = 0;
  target.eye.y = 1.62;
  target.eye.z = 0;
  target.yaw = 0;
  target.pitch = 0;
  target.velocity.x = 0;
  target.velocity.y = 0;
  target.velocity.z = 0;
  target.crouch = 0;
  target.recoil.pitch = 0;
  target.recoil.yaw = 0;
  target.shake = 0;
  target.fov = DEFAULT_CAMERA_FOV;
  target.alive = true;
  target.spectate = null;
  return target;
}

/**
 * 解算当前应跟随的观战目标。
 *
 * 顺序：preferredId 且存活 → 候选列表里第一个存活目标 → null（调用方回退到死亡位置）。
 * 候选列表顺序由调用方固定，因此结果可确定复现。
 */
export function resolveSpectateTarget(state: SpectateState | null): SpectateCandidate | null {
  if (!state || state.candidates.length === 0) return null;
  const preferred = state.preferredId;
  if (preferred !== null) {
    for (const candidate of state.candidates) {
      if (candidate.id === preferred) {
        if (candidate.alive) return candidate;
        break;
      }
    }
  }
  for (const candidate of state.candidates) {
    if (candidate.alive) return candidate;
  }
  return null;
}

/** 下一个存活观战目标（用于“切换队友”）；当前目标失效时也会前进一位。 */
export function nextSpectateTarget(
  candidates: readonly SpectateCandidate[],
  currentId: string | null,
): SpectateCandidate | null {
  const alive = candidates.filter((candidate) => candidate.alive);
  if (alive.length === 0) return null;
  if (currentId === null) return alive[0];
  const index = alive.findIndex((candidate) => candidate.id === currentId);
  if (index < 0) return alive[0];
  return alive[(index + 1) % alive.length];
}

/** 归一化蹲伏量，避免调用方传入越界值导致视点穿地/漂浮。 */
export function crouchAmount(target: CameraTarget): number {
  return clamp(target.crouch, 0, 1);
}

/** 目标姿态对应的四元数由相机输出，这里仅导出类型别名方便调用方标注。 */
export type CameraQuaternion = Quat;
