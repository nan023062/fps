import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUALITY,
  QUALITY_PRESETS,
  isQualityLevel,
  nextQuality,
  qualityFromSearch,
  qualityPreset,
  resolveQuality,
} from './quality';

describe('quality presets', () => {
  it('低档直接渲染，高档具备完整后处理链', () => {
    expect(QUALITY_PRESETS.low.postProcessing).toBe(false);
    expect(QUALITY_PRESETS.low.ao).toBe('off');
    expect(QUALITY_PRESETS.low.bloom).toBe(false);
    expect(QUALITY_PRESETS.low.grading).toBe(false);

    expect(QUALITY_PRESETS.medium.postProcessing).toBe(true);
    expect(QUALITY_PRESETS.medium.ao).toBe('ssao');

    expect(QUALITY_PRESETS.high.ao).toBe('gtao');
    expect(QUALITY_PRESETS.high.bloom).toBe(true);
    expect(QUALITY_PRESETS.high.grading).toBe(true);
    expect(QUALITY_PRESETS.high.antiAliasing).toBe('smaa');
  });

  it('档位在像素比、阴影与细节预算上单调递增', () => {
    const order = ['low', 'medium', 'high'] as const;
    for (let i = 1; i < order.length; i += 1) {
      const previous = QUALITY_PRESETS[order[i - 1]];
      const current = QUALITY_PRESETS[order[i]];
      expect(current.pixelRatioCap).toBeGreaterThanOrEqual(previous.pixelRatioCap);
      expect(current.shadowMapSize).toBeGreaterThan(previous.shadowMapSize);
      expect(current.detailScale).toBeGreaterThanOrEqual(previous.detailScale);
      expect(current.dustMotes).toBeGreaterThanOrEqual(previous.dustMotes);
    }
  });

  it('URL 参数解析非法值回落到默认档', () => {
    expect(qualityFromSearch('?quality=low')).toBe('low');
    expect(qualityFromSearch('quality=medium')).toBe('medium');
    expect(qualityFromSearch('?quality=ultra')).toBe(DEFAULT_QUALITY);
    expect(qualityFromSearch('')).toBe(DEFAULT_QUALITY);
    expect(resolveQuality(undefined)).toBe(DEFAULT_QUALITY);
    expect(resolveQuality('low')).toBe('low');
    expect(resolveQuality('weird', 'medium')).toBe('medium');
    expect(isQualityLevel('high')).toBe(true);
    expect(isQualityLevel('HIGH')).toBe(false);
  });

  it('档位循环与查询接口', () => {
    expect(nextQuality('low')).toBe('medium');
    expect(nextQuality('medium')).toBe('high');
    expect(nextQuality('high')).toBe('low');
    expect(qualityPreset('high').id).toBe('high');
  });
});
