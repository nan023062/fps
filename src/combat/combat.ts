import {
  add,
  cross,
  normalize,
  rayAabb,
  scale,
  type Vec3,
} from '../core/math';
import type { ShotResult, ShotTarget } from '../game/types';

export type WorldRay = (origin: Vec3, dir: Vec3, maxDist: number) => number | null;

function pointAt(origin: Vec3, dir: Vec3, distance: number): Vec3 {
  return {
    x: origin.x + dir.x * distance,
    y: origin.y + dir.y * distance,
    z: origin.z + dir.z * distance,
  };
}

/**
 * 先在盒体目标与世界中取最近命中，再比较先后。
 * 射手自身与非存活目标不参与命中。
 */
export function resolveShot(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  shooterId: string,
  targets: ShotTarget[],
  worldRay: WorldRay,
): ShotResult {
  const worldDistance = worldRay(origin, dir, maxDist);
  let best: { id: string; headshot: boolean; distance: number } | null = null;

  for (const target of targets) {
    if (!target.alive || target.id === shooterId) continue;
    const headT = rayAabb(origin, dir, target.head, maxDist);
    const bodyT = rayAabb(origin, dir, target.body, maxDist);
    if (headT !== null && (best === null || headT < best.distance)) {
      best = { id: target.id, headshot: true, distance: headT };
    }
    if (bodyT !== null && (best === null || bodyT < best.distance)) {
      best = { id: target.id, headshot: false, distance: bodyT };
    }
  }

  if (best !== null && (worldDistance === null || best.distance < worldDistance - 1e-3)) {
    return {
      targetId: best.id,
      headshot: best.headshot,
      point: pointAt(origin, dir, best.distance),
      distance: best.distance,
      hitWorld: false,
    };
  }

  const distance = worldDistance === null ? maxDist : worldDistance;
  return {
    targetId: null,
    headshot: false,
    point: pointAt(origin, dir, distance),
    distance,
    hitWorld: worldDistance !== null,
  };
}

/** 在锥形范围内随机偏转方向；spread 为半角弧度。 */
export function spreadDirection(dir: Vec3, spread: number, random: () => number = Math.random): Vec3 {
  if (spread <= 0) return dir;
  const up: Vec3 = Math.abs(dir.y) > 0.99 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(dir, up));
  const trueUp = normalize(cross(right, dir));
  const angle = spread * Math.sqrt(random());
  const phi = random() * Math.PI * 2;
  const offset = add(
    scale(right, Math.cos(phi) * Math.tan(angle)),
    scale(trueUp, Math.sin(phi) * Math.tan(angle)),
  );
  return normalize(add(dir, offset));
}

/** 护甲吸收最多 45% 的原始伤害，剩余由生命承担。 */
export function armorAbsorb(rawDamage: number, armor: number): { health: number; armorLoss: number } {
  if (armor <= 0) {
    return { health: rawDamage, armorLoss: 0 };
  }
  const absorbed = Math.min(armor, rawDamage * 0.45);
  return { health: rawDamage - absorbed, armorLoss: absorbed };
}

export interface DamageableState {
  health: number;
  armor: number;
}

export interface DamageApplication {
  /** 生命实际减少量（已扣除护甲吸收与下限截断）。 */
  healthLoss: number;
  armorLoss: number;
  /** 结算后的剩余生命。 */
  remainingHealth: number;
}

/**
 * 唯一一份“扣血 + 扣甲”结算：玩家、Bot 与 CombatDirector 都调用它，
 * 避免同一条护甲规则在多个文件里各写一遍。
 */
export function applyRawDamage(target: DamageableState, rawDamage: number): DamageApplication {
  if (!(rawDamage > 0)) {
    return { healthLoss: 0, armorLoss: 0, remainingHealth: target.health };
  }
  const before = target.health;
  const { health, armorLoss } = armorAbsorb(rawDamage, target.armor);
  target.armor = Math.max(0, target.armor - armorLoss);
  target.health = Math.max(0, before - health);
  return { healthLoss: before - target.health, armorLoss, remainingHealth: target.health };
}
