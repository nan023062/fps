import { describe, expect, it } from 'vitest';
import type { InputSnapshot } from '../core/input';
import {
  applySettingsPatch,
  applySensitivity,
  clampFov,
  clampSensitivity,
  clampVolume,
  DEFAULT_SETTINGS,
  FOV_RANGE,
  normalizeSettings,
  parseSettings,
  readStoredSettings,
  scaleMouseDelta,
  serializeSettings,
  SENSITIVITY_RANGE,
  SETTINGS_STORAGE_KEY,
  settingsEqual,
  SettingsStore,
  volumeToGain,
  VOLUME_RANGE,
  writeStoredSettings,
  type GameSettings,
} from './settings';
import { QUALITY_STORAGE_KEY } from './quality-preference';

/** 与 quality-preference 测试同款内存 Storage；可注入读写失败。 */
class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  constructor(
    private readonly failOnWrite = false,
    private readonly failOnRead = false,
  ) {}

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    if (this.failOnRead) throw new Error('blocked');
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failOnWrite) throw new Error('quota');
    this.map.set(key, value);
  }
}

const baseInput: InputSnapshot = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  crouch: false,
  walk: false,
  fire: false,
  scoreboard: false,
  reloadRequest: false,
  switchRequest: null,
  mouseDX: 0,
  mouseDY: 0,
  pointerLocked: true,
};

describe('设置默认值与取值范围', () => {
  it('默认值覆盖全部设置项且落在合法区间', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      master: 80,
      sfx: 80,
      ambience: 70,
      sensitivity: 1,
      fov: 74,
      cameraShake: true,
    });
    expect(VOLUME_RANGE).toEqual({ min: 0, max: 100 });
    expect(SENSITIVITY_RANGE).toEqual({ min: 0.3, max: 2 });
    expect(FOV_RANGE).toEqual({ min: 70, max: 110 });
    // FOV 默认与 main.ts 既有 CAMERA_BASE_FOV 一致。
    expect(DEFAULT_SETTINGS.fov).toBe(74);
    expect(DEFAULT_SETTINGS.cameraShake).toBe(true);
  });

  it('缺失输入回落默认值', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('broken')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings([])).toEqual(DEFAULT_SETTINGS);
  });
});

describe('逐字段夹取与非法值回落', () => {
  it('音量越界夹到 0–100，类型非法回落默认', () => {
    expect(clampVolume(-20)).toBe(0);
    expect(clampVolume(180)).toBe(100);
    expect(clampVolume(55)).toBe(55);
    expect(clampVolume('60')).toBe(DEFAULT_SETTINGS.master);
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_SETTINGS.master);
  });

  it('灵敏度夹到 0.3–2.0，FOV 夹到 70–110', () => {
    expect(clampSensitivity(0.05)).toBe(0.3);
    expect(clampSensitivity(9)).toBe(2);
    expect(clampSensitivity(1.35)).toBe(1.35);
    expect(clampFov(10)).toBe(70);
    expect(clampFov(400)).toBe(110);
    expect(clampFov(96)).toBe(96);
    expect(clampFov(null)).toBe(DEFAULT_SETTINGS.fov);
  });

  it('部分字段缺失时只回落缺失字段，越界字段单独夹取', () => {
    const settings = normalizeSettings({ master: 150, sensitivity: 0.1, cameraShake: false });
    expect(settings.master).toBe(100);
    expect(settings.sensitivity).toBe(0.3);
    expect(settings.cameraShake).toBe(false);
    expect(settings.sfx).toBe(DEFAULT_SETTINGS.sfx);
    expect(settings.ambience).toBe(DEFAULT_SETTINGS.ambience);
    expect(settings.fov).toBe(DEFAULT_SETTINGS.fov);
  });

  it('cameraShake 非布尔值回落默认开启', () => {
    expect(normalizeSettings({ cameraShake: 'yes' }).cameraShake).toBe(true);
    expect(normalizeSettings({ cameraShake: 0 }).cameraShake).toBe(true);
    expect(normalizeSettings({ cameraShake: false }).cameraShake).toBe(false);
  });

  it('数值字符串不会被当作数字接受', () => {
    const settings = normalizeSettings({ master: '40', fov: '90' });
    expect(settings.master).toBe(DEFAULT_SETTINGS.master);
    expect(settings.fov).toBe(DEFAULT_SETTINGS.fov);
  });
});

