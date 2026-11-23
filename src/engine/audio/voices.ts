/**
 * voice 池：并发上限、优先级抢占、冷却与随机化。
 *
 * 这里不含任何 Web Audio 调用，纯数据结构 + 纯函数，便于在 Node 环境
 * 穷举抢占顺序与冷却窗口；真正的节点释放由 AudioSystem 负责。
 */
import type { BusId } from './types';

export interface VoiceRequest {
  readonly id: string;
  readonly bus: BusId;
  readonly priority: number;
  readonly loop: boolean;
  readonly now: number;
}

export interface VoiceSlot {
  readonly token: number;
  readonly id: string;
  readonly bus: BusId;
  readonly priority: number;
  readonly loop: boolean;
  readonly startedAt: number;
}

export type AdmitReason = 'fits' | 'preempted' | 'bus_full' | 'pool_full';

export interface AdmitResult {
  readonly slot: VoiceSlot | null;
  readonly stolen: readonly VoiceSlot[];
  readonly reason: AdmitReason;
}

export interface VoicePoolOptions {
  readonly maxVoices?: number;
  readonly perBus?: Partial<Record<BusId, number>>;
}

export const DEFAULT_MAX_VOICES = 32;
/** 上限硬顶，避免配置失误一次创建上百个节点。 */
export const HARD_MAX_VOICES = 64;

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(HARD_MAX_VOICES, Math.max(1, Math.floor(value)));
}

/**
 * 选出最该被抢占的 voice：优先级最低优先；同优先级时非循环优先；
 * 再同则最早开始的优先。若候选优先级都高于请求，返回 null（不抢占）。
 */
export function chooseVictim(
  slots: readonly VoiceSlot[],
  incoming: Pick<VoiceRequest, 'priority'>,
): VoiceSlot | null {
  let best: VoiceSlot | null = null;
  for (const slot of slots) {
    if (slot.priority > incoming.priority) continue;
    if (best === null) {
      best = slot;
      continue;
    }
    if (slot.priority < best.priority) {
      best = slot;
      continue;
    }
    if (slot.priority > best.priority) continue;
    if (slot.loop !== best.loop) {
      if (!slot.loop) best = slot;
      continue;
    }
    if (slot.startedAt < best.startedAt) best = slot;
  }
  return best;
}

/** 冷却窗口判定：now - lastPlayedAt 严格小于 cooldown 时仍在冷却。 */
export function isCoolingDown(
  lastPlayedAt: number | undefined,
  now: number,
  cooldown: number,
): boolean {
  if (lastPlayedAt === undefined) return false;
  if (!(cooldown > 0)) return false;
  return now - lastPlayedAt < cooldown;
}

export function cooldownRemaining(
  lastPlayedAt: number | undefined,
  now: number,
  cooldown: number,
): number {
  if (!isCoolingDown(lastPlayedAt, now, cooldown)) return 0;
  return (lastPlayedAt as number) + cooldown - now;
}

/** 抖动：rng 期望在 [0,1)。base 0 仍为 0。 */
export function jitter(rng: () => number, base: number, amount: number): number {
  if (!(amount > 0)) return base;
  const raw = rng();
  const unit = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
  return base * (1 + (unit * 2 - 1) * amount);
}

export class VoicePool {
  private readonly slots: VoiceSlot[] = [];
  private readonly perBus: Partial<Record<BusId, number>>;
  private maxVoices: number;
  private nextToken = 1;

  constructor(options: VoicePoolOptions = {}) {
    this.maxVoices = clampLimit(options.maxVoices, DEFAULT_MAX_VOICES);
    this.perBus = { ...options.perBus };
  }

  get limit(): number {
    return this.maxVoices;
  }

  get activeCount(): number {
    return this.slots.length;
  }

  get active(): readonly VoiceSlot[] {
    return this.slots;
  }

  setLimit(limit: number): void {
    this.maxVoices = clampLimit(limit, this.maxVoices);
  }

  countForBus(bus: BusId): number {
    return this.slots.filter((slot) => slot.bus === bus).length;
  }

  has(token: number): boolean {
    return this.slots.some((slot) => slot.token === token);
  }

  /**
   * 申请一个 voice 位置。必要时驱逐低优先级 voice，被驱逐的 slot 从池中
   * 移除并随结果返回，调用方负责停止与断开它们的节点。
   */
  admit(request: VoiceRequest): AdmitResult {
    const stolen: VoiceSlot[] = [];
    for (;;) {
      const busCap = this.perBus[request.bus];
      const busFull = busCap !== undefined && this.countForBus(request.bus) >= busCap;
      const poolFull = this.slots.length >= this.maxVoices;
      if (!busFull && !poolFull) break;
      const candidates = busFull ? this.slots.filter((slot) => slot.bus === request.bus) : this.slots;
      const victim = chooseVictim(candidates, request);
      if (!victim) {
        return {
          slot: null,
          stolen,
          reason: busFull && !poolFull ? 'bus_full' : 'pool_full',
        };
      }
      this.remove(victim.token);
      stolen.push(victim);
    }
    const slot: VoiceSlot = {
      token: this.nextToken,
      id: request.id,
      bus: request.bus,
      priority: request.priority,
      loop: request.loop,
      startedAt: request.now,
    };
    this.nextToken += 1;
    this.slots.push(slot);
    return { slot, stolen, reason: stolen.length > 0 ? 'preempted' : 'fits' };
  }

  release(token: number): VoiceSlot | null {
    const index = this.slots.findIndex((slot) => slot.token === token);
    if (index < 0) return null;
    const [slot] = this.slots.splice(index, 1);
    return slot;
  }

  /** 移除并返回指定总线的全部 voice。 */
  clearBus(bus: BusId): VoiceSlot[] {
    const taken = this.slots.filter((slot) => slot.bus === bus);
    for (let i = this.slots.length - 1; i >= 0; i -= 1) {
      if (this.slots[i].bus === bus) this.slots.splice(i, 1);
    }
    return taken;
  }

  clearAll(): VoiceSlot[] {
    const taken = [...this.slots];
    this.slots.length = 0;
    return taken;
  }

  private remove(token: number): void {
    const index = this.slots.findIndex((slot) => slot.token === token);
    if (index >= 0) this.slots.splice(index, 1);
  }
}
