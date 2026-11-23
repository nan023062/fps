import type { Aabb, Vec3 } from '../../core/math';
import { createCameraTarget, type CameraTarget, type SpectateCandidate } from './target';
import type { CameraPose, CameraSystem } from './system';

export function box(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): Aabb {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

export function makeTarget(overrides: Partial<CameraTarget> = {}): CameraTarget {
  const target = createCameraTarget();
  Object.assign(target, overrides);
  return target;
}

export function candidate(
  id: string,
  eye: Vec3,
  options: { alive?: boolean; yaw?: number; pitch?: number } = {},
): SpectateCandidate {
  return {
    id,
    eye: { ...eye },
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? 0,
    alive: options.alive ?? true,
  };
}

/** 连续推进若干固定帧，返回最后一帧姿态。 */
export function runFrames(
  system: CameraSystem,
  target: CameraTarget,
  frames: number,
  dt = 1 / 60,
): CameraPose {
  let pose = system.compute(dt, target);
  for (let i = 1; i < frames; i += 1) {
    pose = system.compute(dt, target);
  }
  return pose;
}
