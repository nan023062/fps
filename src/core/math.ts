export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copy(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function lengthXZ(v: Vec3): number {
  return Math.hypot(v.x, v.z);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function distanceXZ(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len < 1e-8) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function wrapAngle(angle: number): number {
  return ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export function makeAabb(min: Vec3, max: Vec3): Aabb {
  return { min: copy(min), max: copy(max) };
}

export function aabbCenter(box: Aabb): Vec3 {
  return {
    x: (box.min.x + box.max.x) * 0.5,
    y: (box.min.y + box.max.y) * 0.5,
    z: (box.min.z + box.max.z) * 0.5,
  };
}

/** Slab test. Returns entry distance along a normalized direction, or null. */
export function rayAabb(origin: Vec3, dir: Vec3, box: Aabb, maxDist: number): number | null {
  let tmin = 0;
  let tmax = maxDist;
  const axes: Array<keyof Vec3> = ['x', 'y', 'z'];
  for (const axis of axes) {
    const o = origin[axis];
    const d = dir[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < box.min[axis] || o > box.max[axis]) {
        return null;
      }
      continue;
    }
    let t1 = (box.min[axis] - o) / d;
    let t2 = (box.max[axis] - o) / d;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

export function randomRange(min: number, max: number, random: () => number = Math.random): number {
  return min + (max - min) * random();
}

/** Camera-style forward vector: yaw 0 looks toward -Z, positive pitch looks up. */
export function directionFromAngles(yaw: number, pitch: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/** Yaw that faces the given world point from `from`. */
export function yawToPoint(from: Vec3, to: Vec3): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}
