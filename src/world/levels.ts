import type { LevelDefinition } from './level';
import { REDOUBT_LEVEL } from './level_redoubt';
import { DUST_LEVEL } from './map';

/** 关卡注册表：新增关卡只需在这里登记数据，战斗代码无需改动。 */
export const LEVELS: LevelDefinition[] = [DUST_LEVEL, REDOUBT_LEVEL];

export const DEFAULT_LEVEL_ID = 'dust';

export function getLevel(id: string): LevelDefinition | undefined {
  return LEVELS.find((level) => level.id === id);
}
