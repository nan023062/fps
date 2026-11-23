import { wrapAngle, type Vec3 } from '../core/math';
import type { GameEvent, HudKill, Team, WeaponId } from '../game/types';
import { applyRawDamage } from './combat';
import { WEAPONS } from './weapons';

/**
 * 战斗职责的唯一出口。
 *
 * 伤害结算、护甲吸收、击杀归属、击杀信息、命中反馈与击杀事件全部集中在这里；
 * Match 只负责回合编排，把命中结果交给 CombatDirector 并消费返回的结果。
 * 本文件保持纯逻辑：不 import Three.js、DOM 或任何具体关卡数据。
 */

/** 战斗参与者的最小契约：PlayerController 与 Bot 都按结构实现它。 */
export interface CombatActor {
  id: string;
  name: string;
  team: Team;
  alive: boolean;
  health: number;
  armor: number;
  kills: number;
  deaths: number;
  position: Vec3;
  /** 水平朝向（弧度），用于把受击方向换算到玩家视角。 */
  yaw: number;
  /** 当前手持武器，击杀信息用它取短名。 */
  weaponId: WeaponId;
  /** 玩家视角需要伤害闪屏与受击方向。 */
  isPlayer: boolean;
}

export interface DamageInput {
  victimId: string;
  attackerId: string;
  rawDamage: number;
  headshot: boolean;
  /** 产生这次伤害的武器；缺省时退回攻击者当前手持武器。 */
  weaponId?: WeaponId;
}

export interface DamageOutcome {
  /** 结算是否真的发生（目标不存在、已阵亡或伤害非正时为 false）。 */
  applied: boolean;
  victimId: string;
  attackerId: string;
  headshot: boolean;
  rawDamage: number;
  healthLoss: number;
  armorLoss: number;
  victimHealth: number;
  victimArmor: number;
  victimDied: boolean;
  killerName: string | null;
  victimName: string | null;
  weaponId: WeaponId | null;
  weaponShortName: string | null;
  /** 击杀信息文本；只有真正击杀时才有值。 */
  killFeedText: string | null;
  /** 需要由编排层转发给表现层的事件（hit / kill）。 */
  events: GameEvent[];
}

export const KILL_FEED_TTL = 5;
export const MAX_KILL_FEED = 4;

const HIT_MARKER_DECAY = 4;
const DAMAGE_FLASH_DECAY = 1.6;
const DAMAGE_FLASH_ON_HIT = 1;

export function weaponShortName(id: WeaponId): string {
  return WEAPONS[id].shortName;
}

function formatKillFeed(
  killerName: string,
  victimName: string,
  weaponId: WeaponId,
  headshot: boolean,
): string {
  return `${killerName}  [${weaponShortName(weaponId)}]  ${headshot ? '✪ ' : ''}${victimName}`;
}

export class CombatDirector {
  /** 玩家命中反馈（0–1），按时间衰减。 */
  hitMarker = 0;
  /** 玩家受击闪屏（0–1），按时间衰减。 */
  damageFlash = 0;
  /** 受击方向（弧度），相对于玩家朝向。 */
  damageAngle = 0;

  private feed: HudKill[] = [];
  private nextKillId = 1;

  constructor(private readonly actors: readonly CombatActor[]) {}

  actor(id: string): CombatActor | undefined {
    return this.actors.find((actor) => actor.id === id);
  }

  killFeed(): HudKill[] {
    return [...this.feed];
  }

  /** 回合切换/换关卡时清空击杀信息与瞬时反馈，避免上一回合的延迟状态污染新回合。 */
  reset(): void {
    this.feed = [];
    this.nextKillId = 1;
    this.hitMarker = 0;
    this.damageFlash = 0;
    this.damageAngle = 0;
  }

  /** 按时间积分衰减反馈与击杀信息（不按帧数）。 */
  tick(dt: number): void {
    this.hitMarker = Math.max(0, this.hitMarker - dt * HIT_MARKER_DECAY);
    this.damageFlash = Math.max(0, this.damageFlash - dt * DAMAGE_FLASH_DECAY);
    if (this.feed.length === 0) return;
    for (const kill of this.feed) kill.t -= dt;
    this.feed = this.feed.filter((kill) => kill.t > 0);
  }

  /**
   * 结算一次伤害：护甲吸收 → 扣血 → 阵亡判定 → 击杀归属 → 击杀信息 → 命中反馈事件。
   * 攻击者与受害者可以同队（自伤/友伤由调用方决定是否允许），归属规则本身不做队伍过滤。
   */
  applyDamage(input: DamageInput): DamageOutcome {
    const victim = this.actor(input.victimId);
    const attacker = this.actor(input.attackerId);
    const weaponId = input.weaponId ?? attacker?.weaponId ?? null;
    const outcome: DamageOutcome = {
      applied: false,
      victimId: input.victimId,
      attackerId: input.attackerId,
      headshot: input.headshot,
      rawDamage: input.rawDamage,
      healthLoss: 0,
      armorLoss: 0,
      victimHealth: victim?.health ?? 0,
      victimArmor: victim?.armor ?? 0,
      victimDied: false,
      killerName: attacker?.name ?? null,
      victimName: victim?.name ?? null,
      weaponId: weaponId ?? null,
      weaponShortName: weaponId ? weaponShortName(weaponId) : null,
      killFeedText: null,
      events: [],
    };

    if (!victim || !victim.alive || !(input.rawDamage > 0)) return outcome;

    const { healthLoss, armorLoss, remainingHealth } = applyRawDamage(victim, input.rawDamage);
    outcome.applied = true;
    outcome.healthLoss = healthLoss;
    outcome.armorLoss = armorLoss;
    outcome.victimHealth = remainingHealth;
    outcome.victimArmor = victim.armor;

    if (attacker?.isPlayer) {
      this.hitMarker = 1;
    }
    if (victim.isPlayer && attacker && attacker.id !== victim.id) {
      this.damageFlash = DAMAGE_FLASH_ON_HIT;
      this.damageAngle = wrapAngle(
        Math.atan2(attacker.position.x - victim.position.x, -(attacker.position.z - victim.position.z)) -
          victim.yaw,
      );
    }
    outcome.events.push({ kind: 'hit', headshot: input.headshot });

    if (remainingHealth <= 0) {
      victim.alive = false;
      victim.deaths += 1;
      outcome.victimDied = true;
      if (attacker) attacker.kills += 1;
      const text = formatKillFeed(
        attacker?.name ?? '未知',
        victim.name,
        weaponId ?? 'rifle',
        input.headshot,
      );
      outcome.killFeedText = text;
      this.pushKill(text);
      outcome.events.push({ kind: 'kill', text, headshot: input.headshot, byPlayer: attacker?.isPlayer ?? false });
    }

    return outcome;
  }

  private pushKill(text: string): void {
    this.feed.push({ id: this.nextKillId, text, t: KILL_FEED_TTL });
    this.nextKillId += 1;
    if (this.feed.length > MAX_KILL_FEED) this.feed.shift();
  }
}
