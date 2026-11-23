/**
 * 玩家设置（音量 / 灵敏度 / FOV / 相机震动）的纯逻辑与持久化。
 *
 * 设计约定（与 quality-preference 一致的容错策略）：
 * - 只用一个 localStorage 键 `duststrike.settings`，与画质键 `duststrike.quality` 完全独立；
 * - JSON 解析失败、字段缺失、类型非法 → 逐字段回落到默认值；
 * - 数值越界 → 夹取到合法区间，而不是丢弃整份设置；
 * - 读取/写入失败（隐私模式、配额）静默处理，不影响本次对局；
 * - 本模块不 import DOM、音频或相机实现，全部是可在 Node 里直接测的纯函数。
 */
import type { InputSnapshot } from '../core/input';

export const SETTINGS_STORAGE_KEY = 'duststrike.settings';
/** 存储格式版本，仅用于未来迁移；解析时缺省或更高版本都按容错处理。 */
export const SETTINGS_SCHEMA_VERSION = 1;

export const VOLUME_RANGE = { min: 0, max: 100 } as const;
/** 灵敏度倍率：1.0 = 既有手感（LOOK_SENSITIVITY 不变，只缩放输入增量）。 */
export const SENSITIVITY_RANGE = { min: 0.3, max: 2 } as const;
export const FOV_RANGE = { min: 70, max: 110 } as const;
/** 默认 FOV 沿用 main.ts 既有的 CAMERA_BASE_FOV（74°）。 */
export const DEFAULT_FOV = 74;

export interface GameSettings {
  /** 总线主音量 0–100。 */
  master: number;
  /** 音效合并音量 0–100（Weapons + Footsteps 两条总线）。 */
  sfx: number;
  /** 环境音音量 0–100（ambience 总线）。 */
  ambience: number;
  /** 鼠标灵敏度倍率 0.3–2.0。 */
  sensitivity: number;
  /** 相机竖直视角 70–110 度。 */
  fov: number;
  /** 相机震动（开火抖动与死亡冲击）开关。 */
  cameraShake: boolean;
}

export type SettingsPatch = Partial<GameSettings>;

/** 默认值：一次对局开箱即用的中庸配置，FOV 与既有基准视角一致。 */
export const DEFAULT_SETTINGS: Readonly<GameSettings> = Object.freeze({
  master: 80,
  sfx: 80,
  ambience: 70,
  sensitivity: 1,
  fov: DEFAULT_FOV,
  cameraShake: true,
});

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 数值夹取：类型非法 → fallback；越界 → 夹到 [min, max]。 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function clampVolume(value: unknown, fallback = DEFAULT_SETTINGS.master): number {
  return clampNumber(value, VOLUME_RANGE.min, VOLUME_RANGE.max, fallback);
}

export function clampSensitivity(value: unknown, fallback = DEFAULT_SETTINGS.sensitivity): number {
  return clampNumber(value, SENSITIVITY_RANGE.min, SENSITIVITY_RANGE.max, fallback);
}

export function clampFov(value: unknown, fallback = DEFAULT_FOV): number {
  return clampNumber(value, FOV_RANGE.min, FOV_RANGE.max, fallback);
}

/**
 * 任意来源（JSON.parse 结果、DEV 钩子入参）→ 合法设置。
 * 每个字段独立处理，单个字段损坏不会丢掉整份设置。
 */
export function normalizeSettings(input: unknown): GameSettings {
  const source =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return {
    master: clampVolume(source.master, DEFAULT_SETTINGS.master),
    sfx: clampVolume(source.sfx, DEFAULT_SETTINGS.sfx),
    ambience: clampVolume(source.ambience, DEFAULT_SETTINGS.ambience),
    sensitivity: clampSensitivity(source.sensitivity, DEFAULT_SETTINGS.sensitivity),
    fov: clampFov(source.fov, DEFAULT_SETTINGS.fov),
    cameraShake:
      typeof source.cameraShake === 'boolean' ? source.cameraShake : DEFAULT_SETTINGS.cameraShake,
  };
}

