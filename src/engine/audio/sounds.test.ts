import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOUND_IDS,
  SOUND_IDS,
  createDefaultLibrary,
  footstepSoundId,
  hitSoundId,
  roundEndSoundId,
} from './sounds';
import { footstepProfile, isSurfaceMaterial } from './synth';
import { formatSoundDef, parseSoundDef } from './defs';
import type { SurfaceMaterial } from './types';

describe('默认音效库', () => {
  it('包含全部必需音效', () => {
    const library = createDefaultLibrary();
    for (const id of [
      SOUND_IDS.rifle,
      SOUND_IDS.pistol,
      SOUND_IDS.reload,
      SOUND_IDS.dryFire,
      SOUND_IDS.footstepSand,
      SOUND_IDS.footstepConcrete,
      SOUND_IDS.footstepMetal,
      SOUND_IDS.footstepWood,
      SOUND_IDS.hit,
      SOUND_IDS.headshot,
      SOUND_IDS.death,
      SOUND_IDS.roundStart,
      SOUND_IDS.roundEndWin,
      SOUND_IDS.roundEndLoss,
      SOUND_IDS.ambience,
    ]) {
      expect(library.has(id)).toBe(true);
      expect(library.get(id)?.def.id).toBe(id);
      expect(typeof library.get(id)?.render).toBe('function');
    }
    expect(DEFAULT_SOUND_IDS).toHaveLength(library.size);
  });

  it('UI 提示音强制非空间化，世界音效空间化', () => {
    const library = createDefaultLibrary();
    for (const id of [SOUND_IDS.hit, SOUND_IDS.headshot, SOUND_IDS.roundStart, SOUND_IDS.roundEndWin]) {
      const entry = library.get(id);
      expect(entry?.def.bus).toBe('ui');
      expect(entry?.def.spatial).toBe(false);
    }
    for (const id of [SOUND_IDS.rifle, SOUND_IDS.footstepSand, SOUND_IDS.death]) {
      expect(library.get(id)?.def.spatial).toBe(true);
      expect(library.get(id)?.def.panningModel).toBe('HRTF');
    }
  });

  it('只有环境底噪是循环音效', () => {
    const library = createDefaultLibrary();
    const loops = [...library.values()].filter((entry) => entry.def.loop).map((entry) => entry.def.id);
    expect(loops).toEqual([SOUND_IDS.ambience]);
  });

  it('extraSounds 覆盖同 id 条目', () => {
    const base = createDefaultLibrary().get(SOUND_IDS.rifle);
    expect(base).toBeDefined();
    const library = createDefaultLibrary([
      {
        def: { ...(base as NonNullable<typeof base>).def, priority: 12 },
        render: () => [],
      },
    ]);
    expect(library.get(SOUND_IDS.rifle)?.def.priority).toBe(12);
  });

  it('每个默认定义都能通过格式化/解析往返', () => {
    const library = createDefaultLibrary();
    for (const entry of library.values()) {
      const parsed = parseSoundDef(formatSoundDef(entry.def));
      expect(parsed).toEqual(entry.def);
    }
  });
});

describe('脚步材质与速度', () => {
  it('速度越高响度与音高越高、时长越短', () => {
    const slow = footstepProfile('concrete', 0);
    const fast = footstepProfile('concrete', 1);
    expect(fast.gain).toBeGreaterThan(slow.gain);
    expect(fast.pitch).toBeGreaterThan(slow.pitch);
    expect(fast.duration).toBeLessThan(slow.duration);
  });

  it('速度越界被夹到 0..1', () => {
    expect(footstepProfile('sand', -5)).toEqual(footstepProfile('sand', 0));
    expect(footstepProfile('sand', 99)).toEqual(footstepProfile('sand', 1));
  });

  it('不同材质使用不同滤波中心频率与 Q 值', () => {
    const sand = footstepProfile('sand', 0.5);
    const concrete = footstepProfile('concrete', 0.5);
    const metal = footstepProfile('metal', 0.5);
    expect(sand.filterType).toBe('lowpass');
    expect(sand.cutoff).toBeLessThan(concrete.cutoff);
    expect(concrete.cutoff).toBeLessThan(metal.cutoff);
    expect(metal.q).toBeGreaterThan(concrete.q);
  });

  it('材质 id 与音效 id 对应', () => {
    const expected: Record<SurfaceMaterial, string> = {
      sand: SOUND_IDS.footstepSand,
      concrete: SOUND_IDS.footstepConcrete,
      metal: SOUND_IDS.footstepMetal,
      wood: SOUND_IDS.footstepWood,
    };
    for (const [material, id] of Object.entries(expected)) {
      expect(footstepSoundId(material as SurfaceMaterial)).toBe(id);
    }
    expect(isSurfaceMaterial('sand')).toBe(true);
    expect(isSurfaceMaterial('lava')).toBe(false);
  });

  it('命中与回合结束映射到不同音效 id', () => {
    expect(hitSoundId(false)).toBe(SOUND_IDS.hit);
    expect(hitSoundId(true)).toBe(SOUND_IDS.headshot);
    expect(roundEndSoundId(true)).toBe(SOUND_IDS.roundEndWin);
    expect(roundEndSoundId(false)).toBe(SOUND_IDS.roundEndLoss);
  });
});
