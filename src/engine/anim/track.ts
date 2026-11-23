/**
 * 关键帧与轨道：三种插值（线性 / 阶梯 / 四元数 slerp）。
 *
 * 轨道只负责“在局部时间轴上求值”，循环、负时间与速度在 clip 层统一处理。
 */
import type { Quat, Vec3 } from './math';
import { copyQuat, lerpVec3, nlerpQuat, slerpQuat } from './math';

export type Interpolation = 'linear' | 'step' | 'slerp';

/** 轨道作用的姿态通道。rotation 通道按四元数插值，其余按向量插值。 */
export type TrackProperty = 'position' | 'rotation' | 'scale';

export interface Keyframe<T> {
  time: number;
  value: T;
}

export interface Track<T> {
  joint: number;
  property: TrackProperty;
  interpolation: Interpolation;
  keys: Keyframe<T>[];
}

export type Vec3Keyframe = Keyframe<Vec3>;
export type QuatKeyframe = Keyframe<Quat>;
export type Vec3Track = Track<Vec3>;
export type QuatTrack = Track<Quat>;
export type AnyTrack = Vec3Track | QuatTrack;

export function positionTrack(
  joint: number,
  keys: Vec3Keyframe[],
  interpolation: Interpolation = 'linear',
): Vec3Track {
  assertKeys(keys, 'position', interpolation);
  return { joint, property: 'position', interpolation, keys: keys.map(copyVec3Key) };
}

export function scaleTrack(
  joint: number,
  keys: Vec3Keyframe[],
  interpolation: Interpolation = 'linear',
): Vec3Track {
  assertKeys(keys, 'scale', interpolation);
  return { joint, property: 'scale', interpolation, keys: keys.map(copyVec3Key) };
}

export function rotationTrack(
  joint: number,
  keys: QuatKeyframe[],
  interpolation: Interpolation = 'slerp',
): QuatTrack {
  assertKeys(keys, 'rotation', interpolation);
  return { joint, property: 'rotation', interpolation, keys: keys.map(copyQuatKey) };
}

function assertKeys(
  keys: { time: number; value: unknown }[],
  property: TrackProperty,
  interpolation: Interpolation,
): void {
  if (!['linear', 'step', 'slerp'].includes(interpolation)) {
    throw new Error(`unsupported interpolation: ${String(interpolation)}`);
  }
  for (let i = 0; i < keys.length; i += 1) {
    if (!Number.isFinite(keys[i].time)) {
      throw new Error(`track ${property} has non finite key time at index ${i}`);
    }
    if (i > 0 && keys[i].time < keys[i - 1].time) {
      throw new Error(`track ${property} keys must be sorted by time`);
    }
  }
  if (property === 'rotation' && interpolation === 'linear') {
    // 允许：线性在四元数通道上退化为 nlerp，但 slerp 是推荐默认。
    return;
  }
}

function copyVec3Key(key: Vec3Keyframe): Vec3Keyframe {
  return { time: key.time, value: { x: key.value.x, y: key.value.y, z: key.value.z } };
}

function copyQuatKey(key: QuatKeyframe): QuatKeyframe {
  return { time: key.time, value: copyQuat(key.value) };
}

export function interpolationOf(track: AnyTrack): Interpolation {
  return track.interpolation;
}

/** 轨道最后一帧的时间；空轨道返回 0。 */
export function trackEnd(track: AnyTrack): number {
  const last = track.keys[track.keys.length - 1];
  return last ? last.time : 0;
}

/** 升序定位最后一个 time <= t 的关键帧下标；空轨道返回 -1。 */
function findKeyIndex(times: number[], time: number): number {
  let low = 0;
  let high = times.length - 1;
  let result = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= time) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

/**
 * 在局部时间轴上求值。
 * - 早于首帧 / 晚于末帧：夹到首帧 / 末帧（clamp）。
 * - step：持有前一帧值，跨过关键帧瞬间跳变。
 * - linear：向量线性插值；四元数通道用 nlerp。
 * - slerp：四元数最短弧插值；向量通道退化为线性。
 * - 空轨道返回 null，由调用方决定是否保留 rest 值。
 */
export function sampleTrackValue(track: AnyTrack, time: number): Vec3 | Quat | null {
  const keys = track.keys;
  if (keys.length === 0) {
    return null;
  }
  if (keys.length === 1 || time <= keys[0].time) {
    return cloneKeyValue(track, 0);
  }
  const lastIndex = keys.length - 1;
  if (time >= keys[lastIndex].time) {
    return cloneKeyValue(track, lastIndex);
  }
  const times = keys.map((key) => key.time);
  const index = findKeyIndex(times, time);
  if (index < 0) {
    return cloneKeyValue(track, 0);
  }
  const start = keys[index];
  const end = keys[index + 1];
  if (!end) {
    return cloneKeyValue(track, index);
  }
  if (track.interpolation === 'step') {
    return cloneKeyValue(track, index);
  }
  const span = end.time - start.time;
  const ratio = span <= 0 ? 0 : (time - start.time) / span;
  if (track.property === 'rotation') {
    const a = start.value as Quat;
    const b = end.value as Quat;
    return track.interpolation === 'slerp' ? slerpQuat(a, b, ratio) : nlerpQuat(a, b, ratio);
  }
  return lerpVec3(start.value as Vec3, end.value as Vec3, ratio);
}

function cloneKeyValue(track: AnyTrack, index: number): Vec3 | Quat {
  const value = track.keys[index].value;
  if (track.property === 'rotation') {
    return copyQuat(value as Quat);
  }
  const vec = value as Vec3;
  return { x: vec.x, y: vec.y, z: vec.z };
}
