import './style.css';
import * as THREE from 'three';
import { createArena, validateLevel, type SurfaceKind } from '../world/level';
import { DUST_LEVEL } from '../world/map';
import { CharacterView, CORPSE_VISIBLE_SECONDS } from '../character/view';
import {
  createRenderState,
  speedFromPositions,
  type CharacterActionEvent,
  type CharacterRenderState,
} from '../character/state';
import { applyActorRenderState, applyCameraTarget, buildSpectateState } from '../game/threeC';
import { getLevel, LEVELS } from '../world/levels';
import { qualityPreset, type QualityLevel } from '../world/quality';
import { Effects } from '../world/effects';
import { ViewModel } from '../player/viewmodel';
import { InputManager, type InputSnapshot } from '../core/input';
import { AudioEngine, type BusId, type SurfaceMaterial } from '../core/audio';
import {
  CAMERA_MODES,
  CameraSystem,
  applyCameraPose,
  createCameraTarget,
  nextSpectateTarget,
  type CameraMode,
  type CameraPose,
  type SpectateCandidate,
  type SpectateState,
} from '../engine/camera';
import { Match } from '../game/match';
import type { Bot } from '../ai/bot';
import { Hud } from './hud';
import { Overlays } from './overlays';
import { resolveInitialQuality, writeStoredQuality, type QualityResolution } from './quality-preference';
import {
  applySensitivity,
  DEFAULT_SETTINGS,
  readStoredSettings,
  SETTINGS_STORAGE_KEY,
  SettingsStore,
  volumeToGain,
  type GameSettings,
  type SettingsPatch,
} from './settings';

const FIXED_STEP = 1 / 60;
const MAX_STEPS = 5;
const QUALITY_KEYS: Record<string, QualityLevel> = { F1: 'low', F2: 'medium', F3: 'high' };
/** 站立视高（米）：相机按 target.crouch 自己下沉，玩法层只给站立视点。 */
const STAND_EYE_HEIGHT = 1.62;
/** 基准 FOV 与设置默认值同源：设置面板默认 74°，可调 70–110。 */
const CAMERA_BASE_FOV = DEFAULT_SETTINGS.fov;
/** 每次开火的视觉后坐力冲量（弧度）与抖动能量，纯表现，不参与命中计算。 */
const CAMERA_RECOIL_KICK = 0.009;
const CAMERA_RECOIL_YAW = 0.003;
const CAMERA_FIRE_TRAUMA = 0.16;
const CAMERA_DEATH_TRAUMA = 0.5;
/** 相机/物理的世界上方向；音频 listener 用它保证 HRTF 不以歪头姿态计算声像。 */
const WORLD_UP = { x: 0, y: 1, z: 0 } as const;
/** 脚步事件低于该速度视为原地/滑行，不发声（对应验收“原地不动不产生脚步音”）。 */
const FOOTSTEP_MIN_SPEED = 0.35;
/** 脚步发声音源相对脚底的抬高量（米），取躯干高度接近人耳听感。 */
const FOOTSTEP_SOURCE_LIFT = 0.9;
/** 关卡表面材质 → 音频库脚步材质（音频库只有 sand/concrete/metal/wood 四套）。 */
const SURFACE_AUDIO_MATERIAL: Record<SurfaceKind, SurfaceMaterial> = {
  sand: 'sand',
  sandbag: 'sand',
  rubble: 'sand',
  stone: 'concrete',
  wall: 'concrete',
  plaster: 'concrete',
  roof: 'concrete',
  crate: 'wood',
  wood: 'wood',
  metal: 'metal',
};

function stillSnapshot(snapshot: InputSnapshot): InputSnapshot {
  return {
    ...snapshot,
    reloadRequest: false,
    switchRequest: null,
    mouseDX: 0,
    mouseDY: 0,
  };
}

