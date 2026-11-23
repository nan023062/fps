import type { Vec3 } from '../core/math';
import type { InputSnapshot } from '../core/input';
import { colliderBoxes, type LevelDefinition, type LevelSpawn } from '../world/level';
import { DUST_LEVEL } from '../world/map';
import { WorldCollider } from '../world/collision';
import { PlayerController } from '../player/player';
import type { PlayerControlSystem } from '../player/control';
import { intentFromInput, type ControlIntent } from '../player/intent';
import { eyePosition, type CharacterState } from '../player/state';
import { Bot, type BotWorld, type EnemyInfo } from '../ai/bot';
import { createNavGraph, type NavGraph } from '../ai/navgraph';
import { WEAPONS, consumeShot, currentSpread, startReload } from '../combat/weapons';
import { resolveShot, spreadDirection, type WorldRay } from '../combat/combat';
import { CombatDirector } from '../combat/combatDirector';
import type { GameEvent, HudState, ScoreRow, Team } from './types';

export const ROUND_TIME = 75;
export const ROUNDS_TO_WIN = 5;
export const ROUND_END_DELAY = 3.2;
const MAX_SHOT_DISTANCE = 150;

/**
 * 比赛编排层。
 *
 * 职责边界：
 * - 场景来自注入的 LevelDefinition（出生点、碰撞盒体、导航图），本文件不引用任何具体地图常量；
 * - 伤害、护甲、击杀归属、击杀信息与命中反馈由 CombatDirector 负责，Match 只调用并消费结果；
 * - 玩家移动/视角/蹲伏/碰撞由 PlayerControlSystem 负责：Match 只把输入映射成 ControlIntent、
 *   调用控制系统并消费 CharacterState（不自己算运动，也不设置相机或动画）；
 * - 回合状态机、比分与 3v3 人数判定仍由 Match 编排。
 */
export class Match {
  collider: WorldCollider;
  nav: NavGraph;
  readonly player: PlayerController;
  /** 玩家控制系统（表现层通过 Match 只读消费，不从别处拿控制状态）。 */
  readonly playerControl: PlayerControlSystem;
  readonly bots: Bot[];
  readonly combat: CombatDirector;
  level: LevelDefinition;
  phase: 'menu' | 'live' | 'roundOver' | 'matchOver' = 'menu';
  round = 0;
  scoreCT = 0;
  scoreT = 0;
  timeLeft = ROUND_TIME;
  roundWinner: Team | null = null;
  matchWinner: Team | null = null;
  events: GameEvent[] = [];

  private roundEndTimer = 0;
  private wasFiring = false;

  constructor(level: LevelDefinition = DUST_LEVEL) {
    this.level = level;
    this.collider = new WorldCollider(colliderBoxes(level));
    this.nav = createNavGraph(level);
    const ctSpawn = this.spawnAt('ct', 0);
    this.player = new PlayerController(ctSpawn.pos, ctSpawn.yaw);
    this.playerControl = this.player.control;
    this.bots = [
      this.createBot('Sable', 'ct', 1),
      this.createBot('Rook', 'ct', 2),
      this.createBot('Viper', 't', 0),
      this.createBot('Kestrel', 't', 1),
      this.createBot('Ash', 't', 2),
    ];
    this.combat = new CombatDirector([this.player, ...this.bots]);
  }

  /**
   * 切换/注入关卡：重建碰撞体与导航图，把角色挪到新关卡出生点并清空比赛状态。
   * 对局进行中切换会立即在新关卡重开一场比赛。
   */
  setLevel(level: LevelDefinition): void {
    const wasActive = this.phase === 'live' || this.phase === 'roundOver';
    this.level = level;
    this.collider = new WorldCollider(colliderBoxes(level));
    this.nav = createNavGraph(level);
    this.phase = 'menu';
    this.round = 0;
    this.scoreCT = 0;
    this.scoreT = 0;
    this.timeLeft = ROUND_TIME;
    this.roundWinner = null;
    this.matchWinner = null;
    this.roundEndTimer = 0;
    this.wasFiring = false;
    this.combat.reset();
    this.events = [];
    this.placeActorsAtSpawns();
    if (wasActive) this.startMatch();
  }

