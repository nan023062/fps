import { describe, expect, it } from 'vitest';
import {
  QUALITY_STORAGE_KEY,
  qualityParam,
  readStoredQuality,
  resolveInitialQuality,
  writeStoredQuality,
} from './quality-preference';

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  constructor(private readonly failOnWrite = false) {}

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
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

describe('画质档持久化与初始解析', () => {
  it('无 URL 参数且无保存值时回落到默认高档', () => {
    const result = resolveInitialQuality('', new MemoryStorage());
    expect(result.level).toBe('high');
    expect(result.source).toBe('default');
  });

  it('无 URL 参数时读取本地保存值', () => {
    const storage = new MemoryStorage();
    storage.setItem(QUALITY_STORAGE_KEY, 'medium');
    const result = resolveInitialQuality('?foo=bar', storage);
    expect(result.level).toBe('medium');
    expect(result.source).toBe('storage');
  });

  it('URL 显式指定时优先于本地保存值', () => {
    const storage = new MemoryStorage();
    storage.setItem(QUALITY_STORAGE_KEY, 'medium');
    const result = resolveInitialQuality('?quality=low', storage);
    expect(result.level).toBe('low');
    expect(result.source).toBe('url');
  });

  it('URL 非法值被忽略并回落到本地保存值', () => {
    const storage = new MemoryStorage();
    storage.setItem(QUALITY_STORAGE_KEY, 'low');
    const result = resolveInitialQuality('?quality=ultra', storage);
    expect(result.level).toBe('low');
    expect(result.ignoredUrlValue).toBe('ultra');
  });

  it('URL 非法且无保存值时回落到默认高档', () => {
    const result = resolveInitialQuality('?quality=', new MemoryStorage());
    expect(result.level).toBe('high');
    expect(result.ignoredUrlValue).toBe('');
  });

  it('本地保存值非法时按无保存值处理', () => {
    const storage = new MemoryStorage();
    storage.setItem(QUALITY_STORAGE_KEY, 'ultra');
    expect(readStoredQuality(storage)).toBeNull();
    expect(resolveInitialQuality('', storage).level).toBe('high');
  });

  it('没有 storage 时读写都不抛错', () => {
    expect(readStoredQuality(null)).toBeNull();
    expect(writeStoredQuality('medium', null)).toBe(false);
  });

  it('写入失败（配额/隐私模式）只返回 false', () => {
    const storage = new MemoryStorage(true);
    expect(writeStoredQuality('low', storage)).toBe(false);
  });

  it('写入后可被读回，且不影响其他键', () => {
    const storage = new MemoryStorage();
    storage.setItem('other', 'keep');
    expect(writeStoredQuality('medium', storage)).toBe(true);
    expect(storage.getItem(QUALITY_STORAGE_KEY)).toBe('medium');
    expect(storage.getItem('other')).toBe('keep');
  });

  it('只在 URL 真正出现 quality 参数时返回非 null', () => {
    expect(qualityParam('')).toBeNull();
    expect(qualityParam('?level=low')).toBeNull();
    expect(qualityParam('?quality=high')).toBe('high');
    expect(qualityParam('quality=high')).toBe('high');
  });
});