class GameApp {
  private readonly arena: ReturnType<typeof createArena>;
  private readonly effects: Effects;
  private readonly viewModel: ViewModel;
  private readonly input: InputManager;
  /**
   * 音频 facade：内部是 src/engine/audio 的 AudioSystem。
   * 本类只做事件 → 播放的接线，不实现合成；总线/空间化/并发全部交给音频层。
   */
  private readonly audio = new AudioEngine();
  /** 音频接线计数（DEV 钩子可读，用于核实真实对局里各通道都被消费到）。 */
  private readonly audioStats = {
    playerShots: 0,
    botShots: 0,
    hits: 0,
    reloads: 0,
    dryFire: 0,
    roundSounds: 0,
    footsteps: 0,
    listenerUpdates: 0,
    suppressedFootsteps: 0,
  };
  /** 脚步材质分布（DEV 钩子可读，验证材质映射真的生效）。 */
  private readonly footstepMaterials: Record<string, number> = {};
  /** 干火只在扳机按下那一帧提示，避免全自动空仓被连续音刷屏。 */
  private wasFiringForDryFire = false;
  private readonly match: Match;
  private readonly hud: Hud;
  private readonly overlays: Overlays;
  /** 设置（音量/灵敏度/FOV/相机震动）：内存值 + 单键持久化，UI 只读快照。 */
  private readonly settings: SettingsStore;
  private readonly initialQuality: QualityResolution;
  /** 相机解算：只消费 CameraTarget，不读取伤害/回合/武器数值。 */
  private readonly cameraSystem: CameraSystem;
  private readonly cameraTarget = createCameraTarget({ fov: CAMERA_BASE_FOV });
  /** 玩家手动切到的模式（F5）；死亡/重生时自动回到观战/第一人称。 */
  private cameraManualMode: CameraMode | null = null;
  /** 当前观战目标（V 键在存活队友间循环）。 */
  private spectateName: string | null = null;
  private lastCameraPose: CameraPose | null = null;
  /** 相机震动调用计数（DEV 可读）：设置关闭时 skipped 增长、applied 不增长。 */
  private readonly cameraShakeStats = { applied: 0, skipped: 0 };
  private recoilSide = 1;
  /** 每个 Bot 一个 CharacterView（分段可动画模型 + 独立 AnimationMixer）。 */
  private readonly characters = new Map<string, CharacterView>();
  private readonly characterStates = new Map<string, CharacterRenderState>();
  /** 上一帧位置的扁平快照（复用对象，避免每帧为每个 Bot 分配）。 */
  private readonly characterPrev = new Map<string, { x: number; y: number; z: number; mag: number }>();
  /** 上一帧从角色动画层收到的事件（footstep/muzzle/reload/death）；仅供调试与验证。 */
  private lastCharacterEvents: CharacterActionEvent[] = [];
  private readonly characterEventCounts = { footstep: 0, muzzle: 0, reload: 0, death: 0 };
  /** DEV 调试：把全部 Bot 固定到指定动画状态观察（不参与玩法）。 */
  private characterDemo: {
    speed: number;
    crouch: number;
    alive: boolean;
    aimPitch: number;
    weaponId: 'rifle' | 'pistol';
    focus: string | null;
    distance: number;
    angle: number;
    reloading: boolean;
    firing: boolean;
  } | null = null;

  private state: 'menu' | 'playing' | 'paused' | 'over' = 'menu';
  private lastTime = performance.now();
  private accumulator = 0;
  private carry: InputSnapshot | null = null;
  private scoreboardVisible = false;
  private frames = 0;
  private fpsWindowStart = performance.now();
  private fps = 0;

