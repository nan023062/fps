/**
 * 空间音频：距离衰减数学、PannerNode 创建（HRTF → equalpower 回退）与 listener 更新。
 *
 * 本文件只接收数值，不 import 相机或玩法模块；调用方把相机姿态换算成
 * position / forward / up 三个向量传入即可。
 */
import type { ListenerState, SoundDef, Vec3Like } from './types';

export interface DistanceAttenuationOptions {
  readonly refDistance: number;
  readonly maxDistance: number;
  readonly rolloff: number;
}

const EPSILON = 1e-4;

/**
 * 反距离（inverse）衰减：refDistance 内不衰减，之后按 rolloff 滑向
 * ref/(ref+rolloff*(maxDistance-ref))，超出 maxDistance 不再变化。
 * 结果单调不增，便于测试与听感一致。
 */
export function distanceAttenuation(
  distance: number,
  options: DistanceAttenuationOptions,
): number {
  const refDistance = Math.max(EPSILON, options.refDistance);
  const maxDistance = Math.max(refDistance, options.maxDistance);
  const rolloff = Math.max(0, Number.isFinite(options.rolloff) ? options.rolloff : 0);
  const d = Number.isFinite(distance) ? Math.max(0, distance) : maxDistance;
  const clamped = Math.min(Math.max(d, refDistance), maxDistance);
  if (rolloff === 0) return 1;
  return refDistance / (refDistance + rolloff * (clamped - refDistance));
}

export function isFiniteVec3(value: Vec3Like | null | undefined): value is Vec3Like {
  return (
    !!value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

export function normalizeVec3(value: Vec3Like, fallback: Vec3Like): Vec3Like {
  if (!isFiniteVec3(value)) return { ...fallback };
  const length = Math.hypot(value.x, value.y, value.z);
  if (length < EPSILON) return { ...fallback };
  return { x: value.x / length, y: value.y / length, z: value.z / length };
}

export const DEFAULT_LISTENER: ListenerState = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: -1 },
  up: { x: 0, y: 1, z: 0 },
};

/** 由 yaw/pitch（弧度，与相机一致：0 朝向 -Z）得到前向量。 */
export function forwardFromAngles(yaw: number, pitch: number): Vec3Like {
  const cp = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
}

type ParamHost = Record<string, unknown>;

function assignParam(host: ParamHost, key: string, value: number): boolean {
  const param = host[key] as AudioParam | undefined;
  if (!param || typeof param.value !== 'number') return false;
  param.value = value;
  return true;
}

/**
 * 写入 AudioListener。优先 AudioParam（positionX/forwardX...），
 * 旧实现回退到 setPosition/setOrientation；任何失败都不抛异常。
 */
export function applyListener(ctx: AudioContext, state: ListenerState): boolean {
  const listener = ctx.listener as unknown as ParamHost;
  const position = isFiniteVec3(state.position) ? state.position : DEFAULT_LISTENER.position;
  const forward = normalizeVec3(state.forward, DEFAULT_LISTENER.forward);
  const up = normalizeVec3(state.up, DEFAULT_LISTENER.up);

  const wroteParams =
    assignParam(listener, 'positionX', position.x) &&
    assignParam(listener, 'positionY', position.y) &&
    assignParam(listener, 'positionZ', position.z) &&
    assignParam(listener, 'forwardX', forward.x) &&
    assignParam(listener, 'forwardY', forward.y) &&
    assignParam(listener, 'forwardZ', forward.z) &&
    assignParam(listener, 'upX', up.x) &&
    assignParam(listener, 'upY', up.y) &&
    assignParam(listener, 'upZ', up.z);
  if (wroteParams) return true;

  const legacy = listener as {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
  };
  try {
    legacy.setPosition?.(position.x, position.y, position.z);
    legacy.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 panner：HRTF 优先，不可用时回退 equalpower。
 * 返回 null 表示该环境无法创建 panner（降级为非空间化）。
 */
export function createVoicePanner(
  ctx: AudioContext,
  def: Pick<SoundDef, 'refDistance' | 'maxDistance' | 'rolloff' | 'panningModel'>,
  position?: Vec3Like,
): PannerNode | null {
  let panner: PannerNode;
  try {
    panner = ctx.createPanner();
  } catch {
    return null;
  }
  try {
    panner.panningModel = def.panningModel === 'equalpower' ? 'equalpower' : 'HRTF';
  } catch {
    try {
      panner.panningModel = 'equalpower';
    } catch {
      return null;
    }
  }
  try {
    panner.distanceModel = 'inverse';
    panner.refDistance = Math.max(EPSILON, def.refDistance);
    panner.maxDistance = Math.max(panner.refDistance, def.maxDistance);
    panner.rolloffFactor = Math.max(0, def.rolloff);
  } catch {
    // 个别实现缺少某个属性时保持默认值，继续可用。
  }
  if (position) setPannerPosition(panner, position);
  return panner;
}

/** 写入 panner 位置，优先 AudioParam，回退 setPosition。 */
export function setPannerPosition(panner: PannerNode, position: Vec3Like): void {
  const x = Number.isFinite(position.x) ? position.x : 0;
  const y = Number.isFinite(position.y) ? position.y : 0;
  const z = Number.isFinite(position.z) ? position.z : 0;
  const now = panner.context?.currentTime ?? 0;
  try {
    if (panner.positionX && panner.positionY && panner.positionZ) {
      panner.positionX.setTargetAtTime(x, now, 0.01);
      panner.positionY.setTargetAtTime(y, now, 0.01);
      panner.positionZ.setTargetAtTime(z, now, 0.01);
      return;
    }
  } catch {
    // 继续尝试 setPosition。
  }
  try {
    panner.setPosition(x, y, z);
  } catch {
    // 无可用写入通道时忽略，声音保持非空间化。
  }
}
