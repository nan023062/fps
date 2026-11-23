/**
 * 相机系统的纯数学工具：欧拉角与四元数、平滑插值、抖动噪声。
 *
 * 这里不依赖 Three.js 和 DOM，测试可直接在 Node 里运行。
 * 角度约定与 src/core/math 一致：yaw 0 看向 -Z，正 pitch 抬头。
 */
import { clamp, wrapAngle, type Vec3 } from '../../core/math';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const IDENTITY_QUATERNION: Quat = { x: 0, y: 0, z: 0, w: 1 };

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

/** Hamilton 积：a ⊗ b（先应用 b 再应用 a）。 */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-9) return { ...IDENTITY_QUATERNION };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/**
 * YXZ 顺序（先 yaw 再 pitch 再 roll）的欧拉角转四元数，
 * 与 Three.js 的 `camera.rotation.order = 'YXZ'` 一致。
 */
export function quatFromEuler(yaw: number, pitch: number, roll = 0): Quat {
  const hy = yaw * 0.5;
  const hp = pitch * 0.5;
  const hr = roll * 0.5;
  const qy = quat(0, Math.sin(hy), 0, Math.cos(hy));
  const qx = quat(Math.sin(hp), 0, 0, Math.cos(hp));
  const qz = quat(0, 0, Math.sin(hr), Math.cos(hr));
  return normalizeQuat(multiplyQuat(multiplyQuat(qy, qx), qz));
}

/** 相机朝向向量（yaw 0 看向 -Z，正 pitch 抬头），与 core/math 的约定一致。 */
export function forwardFromAngles(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/** 指数插值的本帧权重：halfLife 表示走完一半距离所需秒数。 */
export function smoothingAlpha(halfLife: number, dt: number): number {
  if (!(halfLife > 0)) return 1;
  if (dt <= 0) return 0;
  return 1 - Math.pow(0.5, dt / halfLife);
}

/** 指数插值（帧率无关）：current 朝 goal 收敛，永不过冲。 */
export function damp(current: number, goal: number, halfLife: number, dt: number): number {
  return current + (goal - current) * smoothingAlpha(halfLife, dt);
}

/** 角度插值：沿最短弧方向收敛，避免 ±π 处的抖动。 */
export function dampAngle(current: number, goal: number, halfLife: number, dt: number): number {
  return current + wrapAngle(goal - current) * smoothingAlpha(halfLife, dt);
}

/** 向量的指数插值，原地写入 out。 */
export function dampVec3(out: Vec3, goal: Vec3, halfLife: number, dt: number): Vec3 {
  const alpha = smoothingAlpha(halfLife, dt);
  out.x += (goal.x - out.x) * alpha;
  out.y += (goal.y - out.y) * alpha;
  out.z += (goal.z - out.z) * alpha;
  return out;
}

export function copyVec3Into(out: Vec3, source: Vec3): Vec3 {
  out.x = source.x;
  out.y = source.y;
  out.z = source.z;
  return out;
}

export function distanceVec3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * 确定性 value noise：同一 (seed, t) 永远得到同一值，取值域 [-1, 1]。
 * 抖动只在测试里需要可复现，因此不使用 Math.random。
 */
export function valueNoise(seed: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash01(i + seed * 57.13);
  const b = hash01(i + 1 + seed * 57.13);
  const u = f * f * (3 - 2 * f);
  return (a + (b - a) * u) * 2 - 1;
}

function hash01(n: number): number {
  const s = Math.sin(n * 12.9898) * 43758.5453123;
  return s - Math.floor(s);
}

export interface ShakeOffsets {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
}

export interface ShakeScale {
  position: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/** 默认抖动幅度：位置 3.5 cm、朝向 2° 量级，属于可感知但不影响瞄准的视觉抖动。 */
export const DEFAULT_SHAKE_SCALE: ShakeScale = {
  position: 0.035,
  yaw: 0.02,
  pitch: 0.02,
  roll: 0.045,
};

export function createShakeOffsets(): ShakeOffsets {
  return { position: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0 };
}

/**
 * 采样抖动偏移。幅度按 trauma² 缩放（trauma=0.5 只有满幅的 25%），
 * 四个通道用不同频率与种子，避免看起来像整体平移。
 */
export function sampleShake(
  trauma: number,
  time: number,
  out: ShakeOffsets = createShakeOffsets(),
  scale: ShakeScale = DEFAULT_SHAKE_SCALE,
): ShakeOffsets {
  const amplitude = clamp(trauma, 0, 1) ** 2;
  if (amplitude <= 0) {
    out.position.x = 0;
    out.position.y = 0;
    out.position.z = 0;
    out.yaw = 0;
    out.pitch = 0;
    out.roll = 0;
    return out;
  }
  out.position.x = valueNoise(1, time * 23) * amplitude * scale.position;
  out.position.y = valueNoise(2, time * 27) * amplitude * scale.position;
  out.position.z = valueNoise(3, time * 19) * amplitude * scale.position;
  out.yaw = valueNoise(4, time * 17) * amplitude * scale.yaw;
  out.pitch = valueNoise(5, time * 21) * amplitude * scale.pitch;
  out.roll = valueNoise(6, time * 13) * amplitude * scale.roll;
  return out;
}