  constructor() {
    const app = document.getElementById('app');
    if (!app) {
      throw new Error('缺少 #app 容器');
    }
    // 设置：单键 localStorage 容错读取（非法值逐字段回落默认），与画质键互不影响。
    this.settings = new SettingsStore();
    // 画质：URL 显式 ?quality= 优先，否则读取本地保存，最后默认 high。
    this.initialQuality = resolveInitialQuality(window.location.search);
    this.arena = createArena(DUST_LEVEL, { container: app, quality: this.initialQuality.level });
    // 玩法层与渲染层共用同一份关卡对象：换关卡时只需把 level 传给 Match。
    this.match = new Match(this.arena.level);
    this.effects = new Effects(this.arena.scene);
    this.viewModel = new ViewModel(this.arena.camera);
    // 相机系统：与可见几何共用同一份关卡盒体做遮挡回退，不额外维护碰撞数据。
    this.cameraSystem = new CameraSystem({ fov: CAMERA_BASE_FOV });
    this.cameraSystem.setOccluders(this.arena.level.boxes);
    this.hud = new Hud(app);
    this.overlays = new Overlays(app);
    this.overlays.setQuality(this.initialQuality.level, this.describeQualitySource(this.initialQuality));
    this.overlays.onQualityChange((level) => this.applyQuality(level));
    // 设置接线：面板改动 → 存储（按值写盘并通知）→ applySettings 一处生效。
    this.overlays.onSettingsChange((patch) => this.settings.update(patch));
    this.settings.subscribe((next) => this.applySettings(next));
    this.applySettings(this.settings.value);
    this.createCharacters();

    this.input = new InputManager(this.arena.canvas, (locked) => this.handleLockChange(locked));
    this.overlays.onStart(() => this.beginMatch());
    this.overlays.onResume(() => this.resume());
    this.overlays.onRestart(() => this.beginMatch());

    const spawn = this.arena.level.spawns.ct[0];
    this.cameraTarget.eye = { x: spawn.pos.x, y: spawn.pos.y + STAND_EYE_HEIGHT, z: spawn.pos.z };
    this.cameraTarget.yaw = spawn.yaw;
    this.cameraTarget.pitch = -0.03;
    // 第一帧就在出生点摆好相机，避免菜单背景从世界原点飞过来。
    this.lastCameraPose = this.cameraSystem.compute(0, this.cameraTarget);
    applyCameraPose(this.arena.camera, this.lastCameraPose);
    window.addEventListener('keydown', this.handleQualityKey);
    window.addEventListener('keydown', this.handleCameraKey);

    if (import.meta.env.DEV) {
      (window as unknown as { __DUST_STRIKE__?: unknown }).__DUST_STRIKE__ = {
        match: this.match,
        hud: () => this.match.getHudState(),
        player: () => ({
          position: { ...this.match.player.position },
          yaw: this.match.player.yaw,
          pitch: this.match.player.pitch,
          alive: this.match.player.alive,
        }),
        arena: {
          level: this.arena.level.id,
          quality: () => this.arena.quality,
          qualitySource: () => ({ ...this.initialQuality }),
          setQuality: (level: QualityLevel) => this.applyQuality(level),
          renderPath: () => this.arena.renderPath,
          meshCount: this.arena.meshCount,
          detailParts: this.arena.detailPartCount,
          fps: () => this.fps,
          state: () => this.state,
          sun: () => this.arena.sunLight.intensity,
          rendererInfo: () => {
            const gl = this.arena.renderer.getContext();
            const debug = gl.getExtension('WEBGL_debug_renderer_info');
            return {
              version: gl.getParameter(gl.VERSION) as string,
              gpu: debug ? (gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string) : 'unknown',
              calls: this.arena.renderer.info.render.calls,
              triangles: this.arena.renderer.info.render.triangles,
              programs: this.arena.renderer.info.programs?.length ?? 0,
              textures: this.arena.renderer.info.memory.textures,
              geometries: this.arena.renderer.info.memory.geometries,
              pixelRatio: this.arena.renderer.getPixelRatio(),
              shadowMap: this.arena.sunLight.shadow.mapSize.x,
            };
          },
        },
        levels: () => LEVELS.map((level) => level.id),
        characters: () => this.characterDebug(),
        characterEvents: () => this.lastCharacterEvents,
        characterEventCounts: () => ({ ...this.characterEventCounts }),
        /** DEV：把 Bot 固定到指定动画状态观察（speed/crouch/alive/aimPitch/weapon）。 */
        characterDemo: (options: Record<string, unknown> | null) => {
          this.characterDemo = options
            ? {
                speed: Number(options.speed ?? 0),
                crouch: Number(options.crouch ?? 0),
                alive: options.alive === undefined ? true : Boolean(options.alive),
                aimPitch: Number(options.aimPitch ?? 0),
                weaponId: options.weaponId === 'pistol' ? 'pistol' : 'rifle',
                focus: typeof options.focus === 'string' ? options.focus : null,
                distance: Number(options.distance ?? 2.6),
                angle: Number(options.angle ?? 0.7),
                reloading: Boolean(options.reloading ?? false),
                firing: Boolean(options.firing ?? false),
              }
            : null;
          return this.characterDemo;
        },
        characterPerf: () => {
          const views = [...this.characters.values()];
          const perCharacter = views[0]?.debug().perf ?? null;
          return {
            perCharacter,
            botCount: views.length,
            // 说明：每一帧角色在“阴影 + 深度预通道 + 主颜色通道”里各绘一次，
            // 真实 draw call 以 renderer.info（关闭 autoReset 累计整帧）为准。
            estimatedMainPassDrawCalls: perCharacter ? perCharacter.drawCalls * views.length : 0,
            estimatedShadowDrawCalls: perCharacter ? perCharacter.shadowCasters * views.length : 0,
          };
        },
        debug: () => this.arena,
        probeLevel: (id: string) => this.probeLevel(id),
        /** 相机调试钩子：当前模式、FOV、trauma、实际姿态与目标状态。 */
        camera: () => this.cameraDebug(),
        setCameraMode: (mode: CameraMode) => {
          if (!CAMERA_MODES.includes(mode)) return this.cameraSystem.mode;
          this.cameraSystem.setMode(mode);
          this.cameraManualMode = mode;
          return this.cameraSystem.mode;
        },
        cameraTrauma: (amount: number) => {
          this.cameraSystem.addTrauma(Number(amount) || 0);
          return this.cameraSystem.traumaLevel;
        },
        /** 音频调试钩子：状态、并发数、listener 与各通道计数。 */
        audio: () => this.audioDebug(),
        /** 设置调试钩子：当前生效值、真实总线增益、面板开关状态与保存值。 */
        settings: () => this.settingsDebug(),
        setSettings: (patch: Record<string, unknown>) => {
          this.updateSettings(patch as SettingsPatch);
          return this.settingsDebug();
        },
        resetSettings: () => {
          this.settings.reset();
          return this.settingsDebug();
        },
        openSettings: () => {
          this.overlays.openSettings();
          return this.settingsDebug();
        },
        closeSettings: () => {
          this.overlays.closeSettings();
          return this.settingsDebug();
        },
        /** DEV：手动播一个音效 id，返回是否真实占用 voice（用于核实通道可用）。 */
        audioPlay: (id: string, position?: { x: number; y: number; z: number }) => {
          const handle = this.audio.play(String(id), position ? { position } : {});
          return { id, active: handle.isActive(), activeVoiceCount: this.audio.activeVoiceCount };
        },
        /** DEV/下一阶段设置 UI：总线音量/静音/独享（不新增 HUD 元素）。 */
        audioBus: {
          volume: (bus: BusId, value: number) => this.setBusVolume(bus, value),
          mute: (bus: BusId, value: boolean) => this.setBusMute(bus, value),
          solo: (bus: BusId, value: boolean) => this.setBusSolo(bus, value),
          gains: () => this.audio.busGains(),
          state: (bus: BusId) => this.audio.getBusState(bus),
        },
      };
    }
    const preset = qualityPreset(this.arena.quality);
    console.info(
      `画质档：${preset.label} (${this.arena.quality}) · 来源 ${this.initialQuality.source} · 菜单可选 · F1/F2/F3 可切换`,
    );
    requestAnimationFrame(this.loop);
  }