  startMatch(): void {
    this.scoreCT = 0;
    this.scoreT = 0;
    this.round = 0;
    this.roundWinner = null;
    this.matchWinner = null;
    this.combat.reset();
    this.events = [];
    this.startRound();
  }

  startRound(): void {
    this.round += 1;
    this.phase = 'live';
    this.timeLeft = ROUND_TIME;
    this.roundWinner = null;
    this.roundEndTimer = 0;
    this.wasFiring = false;
    this.combat.reset();
    this.placeActorsAtSpawns();
    this.events.push({ kind: 'roundStart', round: this.round });
  }

  update(dt: number, input: InputSnapshot): void {
    this.events.length = 0;
    this.combat.tick(dt);

    if (this.phase === 'menu' || this.phase === 'matchOver') return;

    if (this.phase === 'roundOver') {
      this.roundEndTimer -= dt;
      if (this.roundEndTimer <= 0) {
        if (this.matchWinner) {
          this.phase = 'matchOver';
          this.events.push({
            kind: 'matchEnd',
            winner: this.matchWinner,
            scoreCT: this.scoreCT,
            scoreT: this.scoreT,
          });
        } else {
          this.startRound();
        }
      }
      return;
    }

    this.timeLeft = Math.max(0, this.timeLeft - dt);

    if (this.player.alive) {
      // 输入 → 意图 → 控制系统：Match 只做编排，运动/视角/蹲伏/碰撞都在控制层。
      const intent = intentFromInput(input);
      this.player.applyIntent(intent, dt, this.collider);
      this.handlePlayerWeaponActions(intent);
      this.handlePlayerFire(intent.fire);
    }

    this.updateBots(dt);

    this.checkRoundEnd();
  }

  /** 对外只保留“谁对谁造成多少伤害”；结算与事件由 CombatDirector 产出。 */
  damageActor(targetId: string, rawDamage: number, headshot: boolean, attackerId: string): void {
    const outcome = this.combat.applyDamage({
      victimId: targetId,
      attackerId,
      rawDamage,
      headshot,
    });
    if (outcome.events.length > 0) {
      this.events.push(...outcome.events);
    }
  }

  /** 玩家控制状态（只读消费）：3C 契约的输入。 */
  get controlState(): CharacterState {
    return this.playerControl.state;
  }

  private handlePlayerWeaponActions(intent: ControlIntent): void {
    if (intent.switchWeapon) {
      this.player.switchWeapon(intent.switchWeapon);
    }
    const weapon = this.player.currentWeapon();
    if (intent.reload && startReload(weapon)) {
      this.player.syncWeaponState();
      this.events.push({ kind: 'reload' });
    }
    // 空仓扣扳机自动换弹：既有行为，弹匣/备弹规则仍在武器层。
    if (weapon.mag === 0 && !weapon.reloading && weapon.reserve > 0 && intent.fire) {
      if (startReload(weapon)) {
        this.player.syncWeaponState();
        this.events.push({ kind: 'reload' });
      }
    }
  }

  getView(): { position: Vec3; yaw: number; pitch: number; spectating: string | null } {
    const state = this.controlState;
    if (!state.dead) {
      return {
        position: eyePosition(state),
        yaw: state.yaw,
        pitch: state.pitch,
        spectating: null,
      };
    }
    const mate = this.findSpectator();
    if (mate) {
      return { position: mate.eyePosition(), yaw: mate.yaw, pitch: 0, spectating: mate.name };
    }
    return {
      position: { x: state.position.x, y: state.position.y + 1.6, z: state.position.z },
      yaw: state.yaw,
      pitch: 0,
      spectating: null,
    };
  }

