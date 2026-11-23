/**
 * 动画运行时的本地变换数学。
 *
 * 只依赖 src/core/math 的纯函数，不引入 Three.js / DOM / WebGL：
 * 动画层把变换求在普通数组上，渲染层再自行转成 Three.js 对象。
 */
import { clamp, lerp } from '../../core/math';
import type { Vec3 } from '../../core/math';

export type { Vec3 } from '../../core/math';
export { clamp, lerp } from '../../core/math';

/** 四元数，字段顺序与 three.js 一致（x/y/z/w）。 */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const IDENTITY_QUAT: Readonly<Quat> = { x: 0, y: 0, z: 0, w: 1 };

export function quat(x = 0, y = 0, z = 0, w = 1): Quat {
  return { x, y, z, w };
}

export function copyQuat(q: Quat): Quat {
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function dotQuat(a: Quat, b: Quat): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

/** 归一化；零长度退化为单位四元数，避免除以 0 产生 NaN。 */
export function normalizeQuat(q: Quat): Quat {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (len < 1e-8) {
    return copyQuat(IDENTITY_QUAT);
  }
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** 轴向角转四元数；axis 无需预先归一化。 */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const len = Math.hypot(axis.x, axis.y, axis.z);
  if (len < 1e-8) {
    return copyQuat(IDENTITY_QUAT);
  }
  const half = angle / 2;
  const s = Math.sin(half) / len;
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) };
}

/** 共轭；单位四元数的共轭即逆。 */
export function conjugateQuat(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** a ⊗ b，先应用 b 的旋转再应用 a。 */
export function multiplyQuat(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** 最短弧球面插值，t 自动夹到 [0, 1]。 */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  const k = clamp01(t);
  let cos = dotQuat(a, b);
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cos > 0.9995) {
    return normalizeQuat({
      x: a.x + (bx - a.x) * k,
      y: a.y + (by - a.y) * k,
      z: a.z + (bz - a.z) * k,
      w: a.w + (bw - a.w) * k,
    });
  }
  const theta = Math.acos(clamp(cos, -1, 1));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - k) * theta) / sinTheta;
  const wb = Math.sin(k * theta) / sinTheta;
  return {
    x: a.x * wa + bx * wb,
    y: a.y * wa + by * wb,
    z: a.z * wa + bz * wb,
    w: a.w * wa + bw * wb,
  };
}

/** 归一化线性插值，比 slerp 便宜，用于小角度混合。 */
export function nlerpQuat(a: Quat, b: Quat, t: number): Quat {
  const k = clamp01(t);
  const sign = dotQuat(a, b) < 0 ? -1 : 1;
  return normalizeQuat({
    x: lerp(a.x, b.x * sign, k),
    y: lerp(a.y, b.y * sign, k),
    z: lerp(a.z, b.z * sign, k),
    w: lerp(a.w, b.w * sign, k),
  });
}

export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  const k = clamp01(t);
  return {
    x: lerp(a.x, b.x, k),
    y: lerp(a.y, b.y, k),
    z: lerp(a.z, b.z, k),
  };
}

export function multiplyVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z };
}

/** 逐分量相除；除数为 0 时该分量按 1 处理，避免 NaN 扩散。 */
export function divideVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: Math.abs(b.x) < 1e-8 ? 1 : a.x / b.x,
    y: Math.abs(b.y) < 1e-8 ? 1 : a.y / b.y,
    z: Math.abs(b.z) < 1e-8 ? 1 : a.z / b.z,
  };
}

/** 四元数转欧拉角（YXZ，弧度）；仅用于调试与测试断言。 */
export function quatToEulerYXZ(q: Quat): { x: number; y: number; z: number } {
  const { x, y, z, w } = normalizeQuat(q);
  const m13 = 2 * (x * z + y * w);
  const m23 = 2 * (y * z - x * w);
  const m33 = 1 - 2 * (x * x + y * y);
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y + z * w);
  const pitch = Math.asin(clamp(m23, -1, 1));
  let yaw: number;
  let roll: number;
  if (Math.abs(m23) < 0.9999) {
    yaw = Math.atan2(-m13, m33);
    roll = Math.atan2(-m12, m11);
  } else {
    yaw = Math.atan2(2 * (x * z - y * w), 1 - 2 * (x * x + z * z));
    roll = 0;
  }
  return { x: roll, y: yaw, z: pitch };
}

/** 角度差（弧度），用于断言插值进度而不关心符号。 */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const d = Math.abs(dotQuat(normalizeQuat(a), normalizeQuat(b)));
  return 2 * Math.acos(clamp(d, -1, 1));
}