  /**
   * 设置生效点：只调用已暴露的接口。
   * - 音量 → AudioSystem 总线（SFX 同时写 weapons 与 footsteps 两条总线；ui 总线不归设置管）
   * - FOV → CameraTarget.fov（相机内部继续做阻尼与角夹取）
   * - 相机震动 → syncCameraMode/handleEvents 里是否调用 addTrauma
   * - 灵敏度 → takeInput 里缩放鼠标增量（不修改 LOOK_SENSITIVITY 常量）
   */
  private applySettings(settings: GameSettings): void {
    this.audio.setBusVolume('master', volumeToGain(settings.master));
    this.audio.setBusVolume('weapons', volumeToGain(settings.sfx));
    this.audio.setBusVolume('footsteps', volumeToGain(settings.sfx));
    this.audio.setBusVolume('ambience', volumeToGain(settings.ambience));
    this.cameraTarget.fov = settings.fov;
    this.overlays.setSettings(settings);
  }

  /** 菜单/暂停面板都经过这里；存储层负责按值写盘与通知。 */
  private updateSettings(patch: SettingsPatch): GameSettings {
    return this.settings.update(patch);
  }

  /** 调试钩子：当前生效值 + 真实总线增益 + 面板状态 + 本机保存值。 */
  private settingsDebug(): Record<string, unknown> {
    return {
      ...this.settings.value,
      busGains: this.audio.busGains(),
      cameraTargetFov: this.cameraTarget.fov,
      panelOpen: this.overlays.settingsOpen,
      stored: readStoredSettings().settings,
      storageKey: SETTINGS_STORAGE_KEY,
      cameraShakeApplied: this.settings.value.cameraShake,
    };
  }

  private beginMatch(): void {
    // 用户手势内首次 ensure()：失败只会标记降级，不抛未捕获异常。
    if (!this.audio.ensure()) {
      console.warn(
        `音频不可用（status=${this.audio.status}），继续以静音降级运行：${this.audio.degraded ? 'degraded' : 'unknown'}`,
      );
    }
    // 保持当前档位：进入对局前再把界面选择真实交给引擎（同档为幂等调用）。
    this.applyQuality(this.arena.quality);
    this.match.startMatch();
    this.audio.roundStart();
    this.state = 'playing';
    this.accumulator = 0;
    this.carry = null;
    this.overlays.hideMenu();
    this.overlays.hidePause();
    this.overlays.hideResult();
    // 设置面板不能留在对局之上：从暂停进入设置后直接开始/重开时一并关闭。
    this.overlays.closeSettings();
    this.input.requestLock();
  }

  private resume(): void {
    this.input.requestLock();
    if (this.input.locked) {
      this.state = 'playing';
      this.overlays.hidePause();
    }
  }

  private handleLockChange(locked: boolean): void {
    if (this.state === 'menu' || this.state === 'over') return;
    if (!locked && this.state === 'playing') {
      this.state = 'paused';
      this.overlays.showPause();
    }
    if (locked && this.state === 'paused') {
      this.state = 'playing';
      this.overlays.hidePause();
    }
  }

  private finishMatch(): void {
    if (this.state === 'over') return;
    this.state = 'over';
    this.input.exitLock();
    const hud = this.match.getHudState();
    this.overlays.showResult(hud.matchWinner ?? 'ct', hud.scoreCT, hud.scoreT);
  }

  /** 界面、本地保存与引擎三处保持一致；引擎内部同档切换为幂等调用。 */
  private applyQuality(level: QualityLevel): void {
    this.arena.setQuality(level);
    this.overlays.setQuality(level, this.describeQualitySource({ level, source: 'storage' }));
    writeStoredQuality(level);
    console.info(`画质档：${qualityPreset(level).label} (${this.arena.quality})`);
  }

  /** 说明当前档位来源：URL 显式指定、本地保存还是默认值。 */
  private describeQualitySource(resolution: QualityResolution): string {
    if (resolution.source === 'url') {
      return `来自链接参数 ?quality=${resolution.level}（本次优先）`;
    }
    if (resolution.ignoredUrlValue !== undefined) {
      return `链接参数 ?quality=${resolution.ignoredUrlValue} 无效，已回落`;
    }
    if (resolution.source === 'storage') {
      return '读取本机保存的选择';
    }
    return '默认高档，可自由切换';
  }

