import type { Aabb, Vec3 } from '../core/math';

export type Team = 'ct' | 't';
export type WeaponId = 'rifle' | 'pistol';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** HUD 与击杀信息使用的短名，避免把完整枪名塞进击杀横幅。 */
  shortName: string;
  damage: number;
  headshotMultiplier: number;
  cooldown: number;
  magSize: number;
  reserveMax: number;
  reloadTime: number;
  baseSpread: number;
  bloomPerShot: number;
  maxBloom: number;
  recoilKick: number;
  auto: boolean;
}

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
  cooldown: number;
  reloadTimer: number;
  reloading: boolean;
  bloom: number;
}

export interface HitBoxes {
  body: Aabb;
  head: Aabb;
}

export interface ShotTarget extends HitBoxes {
  id: string;
  team: Team;
  alive: boolean;
}

export interface ShotResult {
  targetId: string | null;
  headshot: boolean;
  point: Vec3;
  distance: number;
  hitWorld: boolean;
}

export interface HudKill {
  id: number;
  text: string;
  t: number;
}

export interface ScoreRow {
  id: string;
  name: string;
  team: Team;
  isPlayer: boolean;
  kills: number;
  deaths: number;
  alive: boolean;
}

export interface HudState {
  phase: 'menu' | 'live' | 'roundOver' | 'matchOver';
  health: number;
  armor: number;
  alive: boolean;
  mag: number;
  reserve: number;
  weaponName: string;
  reloading: boolean;
  spread: number;
  scoreCT: number;
  scoreT: number;
  round: number;
  timeLeft: number;
  killFeed: HudKill[];
  hitMarker: number;
  damageFlash: number;
  damageAngle: number;
  banner: string;
  matchWinner: Team | null;
  roundWinner: Team | null;
  spectating: string | null;
  scoreboard: ScoreRow[];
}

export type GameEvent =
  | { kind: 'shot'; from: Vec3; to: Vec3; weapon: WeaponId; byPlayer: boolean }
  | { kind: 'impact'; point: Vec3 }
  | { kind: 'kill'; text: string; headshot: boolean; byPlayer: boolean }
  | { kind: 'hit'; headshot: boolean }
  | { kind: 'reload' }
  | { kind: 'roundStart'; round: number }
  | { kind: 'roundEnd'; winner: Team; scoreCT: number; scoreT: number }
  | { kind: 'matchEnd'; winner: Team; scoreCT: number; scoreT: number };

export interface DamageResult {
  health: number;
  armor: number;
  died: boolean;
}
