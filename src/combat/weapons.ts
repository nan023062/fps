import type { WeaponId, WeaponSpec, WeaponState } from '../game/types';

/**
 * 原创武器数值。距离单位为米，角度为弧度，时间单位为秒。
 * 后坐力与扩散均按时间积分，保证不同刷新率下手感一致。
 */
export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  rifle: {
    id: 'rifle',
    name: 'AK-12 突击步枪',
    shortName: 'AK-12',
    damage: 31,
    headshotMultiplier: 3.6,
    cooldown: 0.1,
    magSize: 30,
    reserveMax: 90,
    reloadTime: 2.4,
    baseSpread: 0.0028,
    bloomPerShot: 0.004,
    maxBloom: 0.036,
    recoilKick: 0.011,
    auto: true,
  },
  pistol: {
    id: 'pistol',
    name: 'P-9 手枪',
    shortName: 'P-9',
    damage: 24,
    headshotMultiplier: 3.6,
    cooldown: 0.17,
    magSize: 12,
    reserveMax: 48,
    reloadTime: 1.9,
    baseSpread: 0.0035,
    bloomPerShot: 0.006,
    maxBloom: 0.04,
    recoilKick: 0.009,
    auto: false,
  },
};

export function createWeapon(id: WeaponId): WeaponState {
  const spec = WEAPONS[id];
  return {
    id,
    mag: spec.magSize,
    reserve: spec.reserveMax,
    cooldown: 0,
    reloadTimer: 0,
    reloading: false,
    bloom: 0,
  };
}

export function updateWeapon(state: WeaponState, dt: number): void {
  state.cooldown = Math.max(0, state.cooldown - dt);
  state.bloom = Math.max(0, state.bloom - dt * 0.055);
  if (state.reloading) {
    state.reloadTimer -= dt;
    if (state.reloadTimer <= 0) {
      finishReload(state);
    }
  }
}

export function canShoot(state: WeaponState): boolean {
  return !state.reloading && state.cooldown <= 0 && state.mag > 0;
}

export function consumeShot(state: WeaponState): boolean {
  if (!canShoot(state)) return false;
  const spec = WEAPONS[state.id];
  state.mag -= 1;
  state.cooldown = spec.cooldown;
  state.bloom = Math.min(spec.maxBloom, state.bloom + spec.bloomPerShot);
  return true;
}

export function startReload(state: WeaponState): boolean {
  const spec = WEAPONS[state.id];
  if (state.reloading || state.mag >= spec.magSize || state.reserve <= 0) {
    return false;
  }
  state.reloading = true;
  state.reloadTimer = spec.reloadTime;
  return true;
}

export function finishReload(state: WeaponState): void {
  const spec = WEAPONS[state.id];
  const need = spec.magSize - state.mag;
  const take = Math.min(need, state.reserve);
  state.mag += take;
  state.reserve -= take;
  state.reloading = false;
  state.reloadTimer = 0;
}

export function refillWeapon(state: WeaponState): void {
  const spec = WEAPONS[state.id];
  state.mag = spec.magSize;
  state.reserve = spec.reserveMax;
  state.cooldown = 0;
  state.reloadTimer = 0;
  state.reloading = false;
  state.bloom = 0;
}

export function currentSpread(
  state: WeaponState,
  moving: number,
  crouching: boolean,
  airborne: boolean,
): number {
  const spec = WEAPONS[state.id];
  const moveSpread = Math.min(1, Math.max(0, moving)) * 0.012;
  const airSpread = airborne ? 0.025 : 0;
  const stance = crouching ? 0.75 : 1;
  return (spec.baseSpread + state.bloom + moveSpread + airSpread) * stance;
}