  /**
   * 用示例关卡构建一次真实 Arena（不接入战斗），验证 LevelDefinition 契约：
   * 同一份盒体数据同时驱动可见几何与碰撞体，无需改动战斗代码。
   */
  private probeLevel(id: string): Record<string, unknown> {
    const level = getLevel(id);
    if (!level) return { ok: false, error: `未知关卡 ${id}` };
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:180px;';
    document.body.appendChild(host);
    try {
      const probe = createArena(level, { container: host, quality: 'low', disablePost: true });
      const info = {
        ok: true,
        level: level.id,
        boxes: level.boxes.length,
        meshes: probe.meshCount,
        detailParts: probe.detailPartCount,
        renderPath: probe.renderPath,
        spawns: level.spawns.ct.length + level.spawns.t.length,
        navNodes: level.navNodes.length,
        issues: validateLevel(level),
      };
      probe.dispose();
      return info;
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      host.remove();
    }
  }

  private readonly handleQualityKey = (event: KeyboardEvent): void => {
    const level = QUALITY_KEYS[event.code];
    if (!level) return;
    event.preventDefault();
    this.applyQuality(level);
  };

  private readonly loop = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTime) / 1000));
    this.lastTime = now;

    this.frames += 1;
    if (now - this.fpsWindowStart >= 500) {
      this.fps = (this.frames * 1000) / (now - this.fpsWindowStart);
      this.frames = 0;
      this.fpsWindowStart = now;
    }

    if (this.state === 'playing') {
      const snapshot = this.takeInput();
      this.accumulator = Math.min(this.accumulator + dt, 0.25);
      let steps = 0;
      let used = false;
      while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS) {
        this.match.update(FIXED_STEP, used ? stillSnapshot(snapshot) : snapshot);
        used = true;
        steps += 1;
        this.accumulator -= FIXED_STEP;
      }
      if (used) {
        this.handleEvents();
        if (this.match.phase === 'matchOver') {
          this.finishMatch();
        }
      } else {
        this.carry = snapshot;
      }
      // 空仓干火：只观察玩家武器状态，不改玩法规则（Match 不产出 dryFire 事件）。
      this.handleDryFire(snapshot);
    } else {
      this.takeInput();
    }

    this.syncWorld(dt);
    this.arena.render(dt);
    requestAnimationFrame(this.loop);
  };

  private takeInput(): InputSnapshot {
    const snapshot = this.input.snapshot();
    const merged = this.carry ? this.mergeInput(this.carry, snapshot) : snapshot;
    this.carry = null;
    this.scoreboardVisible = merged.scoreboard;
    // 灵敏度只缩放视角增量（鼠标像素），LOOK_SENSITIVITY 仍由 player/intent 决定。
    return applySensitivity(merged, this.settings.value.sensitivity);
  }

  private mergeInput(a: InputSnapshot, b: InputSnapshot): InputSnapshot {
    return {
      forward: a.forward || b.forward,
      back: a.back || b.back,
      left: a.left || b.left,
      right: a.right || b.right,
      jump: a.jump || b.jump,
      crouch: a.crouch || b.crouch,
      walk: a.walk || b.walk,
      fire: a.fire || b.fire,
      scoreboard: a.scoreboard || b.scoreboard,
      reloadRequest: a.reloadRequest || b.reloadRequest,
      switchRequest: b.switchRequest ?? a.switchRequest,
      mouseDX: a.mouseDX + b.mouseDX,
      mouseDY: a.mouseDY + b.mouseDY,
      pointerLocked: b.pointerLocked,
    };
  }

  private syncWorld(dt: number): void {
    this.syncCamera(dt);
    this.viewModel.setWeapon(this.match.player.weaponId);
    this.viewModel.setReloading(this.match.player.alive && this.match.player.currentWeapon().reloading);
    // 第三人称/观战时隐藏第一人称武器模型，避免漂浮在镜头前。
    this.viewModel.group.visible =
      this.match.player.alive && this.state !== 'menu' && this.cameraSystem.mode === 'firstPerson';
    this.viewModel.update(
      dt,
      this.match.player.speedRatio() > 0.2,
      this.match.player.crouchAmount,
    );

    const demo = import.meta.env.DEV ? this.characterDemo : null;
    for (const bot of this.match.bots) {
      const character = this.characters.get(bot.id);
      if (!character) continue;
      const state = this.characterStates.get(bot.id);
      if (!state) continue;
      const previous = this.characterPrev.get(bot.id);
      // 测速：位置差 / 渲染 dt（重生跳变由 speedFromPositions 过滤）。
      const speed = demo ? demo.speed : speedFromPositions(previous, bot.position, dt);
      const mag = bot.weapon.mag;
      const firing = previous ? mag < previous.mag : false;
      // 3C 契约：Bot 姿态 → CharacterRenderState（速度/开火来自表现层测得的量）。
      applyActorRenderState(state, bot, {
        speed,
        crouch: demo ? demo.crouch : 0,
        firing,
      });
      if (demo) {
        state.alive = demo.alive;
        state.aimPitch = demo.aimPitch;
        state.weaponId = demo.weaponId;
        state.reloading = demo.reloading;
        state.firing = demo.firing;
      }
      const events = character.update(dt, state);
      if (events.length > 0) this.handleCharacterEvents(events, bot);
      // 观战时相机位于队友头部，隐藏该模型避免看到自己的内腔；
      // 死亡后保留倒地姿势一小段时间再隐藏，保证死亡动画真实可见。
      const bodyVisible = character.isAlive || character.deathAge < CORPSE_VISIBLE_SECONDS;
      character.group.visible = bodyVisible && this.spectateName !== bot.name;
      if (previous) {
        previous.x = bot.position.x;
        previous.y = bot.position.y;
        previous.z = bot.position.z;
        previous.mag = mag;
      }
    }

    this.effects.update(dt);
    this.hud.update(
      this.match.getHudState(),
      this.scoreboardVisible && this.state === 'playing',
    );
  }

  /**
   * 相机接线：把玩法状态采集成 CameraTarget，再由 CameraSystem 解算姿态。
   * 这里不读伤害/回合/武器数值；观战候选、蹲伏量与速度都来自对外只读状态。
   */
  private syncCamera(dt: number): void {
    const demo = import.meta.env.DEV ? this.characterDemo : null;
    if (demo?.focus) {
      // DEV：固定观察某个 Bot（原 characterDemo 钩子），用调试第三人称环绕。
      const bot = this.match.bots.find((item) => item.name === demo.focus) ?? this.match.bots[0];
      this.cameraSystem.setMode('thirdPersonDebug');
      this.cameraSystem.setThirdPerson({ distance: demo.distance, height: 0 });
      this.cameraTarget.eye = { x: bot.position.x, y: bot.position.y + 1.25, z: bot.position.z };
      this.cameraTarget.yaw = demo.angle;
      this.cameraTarget.pitch = -0.12;
      this.cameraTarget.crouch = 0;
      this.cameraTarget.velocity = { x: 0, y: 0, z: 0 };
      this.cameraTarget.shake = 0;
      this.cameraTarget.fov = this.settings.value.fov;
      this.finishCameraFrame(dt);
      return;
    }

    const alive = this.match.player.alive;
    this.syncCameraMode(alive);
    // 3C 契约：CharacterState → CameraTarget（不再在 main 里手写字段）。
    applyCameraTarget(this.cameraTarget, this.match.controlState, {
      fov: this.settings.value.fov,
      spectate: alive ? null : this.spectateState(),
    });
    this.finishCameraFrame(dt);
  }

  /** 死亡观战状态：候选来自存活/倒下的 CT 队友，preferredId 由 V 键维护。 */
  private spectateState(): SpectateState {
    const candidates = this.spectateCandidates();
    if (!this.spectateName || !candidates.some((item) => item.id === this.spectateName)) {
      this.spectateName = nextSpectateTarget(candidates, null)?.id ?? null;
    }
    return buildSpectateState(candidates, this.spectateName);
  }

  private finishCameraFrame(dt: number): void {
    const pose = this.cameraSystem.compute(dt, this.cameraTarget);
    applyCameraPose(this.arena.camera, pose);
    this.lastCameraPose = pose;
    // 音频 listener 跟随“解算后”的相机姿态：只用数值，音频层不 import 相机。
    // 菜单/暂停/结算期间不推进，避免静止画面里声像漂移。
    if (this.state === 'playing') {
      this.audio.setListenerFromCamera(pose.position, pose.yaw, pose.pitch, WORLD_UP);
      this.audioStats.listenerUpdates += 1;
    }
    // 相机自己解算出的观战目标（目标死亡时会自动回退），用于隐藏对应模型。
    this.spectateName =
      this.cameraSystem.mode === 'spectate' ? this.cameraSystem.spectateId : null;
  }

  /** 震动开关的唯一入口：关闭时完全跳过 addTrauma，仅计入统计。 */
  private addCameraShake(amount: number): void {
    if (!this.settings.value.cameraShake) {
      this.cameraShakeStats.skipped += 1;
      return;
    }
    this.cameraSystem.addTrauma(amount);
    this.cameraShakeStats.applied += 1;
  }

  /** 死亡自动转观战、复活回到第一人称；F5 手动选择在当前存活期间保持。 */
  private syncCameraMode(alive: boolean): void {
    if (!alive) {
      if (this.cameraSystem.mode !== 'spectate') {
        // 相机震动开关关闭时不调用 addTrauma（目标 shake 保持 0）。
        this.addCameraShake(CAMERA_DEATH_TRAUMA);
        this.cameraSystem.setMode('spectate');
      }
      this.cameraManualMode = null;
      return;
    }
    if (this.cameraManualMode !== null) return;
    if (this.cameraSystem.mode !== 'firstPerson') {
      this.cameraSystem.setMode('firstPerson');
    }
  }

  /** 观战候选：存活与已倒下的队友都要给，由 CameraSystem 选存活目标。 */
  private spectateCandidates(): SpectateCandidate[] {
    const candidates: SpectateCandidate[] = [];
    for (const bot of this.match.bots) {
      if (bot.team !== 'ct') continue;
      candidates.push({
        id: bot.name,
        eye: bot.eyePosition(),
        yaw: bot.yaw,
        pitch: bot.pitch,
        alive: bot.alive,
      });
    }
    return candidates;
  }

  /** F5 循环三种相机模式；不占用 F1/F2/F3 画质键。 */
  private cycleCameraMode(): void {
    const index = CAMERA_MODES.indexOf(this.cameraSystem.mode);
    const next = CAMERA_MODES[(index + 1) % CAMERA_MODES.length];
    this.cameraSystem.setMode(next);
    this.cameraManualMode = next;
    console.info(`相机模式：${next} · F5 循环 · V 切换观战队友`);
  }

  /** V 键：在当前存活的队友之间循环观战目标。 */
  private cycleSpectateTarget(): void {
    const next = nextSpectateTarget(this.spectateCandidates(), this.spectateName);
    if (!next) return;
    this.spectateName = next.id;
    this.cameraSystem.setMode('spectate');
    this.cameraManualMode = 'spectate';
  }

  private readonly handleCameraKey = (event: KeyboardEvent): void => {
    if (event.code === 'F5') {
      event.preventDefault();
      this.cycleCameraMode();
      return;
    }
    if (event.code === 'KeyV' && !event.repeat) {
      this.cycleSpectateTarget();
    }
  };

  /** 调试钩子：当前模式、FOV、trauma 与实际姿态。 */
  private cameraDebug(): Record<string, unknown> {    const state = this.cameraSystem.debugState();
    return {
      ...state,
      manualMode: this.cameraManualMode,
      spectateName: this.spectateName,
      pose: this.lastCameraPose
        ? {
            position: { ...this.lastCameraPose.position },
            fov: this.lastCameraPose.fov,
            yaw: this.lastCameraPose.yaw,
            pitch: this.lastCameraPose.pitch,
            roll: this.lastCameraPose.roll,
            distance: this.lastCameraPose.distance,
          }
        : null,
      target: {
        eye: { ...this.cameraTarget.eye },
        yaw: this.cameraTarget.yaw,
        pitch: this.cameraTarget.pitch,
        fov: this.cameraTarget.fov,
        crouch: this.cameraTarget.crouch,
        alive: this.cameraTarget.alive,
      },
      occluders: this.arena.level.boxes.length,
      shakeCalls: { ...this.cameraShakeStats },
    };
  }

  /**
   * 总线控制公开方法（下一阶段设置 UI 直接调用）。
   * 返回解析后的实际增益（solo/mute 已换算），便于界面回显。
   * 不新增 HUD 元素，也不改菜单/暂停/结算流程。
   */
  setBusVolume(bus: BusId, volume: number): Record<string, number> {
    this.audio.setBusVolume(bus, Number(volume));
    return this.audio.busGains();
  }

  setBusMute(bus: BusId, muted: boolean): Record<string, number> {
    this.audio.setBusMute(bus, Boolean(muted));
    return this.audio.busGains();
  }

  setBusSolo(bus: BusId, soloed: boolean): Record<string, number> {
    this.audio.setBusSolo(bus, Boolean(soloed));
    return this.audio.busGains();
  }

  /** 调试钩子：音频状态、并发数、listener 与各通道计数。 */
  private audioDebug(): Record<string, unknown> {
    return {
      status: this.audio.status,
      degraded: this.audio.degraded,
      contextState: this.audio.contextState,
      activeVoiceCount: this.audio.activeVoiceCount,
      listener: this.audio.listenerState,
      busGains: this.audio.busGains(),
      footstepMaterials: { ...this.footstepMaterials },
      stats: { ...this.audioStats },
      characterEvents: { ...this.characterEventCounts },
    };
  }

  private handleEvents(): void {
    for (const event of this.match.events) {
      switch (event.kind) {
        case 'shot': {
          const from = new THREE.Vector3(event.from.x, event.from.y, event.from.z);
          const to = new THREE.Vector3(event.to.x, event.to.y, event.to.z);
          this.effects.tracer(from, to);
          if (event.byPlayer) {
            this.effects.muzzle(this.viewModel.getMuzzleWorldPosition());
            // 玩家自身枪声：不传坐标 → 非空间化，只经 Weapons 总线，不随视角旋转。
            this.audio.shot(event.weapon);
            this.audioStats.playerShots += 1;
            // 视觉后坐力/抖动：纯表现，不影响命中与伤害判定。
            this.recoilSide = -this.recoilSide;
            this.cameraSystem.addRecoil(CAMERA_RECOIL_KICK, this.recoilSide * CAMERA_RECOIL_YAW);
            this.addCameraShake(CAMERA_FIRE_TRAUMA);
          } else {
            this.effects.muzzle(from);
            // Bot 枪声：传开火点世界坐标 → PannerNode 负责方位与距离衰减（maxDistance 90）。
            this.audio.shot(event.weapon, { x: event.from.x, y: event.from.y, z: event.from.z });
            this.audioStats.botShots += 1;
          }
          break;
        }
        case 'impact':
          this.effects.impact(new THREE.Vector3(event.point.x, event.point.y, event.point.z));
          break;
        case 'hit':
          // 命中/爆头提示：UI 总线，非空间化（音频层强制 UI 不走 panner）。
          this.audio.hit(event.headshot);
          this.audioStats.hits += 1;
          break;
        case 'kill':
          if (event.byPlayer) this.audio.hit(true);
          break;
        case 'reload':
          this.audio.reload();
          this.audioStats.reloads += 1;
          break;
        case 'roundStart':
          this.audio.roundStart();
          this.audioStats.roundSounds += 1;
          break;
        case 'roundEnd':
          this.audio.roundEnd(event.winner === 'ct');
          this.audioStats.roundSounds += 1;
          break;
        case 'matchEnd':
          this.audio.roundEnd(event.winner === 'ct');
          this.audioStats.roundSounds += 1;
          break;
      }
    }
  }

  /**
   * 空仓干火（干扳机）提示音。
   *
   * Match 的事件流里没有 dryFire，这里只读玩家当前武器状态做表现层提示，
   * 不改变射速、换弹与伤害规则（弹匣/备弹都由 src/game 决定）。
   */
  private handleDryFire(input: InputSnapshot): void {
    const fire = input.fire && this.match.player.alive;
    const trigger = fire && !this.wasFiringForDryFire;
    this.wasFiringForDryFire = fire;
    if (!trigger) return;
    const weapon = this.match.player.currentWeapon();
    if (weapon.reloading || weapon.mag > 0 || weapon.reserve > 0) return;
    this.audio.dryFire();
    this.audioStats.dryFire += 1;
  }

  /**
   * 角色动画事件接收端。footstep/muzzle/reload/death 全部在这里汇总。
   *
   * 枪口闪光、枪声、换弹提示、击杀反馈已经由 Match 的 shot/reload/kill 事件驱动，
   * 这里不重复播放；只有 footstep 需要在本层消费：动画片段知道迈步时刻、步态与速度，
   * 但不知道世界位置，所以用角色当前真实位置（bot.position）作为空间化音源。
   */
  private handleCharacterEvents(events: CharacterActionEvent[], bot: Bot): void {
    this.lastCharacterEvents = events;
    for (const event of events) {
      this.characterEventCounts[event.kind] += 1;
      if (event.kind === 'footstep') this.playFootstep(bot, event);
    }
  }

  /** 把一次 footstep 事件变成空间化脚步声；原地/死亡/低速不发声。 */
  private playFootstep(bot: Bot, event: CharacterActionEvent): void {
    const speed = event.speed ?? 0;
    if (!bot.alive || speed < FOOTSTEP_MIN_SPEED) {
      this.audioStats.suppressedFootsteps += 1;
      return;
    }
    const position = {
      x: bot.position.x,
      y: bot.position.y + FOOTSTEP_SOURCE_LIFT,
      z: bot.position.z,
    };
    const material = this.surfaceMaterialAt(position);
    // footstep(material, speed, position)：材质+速度决定音色，position 交给 panner。
    this.audio.footstep(material, speed, position);
    this.audioStats.footsteps += 1;
    this.footstepMaterials[material] = (this.footstepMaterials[material] ?? 0) + 1;
  }

  /**
   * 由脚下盒体推导地面材质（与可见几何/碰撞体同一份 level.boxes，不额外维护数据）。
   * 只取水平范围内、顶面不高于听点+0.35m 的最高盒体，映射到音频库四种材质。
   */
  private surfaceMaterialAt(point: { x: number; y: number; z: number }): SurfaceMaterial {
    let bestTop = -Infinity;
    let kind: SurfaceKind = 'sand';
    for (const box of this.arena.level.boxes) {
      if (point.x < box.min.x || point.x > box.max.x) continue;
      if (point.z < box.min.z || point.z > box.max.z) continue;
      if (box.max.y > point.y + 0.35) continue;
      if (box.max.y > bestTop) {
        bestTop = box.max.y;
        kind = box.kind;
      }
    }
    return SURFACE_AUDIO_MATERIAL[kind] ?? 'sand';
  }

  private createCharacters(): void {
    const accent = this.arena.level.theme.accent;
    this.match.bots.forEach((bot, index) => {
      const view = new CharacterView({
        team: bot.team,
        accent: accent[bot.team],
        variant: index % 3,
      });
      view.group.position.set(bot.position.x, bot.position.y, bot.position.z);
      view.group.rotation.y = bot.yaw;
      this.arena.scene.add(view.group);
      this.characters.set(bot.id, view);
      this.characterStates.set(bot.id, createRenderState(bot.team, bot.weapon.id, index % 3));
      this.characterPrev.set(bot.id, {
        x: bot.position.x,
        y: bot.position.y,
        z: bot.position.z,
        mag: bot.weapon.mag,
      });
    });
  }

  /** 调试：每个 Bot 的动画状态与单角色 draw call/三角形。 */
  private characterDebug(): Array<Record<string, unknown>> {    return this.match.bots.map((bot) => {
      const view = this.characters.get(bot.id);
      if (!view) return { name: bot.name, missing: true };
      return { name: bot.name, visible: view.group.visible, ...view.debug() };
    });
  }
}

new GameApp();