describe('JSON 解析容错', () => {
  it('非法 JSON 回落默认值且不抛错', () => {
    expect(() => parseSettings('{not json')).not.toThrow();
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('null')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('42')).toEqual(DEFAULT_SETTINGS);
  });

  it('合法 JSON 读取全部字段', () => {
    const settings = parseSettings(
      JSON.stringify({
        master: 30,
        sfx: 40,
        ambience: 50,
        sensitivity: 1.5,
        fov: 90,
        cameraShake: false,
      }),
    );
    expect(settings).toEqual({
      master: 30,
      sfx: 40,
      ambience: 50,
      sensitivity: 1.5,
      fov: 90,
      cameraShake: false,
    });
  });

  it('序列化后可无损读回，并带版本号', () => {
    const settings: GameSettings = {
      master: 12,
      sfx: 34,
      ambience: 56,
      sensitivity: 0.75,
      fov: 88,
      cameraShake: false,
    };
    const raw = serializeSettings(settings);
    expect(JSON.parse(raw).version).toBe(1);
    expect(parseSettings(raw)).toEqual(settings);
  });

  it('序列化会夹取越界值，避免写坏存储', () => {
    const parsed = JSON.parse(
      serializeSettings({ ...DEFAULT_SETTINGS, master: 999, fov: 5, sensitivity: 8 }),
    );
    expect(parsed.master).toBe(100);
    expect(parsed.fov).toBe(70);
    expect(parsed.sensitivity).toBe(2);
  });
});

describe('localStorage 读写容错与画质键独立', () => {
  it('没有 storage 时读写都不抛错', () => {
    expect(readStoredSettings(null).source).toBe('default');
    expect(readStoredSettings(null).settings).toEqual(DEFAULT_SETTINGS);
    expect(writeStoredSettings(DEFAULT_SETTINGS, null)).toBe(false);
  });

  it('读取抛错（隐私模式/策略禁用）回落默认值', () => {
    const storage = new MemoryStorage(false, true);
    const result = readStoredSettings(storage);
    expect(result.source).toBe('default');
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('写入失败（配额）只返回 false，不抛出', () => {
    const storage = new MemoryStorage(true);
    expect(() => writeStoredSettings(DEFAULT_SETTINGS, storage)).not.toThrow();
    expect(writeStoredSettings(DEFAULT_SETTINGS, storage)).toBe(false);
  });

  it('保存值损坏标记为 invalid 并回落默认', () => {
    const storage = new MemoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, '{"master":');
    const result = readStoredSettings(storage);
    expect(result.source).toBe('invalid');
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('写入后能读回，且不触碰 duststrike.quality', () => {
    const storage = new MemoryStorage();
    storage.setItem(QUALITY_STORAGE_KEY, 'medium');
    const settings = { ...DEFAULT_SETTINGS, master: 20, cameraShake: false };
    expect(writeStoredSettings(settings, storage)).toBe(true);
    expect(storage.getItem(QUALITY_STORAGE_KEY)).toBe('medium');
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
    const result = readStoredSettings(storage);
    expect(result.source).toBe('storage');
    expect(result.settings).toEqual(settings);
  });

  it('画质键变化不影响设置键', () => {
    const storage = new MemoryStorage();
    writeStoredSettings({ ...DEFAULT_SETTINGS, fov: 100 }, storage);
    storage.setItem(QUALITY_STORAGE_KEY, 'low');
    expect(readStoredSettings(storage).settings.fov).toBe(100);
    // 设置键只占一个键位，没有写画质键。
    expect(storage.getItem(QUALITY_STORAGE_KEY)).toBe('low');
  });
});

describe('灵敏度与 FOV 纯函数', () => {
  it('灵敏度是输入增量的线性倍率', () => {
    expect(scaleMouseDelta(10, -4, 1)).toEqual({ dx: 10, dy: -4 });
    expect(scaleMouseDelta(10, -4, 2)).toEqual({ dx: 20, dy: -8 });
    expect(scaleMouseDelta(10, -4, 0.5)).toEqual({ dx: 5, dy: -2 });
  });

  it('灵敏度倍率被夹取，非数值输入按默认 1.0', () => {
    expect(scaleMouseDelta(10, 10, 9)).toEqual({ dx: 20, dy: 20 });
    expect(scaleMouseDelta(10, 10, 0.01)).toEqual({ dx: 3, dy: 3 });
    expect(scaleMouseDelta(10, 10, Number.NaN)).toEqual({ dx: 10, dy: 10 });
  });

  it('applySensitivity 只缩放视角增量，其余字段与引用保持不变', () => {
    const input: InputSnapshot = { ...baseInput, forward: true, fire: true, mouseDX: 8, mouseDY: -6 };
    const scaled = applySensitivity(input, 2);
    expect(scaled.mouseDX).toBe(16);
    expect(scaled.mouseDY).toBe(-12);
    expect(scaled.forward).toBe(true);
    expect(scaled.fire).toBe(true);
    expect(scaled.pointerLocked).toBe(true);
    // 倍率 1.0 时直接返回原对象，避免无意义的快照分配。
    expect(applySensitivity(input, 1)).toBe(input);
  });

  it('音量换算 0–100 → 0–1 增益', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(50)).toBe(0.5);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(-5)).toBe(0);
    expect(volumeToGain(1000)).toBe(1);
  });
});