  getHudState(): HudState {
    const weapon = this.player.currentWeapon();
    let banner = '';
    if (this.phase === 'live') {
      const elapsed = ROUND_TIME - this.timeLeft;
      if (elapsed < 2.6) {
        banner = this.round === 1 ? '第 1 回合 · 准备' : `第 ${this.round} 回合`;
      }
    } else if (this.phase === 'roundOver') {
      banner = this.roundWinner === 'ct' ? '反恐精英拿下本回合' : '恐怖分子拿下本回合';
    } else if (this.phase === 'matchOver') {
      banner = this.matchWinner === 'ct' ? '反恐精英胜利' : '恐怖分子胜利';
    }

    return {
      phase: this.phase,
      health: Math.ceil(this.player.health),
      armor: Math.ceil(this.player.armor),
      alive: this.player.alive,
      mag: weapon.mag,
      reserve: weapon.reserve,
      weaponName: WEAPONS[weapon.id].name,
      reloading: weapon.reloading,
      spread: currentSpread(weapon, this.player.speedRatio(), this.player.crouching, !this.player.grounded),
      scoreCT: this.scoreCT,
      scoreT: this.scoreT,
      round: this.round,
      timeLeft: Math.ceil(this.timeLeft),
      killFeed: this.combat.killFeed(),
      hitMarker: this.combat.hitMarker,
      damageFlash: this.combat.damageFlash,
      damageAngle: this.combat.damageAngle,
      banner,
      matchWinner: this.matchWinner,
      roundWinner: this.roundWinner,
      spectating: !this.player.alive ? this.findSpectator()?.name ?? null : null,
      scoreboard: this.scoreboardRows(),
    };
  }

  private handlePlayerFire(fire: boolean): void {
    const weapon = this.player.currentWeapon();
    const spec = WEAPONS[weapon.id];
    const trigger = fire && (spec.auto || !this.wasFiring);
    this.wasFiring = fire;
    if (!trigger || !consumeShot(weapon)) return;

    const eye = this.player.eyePosition();
    const spread = currentSpread(
      weapon,
      this.player.speedRatio(),
      this.player.crouching,
      !this.player.grounded,
    );
    const dir = spreadDirection(this.player.lookDirection(), spread);
    const targets = this.bots.filter((bot) => bot.team !== this.player.team).map((bot) => this.enemyInfo(bot));
    const worldRay: WorldRay = (origin, castDir, maxDist) =>
      this.collider.raycast(origin, castDir, maxDist)?.distance ?? null;
    const shot = resolveShot(eye, dir, MAX_SHOT_DISTANCE, this.player.id, targets, worldRay);

    this.events.push({ kind: 'shot', from: eye, to: shot.point, weapon: weapon.id, byPlayer: true });
    this.player.addRecoil(spec.recoilKick);
    if (shot.hitWorld) {
      this.events.push({ kind: 'impact', point: shot.point });
    }
    if (shot.targetId) {
      const raw = spec.damage * (shot.headshot ? spec.headshotMultiplier : 1);
      this.damageActor(shot.targetId, raw, shot.headshot, this.player.id);
    }
  }

  private updateBots(dt: number): void {
    const playerInfo = this.enemyInfo(this.player);
    const damage = (targetId: string, raw: number, headshot: boolean, attackerId: string): void => {
      this.damageActor(targetId, raw, headshot, attackerId);
    };

    for (const bot of this.bots) {
      if (!bot.alive) continue;
      const enemies: EnemyInfo[] = [];
      if (bot.team !== this.player.team && this.player.alive) {
        enemies.push(playerInfo);
      }
      for (const other of this.bots) {
        if (other !== bot && other.alive && other.team !== bot.team) {
          enemies.push(this.enemyInfo(other));
        }
      }
      const allies = this.bots
        .filter((other) => other.team === bot.team)
        .map((other) => ({ id: other.id, position: other.position }));
      const world: BotWorld = {
        collider: this.collider,
        nav: this.nav,
        enemies,
        allies,
        damage,
        events: this.events,
      };
      bot.update(dt, world);
    }
  }

