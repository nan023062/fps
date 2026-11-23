import { describe, expect, it } from 'vitest';
import type { InputSnapshot } from '../core/input';
import { DUST_LEVEL } from '../world/map';
import { ROUND_END_DELAY, Match } from './match';
import { applyCameraTarget } from './threeC';
import { createCameraTarget } from '../engine/camera';

function input(overrides: Partial<InputSnapshot> = {}): InputSnapshot {
  return {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    crouch: false,
    walk: false,
    fire: false,
    scoreboard: false,
    reloadRequest: false,
    switchRequest: null,
    mouseDX: 0,
    mouseDY: 0,
    pointerLocked: true,
    ...overrides,
  };
}

function tick(match: Match, snapshot: InputSnapshot, seconds: number): void {
  const steps = Math.ceil(seconds * 60);
  for (let i = 0; i < steps; i += 1) {
    match.update(1 / 60, snapshot);
  }
}

function endRoundForCT(match: Match): void {
  for (const bot of match.bots.filter((b) => b.team === 't' && b.alive)) {
    match.damageActor(bot.id, 500, false, match.player.id);
  }
  match.update(1 / 60, input());
}

describe('Match 只做编排：控制状态来自 PlayerControlSystem', () => {
  it('exposes one control state instance shared with the player facade', () => {
    const match = new Match();
    match.startMatch();
    expect(match.playerControl).toBe(match.player.control);
    expect(match.controlState).toBe(match.player.controlState);
    expect(match.controlState).toBe(match.playerControl.state);
  });

  it('drives movement and view through the intent → control system path', () => {
    const match = new Match();
    match.startMatch();
    const start = { ...match.player.position };
    tick(match, input({ forward: true, mouseDX: 50, mouseDY: -10 }), 0.5);
    expect(Math.abs(match.player.position.z - start.z)).toBeGreaterThan(0.5);
    expect(match.controlState.velocity.z).not.toBe(0);
    // 鼠标增量走的是意图里的 look delta，控制状态自己累积 yaw/pitch。
    expect(match.controlState.yaw).toBeLessThan(0);
    expect(match.controlState.pitch).toBeGreaterThan(0);
    // 运动只改角色位置：Bot 数量与队伍不变。
    expect(match.bots).toHaveLength(5);
    expect(match.bots.filter((bot) => bot.team === 'ct')).toHaveLength(2);
    expect(match.bots.filter((bot) => bot.team === 't')).toHaveLength(3);
  });

  it('applies crouch and jump through the control system', () => {
    const match = new Match();
    match.startMatch();
    tick(match, input({ crouch: true }), 0.3);
    expect(match.player.crouching).toBe(true);
    expect(match.player.eyeHeight).toBeCloseTo(1.1, 6);
    expect(match.getHudState().spread).toBeGreaterThan(0);

    match.update(1 / 60, input({ jump: true }));
    expect(match.player.grounded).toBe(false);
    tick(match, input(), 2);
    expect(match.player.grounded).toBe(true);
  });

  it('keeps weapon switching, shooting and reloading in the orchestration layer', () => {
    const match = new Match();
    match.startMatch();
    match.update(1 / 60, input({ switchRequest: 'pistol' }));
    expect(match.player.weaponId).toBe('pistol');
    expect(match.controlState.weaponId).toBe('pistol');

    match.update(1 / 60, input({ fire: true }));
    expect(match.player.currentWeapon().mag).toBe(11);
    expect(match.events.some((event) => event.kind === 'shot')).toBe(true);

    match.events.length = 0;
    match.update(1 / 60, input({ fire: false }));
    match.update(1 / 60, input({ reloadRequest: true }));
    expect(match.player.currentWeapon().reloading).toBe(true);
    expect(match.controlState.reloading).toBe(true);
    expect(match.events.some((event) => event.kind === 'reload')).toBe(true);
  });

  it('produces a camera target from the control state without touching gameplay', () => {
    const match = new Match();
    match.startMatch();
    tick(match, input({ forward: true }), 0.2);
    const state = match.controlState;
    const target = createCameraTarget();
    applyCameraTarget(target, state, { fov: 74 });
    expect(target.eye.x).toBeCloseTo(state.position.x, 9);
    expect(target.eye.z).toBeCloseTo(state.position.z, 9);
    expect(target.alive).toBe(true);
    expect(state.dead).toBe(false);
  });
});

describe('回合重置后控制状态复位', () => {
  it('resets position, velocity, stance, view and death flag on the next round', () => {
    const match = new Match();
    match.startMatch();
    const spawn = DUST_LEVEL.spawns.ct[0].pos;

    // 玩家移动、蹲伏、死亡，随后结束回合。
    tick(match, input({ forward: true, crouch: true, mouseDX: 120 }), 0.4);
    expect(match.player.crouchAmount).toBeGreaterThan(0);
    match.damageActor(match.player.id, 500, false, match.bots.find((b) => b.team === 't')!.id);
    expect(match.player.alive).toBe(false);
    expect(match.controlState.dead).toBe(true);
    expect(match.controlState.velocity).toEqual({ x: 0, y: 0, z: 0 });

    endRoundForCT(match);
    expect(match.phase).toBe('roundOver');
    tick(match, input(), ROUND_END_DELAY + 0.2);

    expect(match.round).toBe(2);
    expect(match.phase).toBe('live');
    expect(match.player.alive).toBe(true);
    expect(match.controlState.dead).toBe(false);
    expect(match.controlState.position).toEqual({ ...spawn });
    expect(match.controlState.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(match.controlState.crouchAmount).toBe(0);
    expect(match.controlState.height).toBeCloseTo(1.8, 9);
    expect(match.controlState.eyeHeight).toBeCloseTo(1.62, 9);
    expect(match.controlState.grounded).toBe(true);
    expect(match.controlState.reloading).toBe(false);
    expect(match.controlState.pitch).toBe(0);
    expect(match.player.weaponId).toBe('rifle');
    expect(match.player.currentWeapon().mag).toBe(30);
    // 重生后控制重新生效。
    const before = { ...match.controlState.position };
    tick(match, input({ forward: true }), 0.2);
    expect(Math.abs(match.controlState.position.z - before.z)).toBeGreaterThan(0.1);
  });

  it('keeps legacy player/match/combat behaviour (kill attribution, scoreboard)', () => {
    const match = new Match();
    match.startMatch();
    const victim = match.bots.find((bot) => bot.team === 't' && bot.alive)!;
    match.damageActor(victim.id, 500, false, match.player.id);
    expect(victim.alive).toBe(false);
    expect(match.player.kills).toBe(1);
    expect(match.getHudState().scoreboard.find((row) => row.isPlayer)?.kills).toBe(1);
    expect(match.getHudState().killFeed).toHaveLength(1);
  });
});