/** 原始 JSON 文本 → 设置；任何异常都回落默认值，不抛出。 */
export function parseSettings(raw: string | null): GameSettings {
  if (raw === null) return normalizeSettings(DEFAULT_SETTINGS);
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

/** 设置 → 稳定 JSON 文本（含版本号，便于将来迁移）。 */
export function serializeSettings(settings: GameSettings): string {
  const value = normalizeSettings(settings);
  return JSON.stringify({
    version: SETTINGS_SCHEMA_VERSION,
    master: value.master,
    sfx: value.sfx,
    ambience: value.ambience,
    sensitivity: value.sensitivity,
    fov: value.fov,
    cameraShake: value.cameraShake,
  });
}

/** 逐字段比较，用于“按值差异更新 DOM / 避免无意义写入”。 */
export function settingsEqual(a: GameSettings, b: GameSettings): boolean {
  return (
    a.master === b.master &&
    a.sfx === b.sfx &&
    a.ambience === b.ambience &&
    a.sensitivity === b.sensitivity &&
    a.fov === b.fov &&
    a.cameraShake === b.cameraShake
  );
}

/** 合并一次改动；缺省字段保持基线，非法字段回落基线值。 */
export function applySettingsPatch(base: GameSettings, patch: SettingsPatch): GameSettings {
  const source = patch as Record<string, unknown>;
  return {
    master: source.master === undefined ? base.master : clampVolume(source.master, base.master),
    sfx: source.sfx === undefined ? base.sfx : clampVolume(source.sfx, base.sfx),
    ambience:
      source.ambience === undefined ? base.ambience : clampVolume(source.ambience, base.ambience),
    sensitivity:
      source.sensitivity === undefined
        ? base.sensitivity
        : clampSensitivity(source.sensitivity, base.sensitivity),
    fov: source.fov === undefined ? base.fov : clampFov(source.fov, base.fov),
    cameraShake:
      typeof source.cameraShake === 'boolean' ? source.cameraShake : base.cameraShake,
  };
}

/** 隐私模式或被策略禁用时访问 localStorage 会抛错，一律按“没有保存值”处理。 */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** 默认值 / 保存值 / 保存值损坏三种来源，便于界面与日志说明。 */
export type SettingsSource = 'storage' | 'default' | 'invalid';

export interface StoredSettingsResult {
  settings: GameSettings;
  source: SettingsSource;
}

export function readStoredSettings(storage: Storage | null = safeStorage()): StoredSettingsResult {
  const fallback: StoredSettingsResult = {
    settings: normalizeSettings(DEFAULT_SETTINGS),
    source: 'default',
  };
  if (!storage) return fallback;
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return { settings: normalizeSettings(DEFAULT_SETTINGS), source: 'invalid' };
    }
    return { settings: normalizeSettings(parsed), source: 'storage' };
  } catch {
    return { settings: normalizeSettings(DEFAULT_SETTINGS), source: 'invalid' };
  }
}

/** 写入失败（配额、隐私模式）只返回 false，不抛出，也不影响本次对局。 */
export function writeStoredSettings(
  settings: GameSettings,
  storage: Storage | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
    return true;
  } catch {
    return false;
  }
}

/** 0–100 的音量 → 0–1 总线增益（音频层接收 0–1）。 */
export function volumeToGain(volume: number): number {
  return clampVolume(volume, 0) / VOLUME_RANGE.max;
}

/** 鼠标像素增量 × 灵敏度倍率；LOOK_SENSITIVITY 常量保持原值。 */
export function scaleMouseDelta(
  dx: number,
  dy: number,
  sensitivity: number,
): { dx: number; dy: number } {
  const scale = clampSensitivity(sensitivity, DEFAULT_SETTINGS.sensitivity);
  const sx = Number.isFinite(dx) ? dx : 0;
  const sy = Number.isFinite(dy) ? dy : 0;
  return { dx: sx * scale, dy: sy * scale };
}

/** 输入快照的视角增量按灵敏度缩放（其余字段原样透传，不修改玩法状态）。 */
export function applySensitivity(input: InputSnapshot, sensitivity: number): InputSnapshot {
  const scaled = scaleMouseDelta(input.mouseDX, input.mouseDY, sensitivity);
  if (scaled.dx === input.mouseDX && scaled.dy === input.mouseDY) return input;
  return { ...input, mouseDX: scaled.dx, mouseDY: scaled.dy };
}

export type SettingsListener = (settings: GameSettings, previous: GameSettings) => void;

/**
 * 设置存储：内存值 + 单键持久化 + 订阅。
 *
 * 只在值真正变化时写 localStorage 并通知订阅者，避免滑块拖动时重复写盘或重建 DOM。
 * 构造参数保留注入点，方便用内存 Storage 做确定性测试。
 */
export class SettingsStore {
  private current: GameSettings;
  private readonly listeners = new Set<SettingsListener>();

  constructor(
    private readonly storage: Storage | null = safeStorage(),
    initial?: GameSettings,
  ) {
    this.current = normalizeSettings(initial ?? readStoredSettings(storage).settings);
  }

  get value(): GameSettings {
    return this.current;
  }

  /** 局部更新：非法值夹取/回落基线，值无变化时不写盘也不通知。 */
  update(patch: SettingsPatch): GameSettings {
    const next = applySettingsPatch(this.current, patch);
    if (settingsEqual(next, this.current)) return this.current;
    const previous = this.current;
    this.current = next;
    writeStoredSettings(next, this.storage);
    for (const listener of this.listeners) listener(next, previous);
    return next;
  }

  /** 恢复默认：与逐项改动走同一条路径（写盘 + 通知）。 */
  reset(): GameSettings {
    return this.update(DEFAULT_SETTINGS);
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
