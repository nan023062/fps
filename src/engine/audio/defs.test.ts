import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SOUND_DEF,
  clamp01,
  clampRange,
  createSoundDef,
  formatSoundDef,
  parseSoundDef,
  tryParseSoundDef,
} from './defs';

describe('数值夹取', () => {
  it('clamp01 夹到 0..1 并把非有限值归零', () => {
    expect(clamp01(0.42)).toBe(0.42);
    expect(clamp01(-3)).toBe(0);
    expect(clamp01(9)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('clampRange 夹到区间并保持边界', () => {
    expect(clampRange(5, 0, 10)).toBe(5);
    expect(clampRange(-1, 0, 10)).toBe(0);
    expect(clampRange(11, 0, 10)).toBe(10);
    expect(clampRange(Number.NaN, 2, 10)).toBe(2);
  });
});

describe('音效定义构造', () => {
  it('缺省字段使用默认值', () => {
    const def = createSoundDef({ id: 'x', bus: 'ui' });
    expect(def.priority).toBe(DEFAULT_SOUND_DEF.priority);
    expect(def.duration).toBe(DEFAULT_SOUND_DEF.duration);
    expect(def.loop).toBe(false);
    expect(def.spatial).toBe(false);
    expect(def.panningModel).toBe('equalpower');
  });

  it('越界值被夹取', () => {
    const def = createSoundDef({ id: 'x', bus: 'weapons', priority: 900, gain: 4, pitchJitter: -2 });
    expect(def.priority).toBe(100);
    expect(def.gain).toBe(1);
    expect(def.pitchJitter).toBe(0);
  });

  it('maxDistance 不小于 refDistance', () => {
    const def = createSoundDef({ id: 'x', bus: 'weapons', refDistance: 20, maxDistance: 4 });
    expect(def.maxDistance).toBeGreaterThanOrEqual(def.refDistance);
    expect(def.maxDistance).toBe(20);
  });

  it('未知 panningModel 退化为 equalpower', () => {
    const def = createSoundDef({
      id: 'x',
      bus: 'weapons',
      panningModel: 'bogus' as unknown as 'HRTF',
    });
    expect(def.panningModel).toBe('equalpower');
  });
});

describe('格式化与解析', () => {
  const def = createSoundDef({
    id: 'rifle',
    bus: 'weapons',
    priority: 80,
    duration: 0.6,
    cooldown: 0.04,
    gain: 0.9,
    pitchJitter: 0.06,
    gainJitter: 0.08,
    spatial: true,
    refDistance: 6,
    maxDistance: 90,
    rolloff: 1,
    panningModel: 'HRTF',
  });

  it('格式化包含全部字段且顺序固定', () => {
    const text = formatSoundDef(def);
    expect(text.startsWith('id=rifle|bus=weapons|priority=80')).toBe(true);
    expect(text.endsWith('panningModel=HRTF')).toBe(true);
    expect(text.split('|')).toHaveLength(14);
    expect(formatSoundDef(def)).toBe(text);
  });

  it('解析结果与原始定义等价（round-trip）', () => {
    const parsed = parseSoundDef(formatSoundDef(def));
    expect(parsed).toEqual(def);
  });

  it('解析循环音效', () => {
    const loopDef = createSoundDef({ id: 'ambience', bus: 'ambience', loop: true, duration: 1 });
    const parsed = parseSoundDef(formatSoundDef(loopDef));
    expect(parsed.loop).toBe(true);
    expect(parsed.bus).toBe('ambience');
  });

  it('缺失可选字段时回落默认值', () => {
    const parsed = parseSoundDef('id=ping|bus=ui');
    expect(parsed.priority).toBe(DEFAULT_SOUND_DEF.priority);
    expect(parsed.spatial).toBe(false);
    expect(parsed.loop).toBe(false);
  });

  it('未知总线被拒绝', () => {
    const result = tryParseSoundDef('id=ping|bus=music');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('未知总线');
  });

  it('缺少 id 被拒绝', () => {
    const result = tryParseSoundDef('bus=ui');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('id');
  });

  it('非数字字段被拒绝并给出字段名', () => {
    const result = tryParseSoundDef('id=ping|bus=ui|gain=loud');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('gain');
  });

  it('布尔字段非法时被拒绝', () => {
    const result = tryParseSoundDef('id=ping|bus=ui|loop=yes');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('loop');
  });

  it('允许字段前后空格与空片段', () => {
    const parsed = parseSoundDef(' id = ping | bus = ui | | gain = 0.5 ');
    expect(parsed.id).toBe('ping');
    expect(parsed.bus).toBe('ui');
    expect(parsed.gain).toBe(0.5);
  });
});
