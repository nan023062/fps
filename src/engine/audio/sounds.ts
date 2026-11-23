/**
 * 默认音效库：id → (定义, 合成函数)。所有条目都是程序化合成，无外部资源。
 */
import { createSoundDef } from './defs';
import {
  renderAmbience,
  renderDeath,
  renderDryFire,
  renderFootstep,
  renderHit,
  renderPistol,
  renderReload,
  renderRifle,
  renderRoundEnd,
  renderRoundStart,
} from './synth';
import type { SoundEntry, SoundLibrary, SurfaceMaterial } from './types';

export const SOUND_IDS = {
  rifle: 'rifle',
  pistol: 'pistol',
  reload: 'reload',
  dryFire: 'dry_fire',
  footstepSand: 'footstep_sand',
  footstepConcrete: 'footstep_concrete',
  footstepMetal: 'footstep_metal',
  footstepWood: 'footstep_wood',
  hit: 'hit',
  headshot: 'headshot',
  death: 'death',
  roundStart: 'round_start',
  roundEndWin: 'round_end_win',
  roundEndLoss: 'round_end_loss',
  ambience: 'ambience',
} as const;

export function footstepSoundId(material: SurfaceMaterial): string {
  switch (material) {
    case 'sand':
      return SOUND_IDS.footstepSand;
    case 'metal':
      return SOUND_IDS.footstepMetal;
    case 'wood':
      return SOUND_IDS.footstepWood;
    default:
      return SOUND_IDS.footstepConcrete;
  }
}

const weaponSpatial = { spatial: true, refDistance: 6, maxDistance: 90, rolloff: 1, panningModel: 'HRTF' } as const;

const entries: SoundEntry[] = [
  {
    def: createSoundDef({
      id: SOUND_IDS.rifle,
      bus: 'weapons',
      priority: 80,
      duration: 0.6,
      cooldown: 0.04,
      gain: 0.9,
      pitchJitter: 0.06,
      gainJitter: 0.08,
      ...weaponSpatial,
    }),
    render: renderRifle,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.pistol,
      bus: 'weapons',
      priority: 80,
      duration: 0.4,
      cooldown: 0.05,
      gain: 0.8,
      pitchJitter: 0.05,
      gainJitter: 0.08,
      ...weaponSpatial,
    }),
    render: renderPistol,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.reload,
      bus: 'weapons',
      priority: 45,
      duration: 0.6,
      cooldown: 0.35,
      gain: 0.8,
      pitchJitter: 0.04,
      spatial: false,
    }),
    render: renderReload,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.dryFire,
      bus: 'weapons',
      priority: 30,
      duration: 0.08,
      cooldown: 0.12,
      gain: 0.7,
      pitchJitter: 0.05,
      spatial: false,
    }),
    render: renderDryFire,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.footstepSand,
      bus: 'footsteps',
      priority: 20,
      duration: 0.16,
      cooldown: 0.12,
      gain: 0.55,
      pitchJitter: 0.1,
      gainJitter: 0.12,
      spatial: true,
      refDistance: 4,
      maxDistance: 45,
      rolloff: 1.2,
      panningModel: 'HRTF',
    }),
    render: renderFootstep,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.footstepConcrete,
      bus: 'footsteps',
      priority: 20,
      duration: 0.16,
      cooldown: 0.12,
      gain: 0.55,
      pitchJitter: 0.1,
      gainJitter: 0.12,
      spatial: true,
      refDistance: 4,
      maxDistance: 45,
      rolloff: 1.2,
      panningModel: 'HRTF',
    }),
    render: renderFootstep,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.footstepMetal,
      bus: 'footsteps',
      priority: 20,
      duration: 0.2,
      cooldown: 0.12,
      gain: 0.55,
      pitchJitter: 0.1,
      gainJitter: 0.12,
      spatial: true,
      refDistance: 4,
      maxDistance: 45,
      rolloff: 1.2,
      panningModel: 'HRTF',
    }),
    render: renderFootstep,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.footstepWood,
      bus: 'footsteps',
      priority: 20,
      duration: 0.18,
      cooldown: 0.12,
      gain: 0.55,
      pitchJitter: 0.1,
      gainJitter: 0.12,
      spatial: true,
      refDistance: 4,
      maxDistance: 45,
      rolloff: 1.2,
      panningModel: 'HRTF',
    }),
    render: renderFootstep,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.hit,
      bus: 'ui',
      priority: 70,
      duration: 0.1,
      cooldown: 0.02,
      gain: 0.6,
      pitchJitter: 0.05,
      gainJitter: 0.08,
      spatial: false,
    }),
    render: renderHit,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.headshot,
      bus: 'ui',
      priority: 75,
      duration: 0.12,
      cooldown: 0.04,
      gain: 0.7,
      pitchJitter: 0.05,
      gainJitter: 0.08,
      spatial: false,
    }),
    render: renderHit,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.death,
      bus: 'weapons',
      priority: 60,
      duration: 0.7,
      cooldown: 0.1,
      gain: 0.8,
      pitchJitter: 0.04,
      spatial: true,
      refDistance: 6,
      maxDistance: 70,
      rolloff: 1,
      panningModel: 'HRTF',
    }),
    render: renderDeath,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.roundStart,
      bus: 'ui',
      priority: 90,
      duration: 0.3,
      cooldown: 0.5,
      gain: 0.7,
      spatial: false,
    }),
    render: renderRoundStart,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.roundEndWin,
      bus: 'ui',
      priority: 90,
      duration: 0.5,
      cooldown: 0.5,
      gain: 0.7,
      spatial: false,
    }),
    render: renderRoundEnd,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.roundEndLoss,
      bus: 'ui',
      priority: 90,
      duration: 0.5,
      cooldown: 0.5,
      gain: 0.7,
      spatial: false,
    }),
    render: renderRoundEnd,
  },
  {
    def: createSoundDef({
      id: SOUND_IDS.ambience,
      bus: 'ambience',
      priority: 5,
      duration: 1,
      cooldown: 0,
      loop: true,
      gain: 0.6,
      spatial: false,
    }),
    render: renderAmbience,
  },
];

/** 构建默认库；extra 中同 id 的条目覆盖默认条目。 */
export function createDefaultLibrary(extra: readonly SoundEntry[] = []): SoundLibrary {
  const map = new Map<string, SoundEntry>();
  for (const entry of entries) map.set(entry.def.id, entry);
  for (const entry of extra) map.set(entry.def.id, entry);
  return map;
}

export const DEFAULT_SOUND_IDS: readonly string[] = entries.map((entry) => entry.def.id);

/** 回合结束用哪个 id（胜/负两套音序共用 renderRoundEnd，靠 params.win 区分）。 */
export function roundEndSoundId(win: boolean): string {
  return win ? SOUND_IDS.roundEndWin : SOUND_IDS.roundEndLoss;
}

/** 命中提示 id：爆头用更高更亮的一套。 */
export function hitSoundId(headshot: boolean): string {
  return headshot ? SOUND_IDS.headshot : SOUND_IDS.hit;
}