describe('设置合并与存储对象', () => {
  it('applySettingsPatch 只改传入字段，非法值回落基线', () => {
    const base = normalizeSettings(DEFAULT_SETTINGS);
    const next = applySettingsPatch(base, { master: 10, fov: 999 });
    expect(next.master).toBe(10);
    expect(next.fov).toBe(110);
    expect(next.sfx).toBe(base.sfx);
    const invalid = applySettingsPatch(base, { master: 'loud' as unknown as number });
    expect(invalid.master).toBe(base.master);
  });

  it('settingsEqual 逐字段比较', () => {
    expect(settingsEqual(DEFAULT_SETTINGS, normalizeSettings(DEFAULT_SETTINGS))).toBe(true);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, fov: 75 })).toBe(false);
    expect(settingsEqual(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, cameraShake: false })).toBe(false);
  });

  it('SettingsStore 只在值变化时写盘并通知', () => {
    const storage = new MemoryStorage();
    const store = new SettingsStore(storage);
    expect(store.value).toEqual(DEFAULT_SETTINGS);

    const seen: GameSettings[] = [];
    store.subscribe((settings) => seen.push(settings));

    store.update({ master: 30 });
    store.update({ master: 30 });
    expect(seen).toHaveLength(1);
    expect(store.value.master).toBe(30);
    expect(readStoredSettings(storage).settings.master).toBe(30);

    store.update({ fov: 200 });
    expect(store.value.fov).toBe(110);
    expect(seen).toHaveLength(2);
  });

  it('SettingsStore 读到保存值；reset 恢复默认并落盘', () => {
    const storage = new MemoryStorage();
    writeStoredSettings({ ...DEFAULT_SETTINGS, sensitivity: 1.8, cameraShake: false }, storage);
    const store = new SettingsStore(storage);
    expect(store.value.sensitivity).toBe(1.8);
    expect(store.value.cameraShake).toBe(false);

    store.reset();
    expect(store.value).toEqual(DEFAULT_SETTINGS);
    expect(readStoredSettings(storage).settings).toEqual(DEFAULT_SETTINGS);
  });

  it('写入失败时内存值仍然生效（本次对局可用）', () => {
    const storage = new MemoryStorage(true);
    const store = new SettingsStore(storage);
    expect(() => store.update({ master: 10 })).not.toThrow();
    expect(store.value.master).toBe(10);
    expect(readStoredSettings(storage).source).toBe('default');
  });
});
