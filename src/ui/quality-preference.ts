/**
 * 画质档位的界面侧持久化与初始解析。
 *
 * 优先级：URL 显式 `?quality=` > localStorage 保存值 > DEFAULT_QUALITY（高）。
 * URL 只在该次打开时优先生效，不会被自动写回本地；只有玩家在菜单里点选
 * （或按 F1/F2/F3 调试键）才会写入 localStorage，避免一次分享链接永久降档。
 */
import { DEFAULT_QUALITY, isQualityLevel, resolveQuality, type QualityLevel } from '../world/quality';

export const QUALITY_STORAGE_KEY = 'duststrike.quality';

/** 档位来源，用于在菜单里说明“为什么现在是这一档”。 */
export type QualitySource = 'url' | 'storage' | 'default';

export interface QualityResolution {
  level: QualityLevel;
  source: QualitySource;
  /** URL 显式给出但不可识别时保留原值，便于界面与日志说明已忽略。 */
  ignoredUrlValue?: string;
}

/** 隐私模式或被策略禁用时访问 localStorage 会抛错，一律按“没有保存值”处理。 */
function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStoredQuality(storage: Storage | null = safeStorage()): QualityLevel | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(QUALITY_STORAGE_KEY);
    return isQualityLevel(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** 写入失败（配额、隐私模式）不影响本次对局，只是无法跨刷新保持。 */
export function writeStoredQuality(
  level: QualityLevel,
  storage: Storage | null = safeStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(QUALITY_STORAGE_KEY, level);
    return true;
  } catch {
    return false;
  }
}

/** 返回 URL 里的原始 quality 参数；未出现时返回 null（区别于空字符串）。 */
export function qualityParam(search: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  return params.get('quality');
}

/**
 * 解析初始档位：URL 显式指定时优先，否则读取本地保存，最后回落到默认高档。
 * 非法 URL 值不会覆盖本地保存值。
 */
export function resolveInitialQuality(
  search: string,
  storage: Storage | null = safeStorage(),
): QualityResolution {
  const stored = readStoredQuality(storage);
  const raw = qualityParam(search);
  if (raw === null) {
    return stored ? { level: stored, source: 'storage' } : { level: DEFAULT_QUALITY, source: 'default' };
  }
  if (isQualityLevel(raw)) {
    return { level: raw, source: 'url' };
  }
  const level = resolveQuality(raw, stored ?? DEFAULT_QUALITY);
  return { level, source: stored ? 'storage' : 'default', ignoredUrlValue: raw };
}
