/**
 * 画质档位：渲染器像素比、阴影尺寸、环境光强度与后处理链都由这里决定。
 * 三档都必须在真实浏览器里可用；低档直接渲染（无重后处理），不会黑屏。
 */
export type QualityLevel = 'low' | 'medium' | 'high';

export type AmbientOcclusionMode = 'off' | 'ssao' | 'gtao';
export type AntiAliasingMode = 'off' | 'fxaa' | 'smaa';

export interface QualityPreset {
  id: QualityLevel;
  label: string;
  /** 像素比上限，避免 4K 屏按 devicePixelRatio 直接爆掉填充率。 */
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowRadius: number;
  environmentIntensity: number;
  anisotropy: number;
  /** 是否启用后处理合成链；关闭时直接 renderer.render。 */
  postProcessing: boolean;
  ao: AmbientOcclusionMode;
  bloom: boolean;
  bloomStrength: number;
  bloomRadius: number;
  bloomThreshold: number;
  antiAliasing: AntiAliasingMode;
  grading: boolean;
  /** 程序化细节密度（装饰网格数量倍率）。 */
  detailScale: number;
  dustMotes: number;
  /**
   * 程序化网格细分档位：1=低、2=中、3=高，单调递增。
   * 只影响几何段数（三角面密度），不改变零件数量；由 geometry 的
   * roundedSegmentsFor / capsuleSegmentsFor / cylinderSegmentsFor / sphereSegmentsFor 解析。
   */
  meshDetail: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  low: {
    id: 'low',
    label: '低',
    pixelRatioCap: 1,
    shadowMapSize: 512,
    shadowRadius: 1,
    environmentIntensity: 0.6,
    anisotropy: 1,
    postProcessing: false,
    ao: 'off',
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0.4,
    bloomThreshold: 0.95,
    antiAliasing: 'off',
    grading: false,
    detailScale: 0.45,
    dustMotes: 0,
    meshDetail: 1,
  },
  medium: {
    id: 'medium',
    label: '中',
    pixelRatioCap: 1.25,
    shadowMapSize: 1024,
    shadowRadius: 2,
    environmentIntensity: 0.8,
    anisotropy: 4,
    postProcessing: true,
    ao: 'ssao',
    bloom: true,
    bloomStrength: 0.14,
    bloomRadius: 0.4,
    bloomThreshold: 0.9,
    antiAliasing: 'smaa',
    grading: true,
    detailScale: 0.8,
    dustMotes: 70,
    meshDetail: 2,
  },
  high: {
    id: 'high',
    label: '高',
    pixelRatioCap: 1.75,
    shadowMapSize: 2048,
    shadowRadius: 3,
    environmentIntensity: 1,
    anisotropy: 8,
    postProcessing: true,
    ao: 'gtao',
    bloom: true,
    bloomStrength: 0.16,
    bloomRadius: 0.42,
    bloomThreshold: 0.96,
    antiAliasing: 'smaa',
    grading: true,
    detailScale: 1,
    dustMotes: 160,
    meshDetail: 3,
  },
};

export const DEFAULT_QUALITY: QualityLevel = 'high';

export function isQualityLevel(value: unknown): value is QualityLevel {
  return value === 'low' || value === 'medium' || value === 'high';
}

export function resolveQuality(value: unknown, fallback: QualityLevel = DEFAULT_QUALITY): QualityLevel {
  return isQualityLevel(value) ? value : fallback;
}

/** 支持 ?quality=low / medium / high；缺省或非法值回落到 high。 */
export function qualityFromSearch(search: string): QualityLevel {
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
  return resolveQuality(params.get('quality'));
}

export function nextQuality(current: QualityLevel): QualityLevel {
  return current === 'low' ? 'medium' : current === 'medium' ? 'high' : 'low';
}

export function qualityPreset(level: QualityLevel): QualityPreset {
  return QUALITY_PRESETS[level];
}
