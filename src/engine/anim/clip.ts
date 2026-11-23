/**
 * 动画片段：时长、循环策略、轨道与事件，以及按时间采样。
 *
 * 事件语义：只在“从 from 推进到 to”的区间内跨过时间点时才触发，
 * 因此同一次播放中同一事件只触发一次；循环时会按圈重复。
 */
import type { Pose } from './skeleton';
import {
  clonePose,
  copyPoseInto,
  ensurePoseLength,
  identityPose,
  poseJointCount,
} from './skeleton';
import type { AnyTrack } from './track';
import { sampleTrackValue, trackEnd } from './track';
import type { Quat, Vec3 } from './math';
import { copyQuat } from './math';

export type ClipEventPayload = Record<string, string | number | boolean>;

export interface ClipEvent {
  /** 语义名，例如 footstep / muzzle / reload。 */
  name: string;
  /** 相对片段起点的局部时间，秒。 */
  time: number;
  payload?: ClipEventPayload;
}

export interface AnimationClip {
  name: string;
  /** 片段时长，秒；0 表示静态/无时长片段。 */
  duration: number;
  /** 是否循环播放；采样与事件都遵守该默认值，可在调用处覆盖。 */
  loop: boolean;
  tracks: AnyTrack[];
  events: ClipEvent[];
  /** 轨道触及的最大关节数，用于分配 Pose。 */
  jointCount: number;
}

export interface ClipOptions {
  name?: string;
  duration?: number;
  loop?: boolean;
  tracks?: AnyTrack[];
  events?: ClipEvent[];
  jointCount?: number;
}

/** 创建片段：按时间排序事件、推导时长与关节数，不修改传入数组内容。 */
export function createClip(options: ClipOptions = {}): AnimationClip {
  const tracks = options.tracks ? [...options.tracks] : [];
  const events = (options.events ?? [])
    .map((event) => ({ ...event }))
    .sort((a, b) => a.time - b.time);
  for (const event of events) {
    if (!Number.isFinite(event.time)) {
      throw new Error(`clip event ${event.name} has non finite time`);
    }
  }
  const derivedDuration = tracks.reduce((max, track) => Math.max(max, trackEnd(track)), 0);
  const duration = options.duration ?? derivedDuration;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new Error(`clip duration must be a finite non negative number`);
  }
  const derivedJointCount = tracks.reduce((max, track) => Math.max(max, track.joint + 1), 0);
  const jointCount = options.jointCount ?? derivedJointCount;
  return {
    name: options.name ?? 'clip',
    duration,
    loop: options.loop ?? true,
    tracks,
    events,
    jointCount,
  };
}

/** 把任意时间折算到片段内：loop 取模（负数也折回正区间），否则夹到 [0, duration]。 */
export function wrapTime(time: number, duration: number, loop: boolean): number {
  if (!Number.isFinite(time)) {
    return 0;
  }
  if (duration <= 0) {
    return 0;
  }
  if (!loop) {
    return Math.min(Math.max(time, 0), duration);
  }
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
}

export interface SampleOptions {
  /** 覆盖 clip.loop。 */
  loop?: boolean;
  /** 时间缩放：effectiveTime = time * speed。 */
  speed?: number;
  /** 以该姿势为底（通常是 rest pose），未动画的关节保留其值。 */
  base?: Pose;
}

/**
 * 按时间采样片段，返回新的 Pose。
 * 未被任何轨道覆盖的关节：有 base 时保留 base，否则用中性值。
 */
export function sampleClip(clip: AnimationClip, time: number, options: SampleOptions = {}): Pose {
  const loop = options.loop ?? clip.loop;
  const speed = options.speed ?? 1;
  const base = options.base;
  const pose = base ? clonePose(base) : identityPose(clip.jointCount);
  const count = Math.max(clip.jointCount, base ? poseJointCount(base) : 0);
  ensurePoseLength(pose, count);
  const localTime = wrapTime(time * speed, clip.duration, loop);
  for (const track of clip.tracks) {
    const value = sampleTrackValue(track, localTime);
    if (value === null) {
      continue;
    }
    if (poseJointCount(pose) < track.joint + 1) {
      ensurePoseLength(pose, track.joint + 1);
    }
    writeTrackValue(pose, track.property, track.joint, value);
  }
  return pose;
}

function writeTrackValue(
  pose: Pose,
  property: AnyTrack['property'],
  joint: number,
  value: Vec3 | Quat,
): void {
  if (!pose.position[joint]) {
    pose.position[joint] = { x: 0, y: 0, z: 0 };
    pose.rotation[joint] = copyQuat({ x: 0, y: 0, z: 0, w: 1 });
    pose.scale[joint] = { x: 1, y: 1, z: 1 };
  }
  if (property === 'rotation') {
    pose.rotation[joint] = copyQuat(value as Quat);
    return;
  }
  const vec = value as Vec3;
  const target = property === 'position' ? pose.position[joint] : pose.scale[joint];
  target.x = vec.x;
  target.y = vec.y;
  target.z = vec.z;
}

/** 采样直接覆盖到外部 pose（避免每帧分配新数组）。 */
export function sampleClipInto(
  target: Pose,
  clip: AnimationClip,
  time: number,
  options: SampleOptions = {},
): Pose {
  const sampled = sampleClip(clip, time, { ...options, base: target });
  return copyPoseInto(target, sampled);
}

/** 已触发的事件（含片段内局部时间与播放轴上的发生时间）。 */
export interface FiredClipEvent {
  name: string;
  /** 片段内局部时间。 */
  time: number;
  /** 播放轴上的发生时间，用于排序与调试。 */
  at: number;
  clip: string;
  payload?: ClipEventPayload;
}

/**
 * 收集 (fromTime, toTime] 区间内跨过的事件。
 * loop=true 时按圈重复；fromTime === toTime 时不触发任何事件。
 */
export function eventsBetween(
  clip: AnimationClip,
  fromTime: number,
  toTime: number,
  loop: boolean,
): FiredClipEvent[] {
  const duration = clip.duration;
  if (clip.events.length === 0 || !(toTime > fromTime)) {
    return [];
  }
  const fired: FiredClipEvent[] = [];
  if (duration <= 0 || !loop) {
    for (const event of clip.events) {
      if (event.time > fromTime && event.time <= toTime) {
        fired.push(toFiredEvent(clip, event, event.time));
      }
    }
    fired.sort((a, b) => a.at - b.at);
    return fired;
  }
  for (const event of clip.events) {
    const first = Math.floor((fromTime - event.time) / duration + 1e-9) + 1;
    const last = Math.floor((toTime - event.time) / duration + 1e-9);
    for (let occurrence = first; occurrence <= last; occurrence += 1) {
      const at = event.time + occurrence * duration;
      if (at > fromTime && at <= toTime) {
        fired.push(toFiredEvent(clip, event, at));
      }
    }
  }
  fired.sort((a, b) => a.at - b.at);
  return fired;
}

function toFiredEvent(
  clip: AnimationClip,
  event: ClipEvent,
  at: number,
): FiredClipEvent {
  return {
    name: event.name,
    time: event.time,
    at,
    clip: clip.name,
    payload: event.payload ? { ...event.payload } : undefined,
  };
}

export function clipHasEvents(clip: AnimationClip): boolean {
  return clip.events.length > 0;
}
