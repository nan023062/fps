/**
 * CharacterRenderState：控制层 → 渲染层的唯一输入（纯数据，不依赖 Three.js）。
 *
 * 这里只做“取值、夹取、派生参数”的纯函数工作，方便在 Node / Vitest 中
 * 完全离线地验证：状态 → 动画权重的映射、事件转发、死亡与退化行为。
 */
import { velocityWeights } from '../engine/anim';
import { LOCOMOTION_SPEEDS, locomotionTimeScale } from './clips';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export type CharacterTeam = 'ct' | 't';
export type CharacterWeaponId = 'rifle' | 'pistol';

/** 控制层每帧写入的快照；渲染层不得从别的渠道读位置/朝向。 */
export interface CharacterRenderState {
  /** 世界坐标（脚底）。 */
  position: Vec3Like;
  /** 朝向弧度（yaw 0 面向 -Z，与相机一致）。 */
  yaw: number;
  /** 水平移动速度（米/秒），由位置差除以 dt 得到。 */
  speed: number;
  /** 0–1 蹲伏量；Bot 当前没有蹲伏，保留该输入供玩家/后续使用。 */
  crouch: number;
  /** 垂直瞄准角（弧度，正为抬头）。 */
  aimPitch: number;
  alive: boolean;
  weaponId: CharacterWeaponId;
  team: CharacterTeam;
  /** 0–2 体型/护具变化。 */
  variant: number;
  /** 换弹进行中（来自 Match/Bot 的武器状态，只读）。 */
  reloading: boolean;
  /** 本帧是否刚开火（弹匣数下降的那一帧）。 */
  firing: boolean;
}

export type CharacterActionKind = 'footstep' | 'muzzle' | 'reload' | 'death';

/** 动画层产出、交给表现层消费的动作事件。 */
export interface CharacterActionEvent {
  kind: CharacterActionKind;
  /** 事件来源：片段名或状态机。 */
  source: 'idle' | 'walk' | 'run' | 'aim' | 'fire' | 'reload' | 'death' | 'state';
  foot?: 'left' | 'right';
  gait?: 'walk' | 'run';
  weaponId?: CharacterWeaponId;
  phase?: 'start' | 'end';
  speed?: number;
  /** 片段内的局部时间（秒）。 */
  at?: number;
}

export type CharacterAnimationMode = 'locomotion' | 'reload' | 'dead';

export interface CharacterAnimationParams {
  /** layer 0 locomotion 权重，和恒为 1（E1 velocityWeights 已归一化）。 */
  weights: { idle: number; walk: number; run: number };
  mode: CharacterAnimationMode;
  /** 上半身瞄准层权重（死亡时归零）。 */
  aimWeight: number;
  /** 换弹层权重（由渲染层再做时间平滑）。 */
  reloadWeight: number;
  crouch: number;
  aimPitch: number;
  speed: number;
  timeScale: number;
}

/** 控制层可提供的只读来源（Match 的 Bot 结构满足该形状）。 */
export interface RenderStateSource {
  position: Vec3Like;
  yaw: number;
  pitch: number;
  alive: boolean;
  team: CharacterTeam;
  weapon: { id: CharacterWeaponId; reloading: boolean };
}

export interface RenderStateExtras {
  speed?: number;
  crouch?: number;
  firing?: boolean;
  variant?: number;
}

const MAX_SPEED = 24;

export function createRenderState(
  team: CharacterTeam = 'ct',
  weaponId: CharacterWeaponId = 'rifle',
  variant = 0,
): CharacterRenderState {
  return {
    position: { x: 0, y: 0, z: 0 },
    yaw: 0,
    speed: 0,
    crouch: 0,
    aimPitch: 0,
    alive: true,
    weaponId,
    team,
    variant,
    reloading: false,
    firing: false,
  };
}

/** 位置差求速度（只算水平分量）；dt 非法时返回 0，避免 NaN 传进动画。
 * 单帧位移超过 3 米视为重生/传送，直接返回 0，避免瞬间触发跑步动画。 */
export function speedFromPositions(
  previous: Vec3Like | null | undefined,
  current: Vec3Like,
  dt: number,
): number {
  if (!previous || !Number.isFinite(dt) || dt <= 0) {
    return 0;
  }
  const dx = current.x - previous.x;
  const dz = current.z - previous.z;
  const distance = Math.hypot(dx, dz);
  if (!Number.isFinite(distance) || distance > 3) {
    return 0;
  }
  return Math.min(MAX_SPEED, distance / dt);
}

/** 把只读来源拷进状态对象（就地写，避免每帧分配）。 */
export function readRenderState(
  target: CharacterRenderState,
  source: RenderStateSource,
  extras: RenderStateExtras = {},
): CharacterRenderState {
  target.position.x = source.position.x;
  target.position.y = source.position.y;
  target.position.z = source.position.z;
  target.yaw = Number.isFinite(source.yaw) ? source.yaw : 0;
  target.aimPitch = Number.isFinite(source.pitch) ? source.pitch : 0;
  target.alive = source.alive;
  target.team = source.team;
  target.weaponId = source.weapon.id;
  target.reloading = source.weapon.reloading;
  target.speed = clampNumber(extras.speed ?? target.speed, 0, MAX_SPEED);
  target.crouch = clampNumber(extras.crouch ?? 0, 0, 1);
  target.firing = extras.firing ?? false;
  target.variant = extras.variant ?? target.variant;
  return target;
}

/**
 * 状态 → 动画参数：
 * - locomotion 权重来自 E1 velocityWeights（与 velocityBlend 使用同一套权重）；
 * - 死亡时上半身瞄准层归零，换弹层归零；
 * - speed 超过跑步标称速度时提高片段时间倍率，避免溜冰。
 */
export function animationParams(state: CharacterRenderState): CharacterAnimationParams {
  const speed = clampNumber(state.speed, 0, MAX_SPEED);
  const weights = velocityWeights(speed, [...LOCOMOTION_SPEEDS]);
  const alive = state.alive;
  return {
    weights: { idle: weights[0] ?? 1, walk: weights[1] ?? 0, run: weights[2] ?? 0 },
    mode: !alive ? 'dead' : state.reloading ? 'reload' : 'locomotion',
    aimWeight: alive ? 1 : 0,
    reloadWeight: alive && state.reloading ? 1 : 0,
    crouch: clampNumber(state.crouch, 0, 1),
    aimPitch: clampNumber(state.aimPitch, -1.2, 1.2),
    speed,
    timeScale: locomotionTimeScale(speed),
  };
}

/** 状态跳变事件：死亡与换弹开始/结束（片段自身的事件由 mixer 转发）。 */
export function transitionEvents(
  previous: Pick<CharacterRenderState, 'alive' | 'reloading'> | null,
  next: Pick<CharacterRenderState, 'alive' | 'reloading'>,
): CharacterActionEvent[] {
  if (!previous) {
    return [];
  }
  const events: CharacterActionEvent[] = [];
  if (previous.alive && !next.alive) {
    events.push({ kind: 'death', source: 'state' });
  }
  if (!previous.reloading && next.reloading) {
    events.push({ kind: 'reload', source: 'state', phase: 'start' });
  }
  if (previous.reloading && !next.reloading) {
    events.push({ kind: 'reload', source: 'state', phase: 'end' });
  }
  return events;
}

export function isReloading(state: CharacterRenderState): boolean {
  return state.alive && state.reloading;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min > 0 ? min : 0;
  }
  return Math.min(max, Math.max(min, value));
}
