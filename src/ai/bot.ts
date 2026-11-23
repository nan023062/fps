import {
  clamp,
  distanceXZ,
  lerpAngle,
  normalize,
  yawToPoint,
  type Aabb,
  type Vec3,
} from '../core/math';
import type { WorldCollider } from '../world/collision';
import { applyRawDamage, resolveShot, spreadDirection, type WorldRay } from '../combat/combat';
import { WEAPONS, consumeShot, createWeapon, refillWeapon, updateWeapon } from '../combat/weapons';
import type { GameEvent, ShotTarget, Team, WeaponId, WeaponState } from '../game/types';
import type { NavGraph } from './navgraph';

export interface EnemyInfo extends ShotTarget {
  position: Vec3;
  eye: Vec3;
  isPlayer: boolean;
}

export interface BotWorld {
  collider: WorldCollider;
  /** 关卡注入的导航图；Bot 不再读取任何具体地图的模块级常量。 */
  nav: NavGraph;
  enemies: EnemyInfo[];
  allies: Array<{ id: string; position: Vec3 }>;
  /**
   * 伤害回调：命中结算、护甲、击杀归属与击杀信息由 CombatDirector 统一负责，
   * Bot 只上报“谁对谁造成了多少伤害”。
   */
  damage: (targetId: string, rawDamage: number, headshot: boolean, attackerId: string) => void;
  /**
   * 是否允许把伤害事件直接写进共享事件流；命中/击杀事件已由 CombatDirector 产出，
   * 这里只用于表现层使用的射击与弹着点事件。
   */
  events: GameEvent[];
}

const BOT_RADIUS = 0.38;
const BOT_HEIGHT = 1.8;
const BOT_EYE = 1.58;
const BOT_SPEED = 4.1;

let botSerial = 0;

export class Bot {
  readonly id: string;
  readonly name: string;
  readonly team: Team;
  readonly isPlayer = false;
  position: Vec3;
  yaw: number;
  pitch = 0;
  health = 100;
  armor = 50;
  alive = true;
  kills = 0;
  deaths = 0;
  weapon: WeaponState;
  private path: number[] = [];
  private pathIndex = 0;
  private fireTimer = 0;
  private targetId: string | null = null;
  private strafeDir = 1;
  private strafeTimer = 0;
  private readonly skill: number;

  constructor(name: string, team: Team, spawn: Vec3, yaw = 0, skill?: number) {
    this.id = `bot-${botSerial}`;
    botSerial += 1;
    this.name = name;
    this.team = team;
    this.position = { ...spawn };
    this.yaw = yaw;
    this.weapon = createWeapon('rifle');
    this.skill = skill ?? 0.35 + Math.random() * 0.35;
  }

  eyePosition(): Vec3 {
    return { x: this.position.x, y: this.position.y + BOT_EYE, z: this.position.z };
  }

  bodyBox(): Aabb {
    return {
      min: { x: this.position.x - 0.38, y: this.position.y, z: this.position.z - 0.38 },
      max: { x: this.position.x + 0.38, y: this.position.y + 1.42, z: this.position.z + 0.38 },
    };
  }

  headBox(): Aabb {
    return {
      min: { x: this.position.x - 0.22, y: this.position.y + 1.38, z: this.position.z - 0.22 },
      max: { x: this.position.x + 0.22, y: this.position.y + 1.8, z: this.position.z + 0.22 },
    };
  }

  /** 当前手持武器：击杀信息用它的短名，不再固定写死步枪。 */
  get weaponId(): WeaponId {
    return this.weapon.id;
  }

  update(dt: number, world: BotWorld): void {
    if (!this.alive) return;
    updateWeapon(this.weapon, dt);
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.8 + Math.random() * 1.2;
      this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    }

    const eye = this.eyePosition();
    let target: EnemyInfo | null = null;
    let bestScore = Infinity;
    for (const enemy of world.enemies) {
      if (!enemy.alive || enemy.team === this.team) continue;
      const dist = distanceXZ(this.position, enemy.position);
      if (dist > 55) continue;
      if (!world.collider.lineOfSight(eye, enemy.eye)) continue;
      const score = dist + (enemy.id === this.targetId ? -6 : 0);
      if (score < bestScore) {
        bestScore = score;
        target = enemy;
      }
    }
    this.targetId = target ? target.id : null;

    if (target) {
      this.engage(dt, world, target, eye);
    } else {
      this.advance(dt, world);
    }

