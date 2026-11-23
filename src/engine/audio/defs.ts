/**
 * 音效定义的纯函数工具：默认值补齐、格式化、解析与数值夹取。
 * 不触碰 AudioContext，可在 Node 测试中直接验证。
 */
import { isBusId, type BusId, type SoundDef } from './types';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const DEFAULT_SOUND_DEF: Omit<SoundDef, 'id' | 'bus'> = {
  priority: 50,
  duration: 0.25,
  cooldown: 0,
  loop: false,
  gain: 1,
  pitchJitter: 0,
  gainJitter: 0,
  spatial: false,
  refDistance: 6,
  maxDistance: 60,
  rolloff: 1,
  panningModel: 'equalpower',
};

export interface SoundDefInput extends Partial<Omit<SoundDef, 'id' | 'bus'>> {
  readonly id: string;
  readonly bus: BusId;
}

/** 用默认值补齐并夹取合法范围，得到可序列化的不可变定义。 */
export function createSoundDef(input: SoundDefInput): SoundDef {
  const priority = clampRange(input.priority ?? DEFAULT_SOUND_DEF.priority, 0, 100);
  const duration = clampRange(input.duration ?? DEFAULT_SOUND_DEF.duration, 0, 60);
  const cooldown = clampRange(input.cooldown ?? DEFAULT_SOUND_DEF.cooldown, 0, 30);
  const gain = clamp01(input.gain ?? DEFAULT_SOUND_DEF.gain);
  const pitchJitter = clamp01(input.pitchJitter ?? DEFAULT_SOUND_DEF.pitchJitter);
  const gainJitter = clamp01(input.gainJitter ?? DEFAULT_SOUND_DEF.gainJitter);
  const refDistance = clampRange(input.refDistance ?? DEFAULT_SOUND_DEF.refDistance, 0.1, 100);
  let maxDistance = clampRange(input.maxDistance ?? DEFAULT_SOUND_DEF.maxDistance, refDistance, 1000);
  if (maxDistance < refDistance) maxDistance = refDistance;
  return {
    id: input.id,
    bus: input.bus,
    priority,
    duration,
    cooldown,
    loop: input.loop ?? DEFAULT_SOUND_DEF.loop,
    gain,
    pitchJitter,
    gainJitter,
    spatial: input.spatial ?? DEFAULT_SOUND_DEF.spatial,
    refDistance,
    maxDistance,
    rolloff: clampRange(input.rolloff ?? DEFAULT_SOUND_DEF.rolloff, 0, 20),
    panningModel: input.panningModel === 'HRTF' ? 'HRTF' : 'equalpower',
  };
}

/** 定义内的键顺序固定，保证格式化结果稳定（便于 diff 与快照）。 */
const FIELD_ORDER = [
  'id',
  'bus',
  'priority',
  'duration',
  'cooldown',
  'loop',
  'gain',
  'pitchJitter',
  'gainJitter',
  'spatial',
  'refDistance',
  'maxDistance',
  'rolloff',
  'panningModel',
] as const;

export function formatSoundDef(def: SoundDef): string {
  const values: Record<string, string> = {
    id: def.id,
    bus: def.bus,
    priority: String(def.priority),
    duration: String(def.duration),
    cooldown: String(def.cooldown),
    loop: String(def.loop),
    gain: String(def.gain),
    pitchJitter: String(def.pitchJitter),
    gainJitter: String(def.gainJitter),
    spatial: String(def.spatial),
    refDistance: String(def.refDistance),
    maxDistance: String(def.maxDistance),
    rolloff: String(def.rolloff),
    panningModel: def.panningModel,
  };
  return FIELD_ORDER.map((key) => `${key}=${values[key]}`).join('|');
}

export type ParseResult =
  | { readonly ok: true; readonly def: SoundDef }
  | { readonly ok: false; readonly error: string };

function parseBoolean(value: string, key: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${key} 必须是 true 或 false，收到 ${value}`);
}

function parseNumber(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是有限数字，收到 ${value}`);
  return parsed;
}

/** 解析 formatSoundDef 的输出；无法解析时返回 ok:false 而不抛异常。 */
export function tryParseSoundDef(text: string): ParseResult {
  try {
    return { ok: true, def: parseSoundDef(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseSoundDef(text: string): SoundDef {
  const fields = new Map<string, string>();
  for (const raw of text.split('|')) {
    const chunk = raw.trim();
    if (chunk.length === 0) continue;
    const separator = chunk.indexOf('=');
    if (separator <= 0) throw new Error(`字段缺少 key=value 形式：${chunk}`);
    const key = chunk.slice(0, separator).trim();
    const value = chunk.slice(separator + 1).trim();
    if (key.length === 0) throw new Error(`字段 key 为空：${chunk}`);
    fields.set(key, value);
  }

  const id = fields.get('id');
  if (!id) throw new Error('缺少 id');
  const bus = fields.get('bus');
  if (!bus) throw new Error('缺少 bus');
  if (!isBusId(bus)) throw new Error(`未知总线：${bus}`);

  const number = (key: keyof typeof DEFAULT_SOUND_DEF, fallback: number): number => {
    const raw = fields.get(key);
    return raw === undefined ? fallback : parseNumber(raw, key);
  };
  const bool = (key: 'loop' | 'spatial', fallback: boolean): boolean => {
    const raw = fields.get(key);
    return raw === undefined ? fallback : parseBoolean(raw, key);
  };

  const panning = fields.get('panningModel');
  return createSoundDef({
    id,
    bus,
    priority: number('priority', DEFAULT_SOUND_DEF.priority),
    duration: number('duration', DEFAULT_SOUND_DEF.duration),
    cooldown: number('cooldown', DEFAULT_SOUND_DEF.cooldown),
    loop: bool('loop', DEFAULT_SOUND_DEF.loop),
    gain: number('gain', DEFAULT_SOUND_DEF.gain),
    pitchJitter: number('pitchJitter', DEFAULT_SOUND_DEF.pitchJitter),
    gainJitter: number('gainJitter', DEFAULT_SOUND_DEF.gainJitter),
    spatial: bool('spatial', DEFAULT_SOUND_DEF.spatial),
    refDistance: number('refDistance', DEFAULT_SOUND_DEF.refDistance),
    maxDistance: number('maxDistance', DEFAULT_SOUND_DEF.maxDistance),
    rolloff: number('rolloff', DEFAULT_SOUND_DEF.rolloff),
    panningModel: panning === 'HRTF' ? 'HRTF' : 'equalpower',
  });
}
