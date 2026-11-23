import * as THREE from 'three';
import type { Aabb, Vec3 } from '../core/math';
import type { LevelDefinition } from './level';
import { MaterialLibrary } from './materials';
import { buildLevel, type LevelModel } from './props';
import { PostPipeline } from './post';
import { createSkySystem, type SkySystem } from './sky';
import { DEFAULT_QUALITY, QUALITY_PRESETS, type QualityLevel, type QualityPreset } from './quality';

export interface ArenaInitOptions {
  quality?: QualityLevel;
  disablePost?: boolean;
}

function boundsOf(level: LevelDefinition): Aabb {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const box of level.boxes) {
    minX = Math.min(minX, box.min.x);
    minY = Math.min(minY, box.min.y);
    minZ = Math.min(minZ, box.min.z);
    maxX = Math.max(maxX, box.max.x);
    maxY = Math.max(maxY, box.max.y);
    maxZ = Math.max(maxZ, box.max.z);
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

/**
 * 竞技场：渲染器、相机、天空/环境、光照、关卡几何与后处理链。
 * 关卡数据由 LevelDefinition 提供，碰撞体在碰撞模块里使用同一份 boxes。
 */
export class Arena {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly level: LevelDefinition;
  readonly materials: MaterialLibrary;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere: THREE.HemisphereLight;
  private readonly ambient: THREE.AmbientLight;
  private readonly sky: SkySystem;
  private model: LevelModel;
  private pipeline: PostPipeline | null = null;
  private preset: QualityPreset;
  private readonly initOptions: ArenaInitOptions;

  constructor(container: HTMLElement, level: LevelDefinition, options: ArenaInitOptions = {}) {
    this.level = level;
    this.initOptions = options;
    this.preset = QUALITY_PRESETS[options.quality ?? DEFAULT_QUALITY];

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(this.pixelRatioFor(this.preset));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    // three r187 移除了 PCFSoftShadowMap（常量仍存在但会回落到 PCF 并打印警告），
    // 这里显式使用 PCFShadowMap，并通过 shadow.radius / blurSamples 得到软阴影。
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = level.lighting.exposure;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(
      level.lighting.fog.color,
      level.lighting.fog.near,
      level.lighting.fog.far,
    );

    const bounds = boundsOf(level);
    this.camera = new THREE.PerspectiveCamera(
      74,
      window.innerWidth / window.innerHeight,
      0.06,
      620,
    );
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    // 程序化天空 + PMREM 环境贴图（不加载外部 HDR）
    this.sky = createSkySystem(this.renderer, level.lighting);
    this.scene.add(this.sky.sky);

    this.materials = new MaterialLibrary(level.theme, this.preset.anisotropy);
    this.model = buildLevel(level, this.materials, this.preset);
    this.scene.add(this.model.root);

    if (this.sky.environment) {
      this.scene.environment = this.sky.environment;
      this.scene.environmentIntensity =
        level.lighting.ambient.envIntensity * this.preset.environmentIntensity;
    }

    this.hemisphere = new THREE.HemisphereLight(
      level.lighting.ambient.skyColor,
      level.lighting.ambient.groundColor,
      level.lighting.ambient.intensity,
    );
    this.scene.add(this.hemisphere);

    this.ambient = new THREE.AmbientLight(level.lighting.ambient.skyColor, 0.06);
    this.scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(level.lighting.sun.color, level.lighting.sun.intensity);
    const center = {
      x: (bounds.min.x + bounds.max.x) * 0.5,
      y: (bounds.min.y + bounds.max.y) * 0.5,
      z: (bounds.min.z + bounds.max.z) * 0.5,
    };
    const span = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z);
    const shadowRadius = span * 0.62 + 6;
    const sunDistance = shadowRadius * 2.2 + 20;
    this.sun.position.set(
      center.x + this.sky.sunDirection.x * sunDistance,
      center.y + Math.max(6, this.sky.sunDirection.y * sunDistance),
      center.z + this.sky.sunDirection.z * sunDistance,
    );
    this.sun.target.position.set(center.x, 0, center.z);
    this.scene.add(this.sun.target);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.preset.shadowMapSize, this.preset.shadowMapSize);
    this.sun.shadow.radius = this.preset.shadowRadius * level.lighting.shadow.radius;
    this.sun.shadow.bias = level.lighting.shadow.bias;
    this.sun.shadow.normalBias = level.lighting.shadow.normalBias;
    this.sun.shadow.camera.left = -shadowRadius;
    this.sun.shadow.camera.right = shadowRadius;
    this.sun.shadow.camera.top = shadowRadius;
    this.sun.shadow.camera.bottom = -shadowRadius;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = sunDistance + shadowRadius * 3;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.sun);

    this.rebuildPipeline();

    window.addEventListener('resize', this.handleResize);
    this.renderer.domElement.addEventListener('webglcontextlost', this.handleContextLost);
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  get quality(): QualityLevel {
    return this.preset.id;
  }

  /** 实际挂载的渲染效果，用于调试与交付报告。 */
  get renderPath(): string[] {
    return this.pipeline ? this.pipeline.describe() : ['direct'];
  }

  get meshCount(): number {
    return this.model.meshes;
  }

  /** 合并前的零件网格数量，用于对比合并收益。 */
  get detailPartCount(): number {
    return this.model.detailParts;
  }

  get sunLight(): THREE.DirectionalLight {
    return this.sun;
  }

  setView(position: Vec3, yaw: number, pitch: number): void {
    this.camera.position.set(position.x, position.y, position.z);
    this.camera.rotation.set(pitch, yaw, 0);
  }

  /**
   * 切换画质档：像素比、阴影尺寸、贴图各向异性、装饰密度与整条后处理链都会重建。
   * 重建顺序是「先建新的、再挂上、最后销毁旧的」，避免切换时出现空白帧或重复释放。
   */
  setQuality(level: QualityLevel): void {
    if (level === this.preset.id) return;
    const next = QUALITY_PRESETS[level];
    const previous = this.model;
    this.preset = next;
    this.renderer.setPixelRatio(this.pixelRatioFor(this.preset));
    this.renderer.setSize(window.innerWidth, window.innerHeight);

    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.sun.shadow.mapSize.set(this.preset.shadowMapSize, this.preset.shadowMapSize);
    this.sun.shadow.radius = this.preset.shadowRadius * this.level.lighting.shadow.radius;
    this.scene.environmentIntensity =
      this.level.lighting.ambient.envIntensity * this.preset.environmentIntensity;

    this.materials.setAnisotropy(this.preset.anisotropy);
    this.model = buildLevel(this.level, this.materials, this.preset);
    this.scene.add(this.model.root);
    this.scene.remove(previous.root);
    previous.dispose();

    this.pipeline?.dispose();
    this.pipeline = null;
    this.rebuildPipeline();
  }

  render(dt = 1 / 60): void {
    this.model.update(dt);
    this.sky.update(dt);
    // 后处理链会发起多次渲染，手动累计 renderer.info 才能拿到整帧的 draw call 统计。
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
    if (this.pipeline) {
      this.pipeline.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose(): void {
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost);
    this.pipeline?.dispose();
    this.pipeline = null;
    this.model.dispose();
    this.materials.dispose();
    this.sky.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private rebuildPipeline(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const pixelRatio = this.renderer.getPixelRatio();
    if (!this.preset.postProcessing || this.initOptions.disablePost) {
      this.pipeline = null;
      return;
    }
    this.pipeline = new PostPipeline(
      this.renderer,
      this.scene,
      this.camera,
      this.preset,
      width,
      height,
      pixelRatio,
    );
  }

  private pixelRatioFor(preset: QualityPreset): number {
    const device = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.max(0.75, Math.min(device, preset.pixelRatioCap));
  }

  private readonly handleResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatioFor(this.preset));
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.pipeline?.setSize(width, height, this.renderer.getPixelRatio());
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    console.error('WebGL 上下文丢失：请刷新页面');
    const notice = document.createElement('div');
    notice.textContent = 'WebGL 上下文丢失，请刷新页面';
    notice.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:99;background:rgba(10,11,13,0.92);color:#ffd08a;font:600 16px/1.6 system-ui;letter-spacing:0.08em';
    document.body.appendChild(notice);
  };
}
