/**
 * 把 CameraPose 写进渲染相机。
 *
 * 用结构化接口而不是 import three，保证相机模块本身（含测试）不依赖 WebGL/Three。
 */
import type { CameraPose } from './system';

export interface CameraLike {
  position: { set(x: number, y: number, z: number): void };
  quaternion: { set(x: number, y: number, z: number, w: number): void };
  fov: number;
  updateProjectionMatrix(): void;
}

export function applyCameraPose(camera: CameraLike, pose: CameraPose): void {
  camera.position.set(pose.position.x, pose.position.y, pose.position.z);
  camera.quaternion.set(pose.quaternion.x, pose.quaternion.y, pose.quaternion.z, pose.quaternion.w);
  if (Math.abs(camera.fov - pose.fov) > 1e-4) {
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
  }
}