    this.separate(world.collider, world.allies);
  }

  /**
   * 单角色直接扣血，仅供单元测试与工具使用。
   * 对局中的伤害、护甲吸收、击杀归属与击杀信息统一走 CombatDirector。
   */
  takeDamage(rawDamage: number): boolean {
    if (!this.alive) return false;
    const { remainingHealth } = applyRawDamage(this, rawDamage);
    if (remainingHealth <= 0) {
      this.alive = false;
      this.deaths += 1;
      return true;
    }
    return false;
  }

  reset(spawn: Vec3, yaw = 0): void {
    this.position = { ...spawn };
    this.yaw = yaw;
    this.pitch = 0;
    this.health = 100;
    this.armor = 50;
    this.alive = true;
    this.path = [];
    this.pathIndex = 0;
    this.fireTimer = 0;
    this.targetId = null;
    refillWeapon(this.weapon);
  }

  private engage(dt: number, world: BotWorld, target: EnemyInfo, eye: Vec3): void {
    const desiredYaw = yawToPoint(eye, target.eye);
    this.yaw = lerpAngle(this.yaw, desiredYaw, clamp(dt * 6, 0, 1));
    const dist = distanceXZ(this.position, target.position);
    const aimPitch = Math.atan2(target.eye.y - eye.y, Math.max(0.001, dist));
    this.pitch = clamp(lerpAngle(this.pitch, aimPitch, clamp(dt * 6, 0, 1)), -1.2, 1.2);

    const strafeX = Math.cos(this.yaw) * this.strafeDir;
    const strafeZ = -Math.sin(this.yaw) * this.strafeDir;
    const strafeStep = BOT_SPEED * 0.55 * dt;
    this.moveBy(strafeX * strafeStep, strafeZ * strafeStep, dt, world.collider);

    if (this.fireTimer > 0 || !consumeShot(this.weapon)) return;

    const aimDir = normalize({
      x: target.eye.x - eye.x,
      y: target.eye.y - eye.y,
      z: target.eye.z - eye.z,
    });
    const accuracy = 0.014 + (1 - this.skill) * 0.03 + dist * 0.0006;
    const dir = spreadDirection(aimDir, accuracy);
    const worldRay: WorldRay = (origin, castDir, maxDist) =>
      world.collider.raycast(origin, castDir, maxDist)?.distance ?? null;
    const shot = resolveShot(eye, dir, 120, this.id, world.enemies, worldRay);
    world.events.push({ kind: 'shot', from: eye, to: shot.point, weapon: 'rifle', byPlayer: false });
    if (shot.targetId) {
      const spec = WEAPONS[this.weapon.id];
      const raw = spec.damage * (shot.headshot ? spec.headshotMultiplier : 1) * 0.68;
      world.damage(shot.targetId, raw, shot.headshot, this.id);
    }
    if (shot.hitWorld) {
      world.events.push({ kind: 'impact', point: shot.point });
    }
    this.fireTimer = 0.4 + (1 - this.skill) * 0.35;
  }

  private advance(dt: number, world: BotWorld): void {
    const nav = world.nav;
    if (this.path.length === 0 || this.pathIndex >= this.path.length) {
      const from = nav.nearest(this.position);
      const destination = this.pickDestination(nav);
      this.path = from < 0 ? [] : nav.findPath(from, destination);
      this.pathIndex = 0;
      if (this.path.length === 0) return;
    }
    const target = nav.nodePosition(this.path[this.pathIndex]);
    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.9) {
      this.pathIndex += 1;
      return;
    }
    const dirX = dx / dist;
    const dirZ = dz / dist;
    this.yaw = lerpAngle(this.yaw, Math.atan2(-dirX, -dirZ), clamp(dt * 8, 0, 1));
    const step = Math.min(dist, BOT_SPEED * dt);
    this.moveBy(dirX * step, dirZ * step, dt, world.collider);
  }

  /** 目标池由注入的导航图按队伍推进方向生成，不再硬编码某张地图的节点下标。 */
  private pickDestination(nav: NavGraph): number {
    const pool = nav.patrolNodes(this.team);
    if (pool.length === 0) return nav.nearest(this.position);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private moveBy(dx: number, dz: number, dt: number, collider: WorldCollider): void {
    const result = collider.move(this.position, BOT_RADIUS, BOT_HEIGHT, {
      x: dx,
      y: -Math.min(0.5, 18 * dt),
      z: dz,
    });
    this.position = result.position;
  }

  private separate(collider: WorldCollider, allies: Array<{ id: string; position: Vec3 }>): void {
    for (const ally of allies) {
      if (ally.id === this.id) continue;
      const dx = this.position.x - ally.position.x;
      const dz = this.position.z - ally.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1.15 || dist < 1e-4) continue;
      const push = ((1.15 - dist) / dist) * 0.5;
      const result = collider.move(this.position, BOT_RADIUS, BOT_HEIGHT, {
        x: dx * push,
        y: 0,
        z: dz * push,
      });
      this.position = result.position;
    }
  }
}