  private enemyInfo(actor: PlayerController | Bot): EnemyInfo {
    const isPlayer = actor instanceof PlayerController;
    return {
      id: actor.id,
      team: actor.team,
      alive: actor.alive,
      position: actor.position,
      eye: isPlayer ? this.player.eyePosition() : (actor as Bot).eyePosition(),
      head: isPlayer ? this.player.headBox() : (actor as Bot).headBox(),
      body: isPlayer ? this.player.bodyBox() : (actor as Bot).bodyBox(),
      isPlayer,
    };
  }

  private checkRoundEnd(): void {
    if (this.phase !== 'live') return;
    const ctAlive = (this.player.alive ? 1 : 0) + this.bots.filter((b) => b.team === 'ct' && b.alive).length;
    const tAlive = this.bots.filter((b) => b.team === 't' && b.alive).length;
    if (ctAlive === 0 || tAlive === 0) {
      this.endRound(ctAlive > 0 ? 'ct' : 't');
      return;
    }
    if (this.timeLeft <= 0) {
      this.endRound('ct');
    }
  }

  private endRound(winner: Team): void {
    if (this.phase !== 'live') return;
    this.phase = 'roundOver';
    this.roundWinner = winner;
    if (winner === 'ct') {
      this.scoreCT += 1;
    } else {
      this.scoreT += 1;
    }
    if (this.scoreCT >= ROUNDS_TO_WIN || this.scoreT >= ROUNDS_TO_WIN) {
      this.matchWinner = this.scoreCT >= ROUNDS_TO_WIN ? 'ct' : 't';
    }
    this.roundEndTimer = ROUND_END_DELAY;
    this.events.push({
      kind: 'roundEnd',
      winner,
      scoreCT: this.scoreCT,
      scoreT: this.scoreT,
    });
  }

  private createBot(name: string, team: Team, spawnIndex: number): Bot {
    const spawn = this.spawnAt(team, spawnIndex);
    return new Bot(name, team, spawn.pos, spawn.yaw);
  }

  /** 出生点由关卡提供；人数多于出生点时按顺序循环复用，不依赖某张地图的数组长度。 */
  private spawnAt(team: Team, index: number): LevelSpawn {
    const spawns = this.level.spawns[team];
    if (spawns.length === 0) {
      return { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
    }
    return spawns[index % spawns.length];
  }

  /** 玩家占 CT 第 0 位，CT Bot 依次用第 1、2 位，T Bot 用 T 出生点 0–2。 */
  private placeActorsAtSpawns(): void {
    const playerSpawn = this.spawnAt('ct', 0);
    this.player.reset(playerSpawn.pos, playerSpawn.yaw);
    const ctBots = this.bots.filter((bot) => bot.team === 'ct');
    const tBots = this.bots.filter((bot) => bot.team === 't');
    ctBots.forEach((bot, index) => {
      const spawn = this.spawnAt('ct', index + 1);
      bot.reset(spawn.pos, spawn.yaw);
    });
    tBots.forEach((bot, index) => {
      const spawn = this.spawnAt('t', index);
      bot.reset(spawn.pos, spawn.yaw);
    });
  }

  private findSpectator(): Bot | null {
    return this.bots.find((bot) => bot.team === 'ct' && bot.alive) ?? null;
  }

  private scoreboardRows(): ScoreRow[] {
    const rows: ScoreRow[] = [
      {
        id: this.player.id,
        name: this.player.name,
        team: this.player.team,
        isPlayer: true,
        kills: this.player.kills,
        deaths: this.player.deaths,
        alive: this.player.alive,
      },
      ...this.bots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        team: bot.team,
        isPlayer: false,
        kills: bot.kills,
        deaths: bot.deaths,
        alive: bot.alive,
      })),
    ];
    rows.sort((a, b) => {
      if (a.team !== b.team) return a.team === 'ct' ? -1 : 1;
      return b.kills - a.kills;
    });
    return rows;
  }
}
