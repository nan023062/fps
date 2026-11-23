import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_VOICES,
  HARD_MAX_VOICES,
  VoicePool,
  chooseVictim,
  cooldownRemaining,
  isCoolingDown,
  jitter,
  type VoiceSlot,
} from './voices';
import { seededRng } from './fixtures';

function slot(token: number, overrides: Partial<VoiceSlot> = {}): VoiceSlot {
  return {
    token,
    id: overrides.id ?? `s${token}`,
    bus: overrides.bus ?? 'weapons',
    priority: overrides.priority ?? 50,
    loop: overrides.loop ?? false,
    startedAt: overrides.startedAt ?? token,
  };
}

describe('voice 池容量', () => {
  it('默认上限 32，超过硬顶被夹取', () => {
    expect(new VoicePool().limit).toBe(DEFAULT_MAX_VOICES);
    expect(DEFAULT_MAX_VOICES).toBeLessThanOrEqual(32);
    expect(new VoicePool({ maxVoices: 1000 }).limit).toBe(HARD_MAX_VOICES);
    expect(new VoicePool({ maxVoices: 0 }).limit).toBe(1);
  });

  it('未达上限时直接接受', () => {
    const pool = new VoicePool({ maxVoices: 2 });
    const result = pool.admit({ id: 'rifle', bus: 'weapons', priority: 80, loop: false, now: 0 });
    expect(result.slot).not.toBeNull();
    expect(result.stolen).toHaveLength(0);
    expect(result.reason).toBe('fits');
    expect(pool.activeCount).toBe(1);
  });

  it('达到上限后抢占最早开始的同优先级 voice', () => {
    const pool = new VoicePool({ maxVoices: 2 });
    pool.admit({ id: 'a', bus: 'weapons', priority: 50, loop: false, now: 0 });
    pool.admit({ id: 'b', bus: 'weapons', priority: 50, loop: false, now: 1 });
    const result = pool.admit({ id: 'c', bus: 'weapons', priority: 50, loop: false, now: 2 });
    expect(result.reason).toBe('preempted');
    expect(result.stolen.map((item) => item.id)).toEqual(['a']);
    expect(pool.activeCount).toBe(2);
    expect(pool.active.map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('低优先级先被抢占', () => {
    const pool = new VoicePool({ maxVoices: 2 });
    pool.admit({ id: 'high', bus: 'weapons', priority: 80, loop: false, now: 0 });
    pool.admit({ id: 'low', bus: 'weapons', priority: 10, loop: false, now: 1 });
    const result = pool.admit({ id: 'mid', bus: 'weapons', priority: 60, loop: false, now: 2 });
    expect(result.stolen.map((item) => item.id)).toEqual(['low']);
    expect(pool.active.map((item) => item.id)).toEqual(['high', 'mid']);
  });

  it('更高优先级的请求无法抢占更高优先级的 voice', () => {
    const pool = new VoicePool({ maxVoices: 1 });
    pool.admit({ id: 'important', bus: 'ui', priority: 90, loop: false, now: 0 });
    const result = pool.admit({ id: 'quiet', bus: 'weapons', priority: 10, loop: false, now: 1 });
    expect(result.slot).toBeNull();
    expect(result.reason).toBe('pool_full');
    expect(pool.active.map((item) => item.id)).toEqual(['important']);
  });

  it('同优先级优先抢占非循环音效', () => {
    const pool = new VoicePool({ maxVoices: 2 });
    pool.admit({ id: 'loop', bus: 'ambience', priority: 20, loop: true, now: 0 });
    pool.admit({ id: 'oneShot', bus: 'footsteps', priority: 20, loop: false, now: 5 });
    const result = pool.admit({ id: 'step', bus: 'footsteps', priority: 20, loop: false, now: 6 });
    expect(result.stolen.map((item) => item.id)).toEqual(['oneShot']);
    expect(pool.active.map((item) => item.id)).toContain('loop');
  });

  it('每总线上限生效且只在同一总线内抢占', () => {
    const pool = new VoicePool({ maxVoices: 8, perBus: { ui: 1 } });
    pool.admit({ id: 'ui1', bus: 'ui', priority: 60, loop: false, now: 0 });
    pool.admit({ id: 'weapons1', bus: 'weapons', priority: 80, loop: false, now: 0 });
    const result = pool.admit({ id: 'ui2', bus: 'ui', priority: 70, loop: false, now: 1 });
    expect(result.stolen.map((item) => item.id)).toEqual(['ui1']);
    expect(pool.countForBus('weapons')).toBe(1);
    expect(pool.countForBus('ui')).toBe(1);
  });

  it('总线内全为高优先级时返回 bus_full', () => {
    const pool = new VoicePool({ maxVoices: 8, perBus: { ui: 1 } });
    pool.admit({ id: 'uiHigh', bus: 'ui', priority: 90, loop: false, now: 0 });
    const result = pool.admit({ id: 'uiLow', bus: 'ui', priority: 10, loop: false, now: 1 });
    expect(result.slot).toBeNull();
    expect(result.reason).toBe('bus_full');
  });

  it('release 与 clearBus 释放额度', () => {
    const pool = new VoicePool({ maxVoices: 2 });
    const first = pool.admit({ id: 'a', bus: 'weapons', priority: 50, loop: false, now: 0 });
    pool.admit({ id: 'b', bus: 'footsteps', priority: 50, loop: false, now: 0 });
    expect(first.slot).not.toBeNull();
    expect(pool.release((first.slot as VoiceSlot).token)?.id).toBe('a');
    expect(pool.activeCount).toBe(1);
    const cleared = pool.clearBus('footsteps');
    expect(cleared.map((item) => item.id)).toEqual(['b']);
    expect(pool.activeCount).toBe(0);
    expect(pool.release(999)).toBeNull();
  });

  it('clearAll 清空并返回全部', () => {
    const pool = new VoicePool({ maxVoices: 4 });
    pool.admit({ id: 'a', bus: 'weapons', priority: 50, loop: false, now: 0 });
    pool.admit({ id: 'b', bus: 'ui', priority: 50, loop: false, now: 0 });
    expect(pool.clearAll().map((item) => item.id)).toEqual(['a', 'b']);
    expect(pool.activeCount).toBe(0);
  });
});

describe('抢占顺序纯函数', () => {
  it('优先级最低者胜出', () => {
    const victim = chooseVictim(
      [slot(1, { priority: 80 }), slot(2, { priority: 20 }), slot(3, { priority: 50 })],
      { priority: 60 },
    );
    expect(victim?.token).toBe(2);
  });

  it('同优先级更早开始者胜出', () => {
    const victim = chooseVictim(
      [slot(1, { startedAt: 3 }), slot(2, { startedAt: 1 }), slot(3, { startedAt: 2 })],
      { priority: 50 },
    );
    expect(victim?.token).toBe(2);
  });

  it('全部候选优先级更高时返回 null', () => {
    expect(chooseVictim([slot(1, { priority: 90 })], { priority: 50 })).toBeNull();
    expect(chooseVictim([], { priority: 50 })).toBeNull();
  });
});

describe('冷却窗口', () => {
  it('首次播放不受冷却限制', () => {
    expect(isCoolingDown(undefined, 100, 0.5)).toBe(false);
    expect(cooldownRemaining(undefined, 100, 0.5)).toBe(0);
  });

  it('窗口内冷却，恰好到点解除', () => {
    expect(isCoolingDown(10, 10.2, 0.5)).toBe(true);
    expect(isCoolingDown(10, 10.5, 0.5)).toBe(false);
    expect(isCoolingDown(10, 11, 0.5)).toBe(false);
    expect(cooldownRemaining(10, 10.2, 0.5)).toBeCloseTo(0.3, 9);
    expect(cooldownRemaining(10, 10.6, 0.5)).toBe(0);
  });

  it('cooldown 为 0 或负数时不限制', () => {
    expect(isCoolingDown(1, 1.0001, 0)).toBe(false);
    expect(isCoolingDown(1, 1.0001, -5)).toBe(false);
  });
});

describe('随机化', () => {
  it('抖动以 base 为中心且在 ±amount 内', () => {
    expect(jitter(() => 0, 1, 0.1)).toBeCloseTo(0.9, 9);
    expect(jitter(() => 0.5, 1, 0.1)).toBeCloseTo(1, 9);
    expect(jitter(() => 0.999999, 1, 0.1)).toBeCloseTo(1.1, 5);
    expect(jitter(() => 0.5, 0.4, 0.25)).toBeCloseTo(0.4, 9);
  });

  it('amount 为 0 时不做抖动', () => {
    expect(jitter(() => 0, 0.7, 0)).toBe(0.7);
  });

  it('异常随机值不会放大抖动', () => {
    const value = jitter(() => Number.NaN, 1, 0.2);
    expect(value).toBeGreaterThanOrEqual(0.8);
    expect(value).toBeLessThanOrEqual(1.2);
  });

  it('确定性随机源产生可复现序列', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
