import * as THREE from 'three';
import { textureSizeFor } from './geometry';
import type { LevelTheme, SurfaceKind, SurfacePattern, SurfaceStyle } from './level';

/**
 * 程序化材质库：所有贴图都在 Canvas 里生成，不加载任何外部图片。
 * UV 由几何体按“米”缩放，因此贴图 repeat 固定为 1 也能保持纹理密度一致。
 */

interface PatternTextures {
  map: THREE.Texture | null;
  detail: THREE.Texture | null;
}

interface PatternSpec {
  color: string;
  tiles: number;
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
}

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function makeCanvas(size: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function noise(ctx: CanvasRenderingContext2D, size: number, seed: number, count: number, alpha: number): void {
  const random = seeded(seed);
  for (let i = 0; i < count; i += 1) {
    const shade = 90 + Math.floor(random() * 120);
    ctx.fillStyle = `rgba(${shade},${shade},${shade},${alpha})`;
    const r = 1 + random() * 2.4;
    ctx.fillRect(random() * size, random() * size, r, r);
  }
}

const PATTERNS: Record<Exclude<SurfacePattern, 'none'>, PatternSpec> = {
  sand: {
    color: '#c9ae80',
    tiles: 2.2,
    draw: (ctx, size) => {
      const random = seeded(7);
      ctx.fillStyle = '#cbb083';
      ctx.fillRect(0, 0, size, size);
      // 大尺度沙地色斑（同一个圆心，避免出现撕裂状色块）
      for (let i = 0; i < 90; i += 1) {
        const tone = 168 + Math.floor(random() * 44);
        const cx = random() * size;
        const cy = random() * size;
        const radius = 6 + random() * 18;
        const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        gradient.addColorStop(0, `rgba(${tone},${tone - 16},${tone - 46},0.09)`);
        gradient.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
      }
      // 细小风纹：短弧线，低对比度
      ctx.strokeStyle = 'rgba(156,132,94,0.16)';
      for (let i = 0; i < 46; i += 1) {
        const x = random() * size;
        const y = random() * size;
        const len = 6 + random() * 22;
        ctx.lineWidth = 0.8 + random();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + len * 0.5, y - 1.5 - random() * 2, x + len, y);
        ctx.stroke();
      }
      noise(ctx, size, 11, 7200, 0.17);
    },
  },
  stone: {
    color: '#b39a70',
    tiles: 2.4,
    draw: (ctx, size) => {
      const random = seeded(23);
      ctx.fillStyle = '#b09872';
      ctx.fillRect(0, 0, size, size);
      const rows = 6;
      const rowH = size / rows;
      for (let row = 0; row < rows; row += 1) {
        const offset = (row % 2) * 0.5;
        for (let col = -1; col < 4; col += 1) {
          const x = (col + offset) * (size / 3);
          const shade = 168 + Math.floor(random() * 34);
          ctx.fillStyle = `rgb(${shade},${shade - 18},${shade - 50})`;
          ctx.fillRect(x + 2, row * rowH + 2, size / 3 - 4, rowH - 4);
        }
      }
      ctx.strokeStyle = 'rgba(96,80,56,0.5)';
      ctx.lineWidth = 2;
      for (let row = 0; row <= rows; row += 1) {
        ctx.beginPath();
        ctx.moveTo(0, row * rowH);
        ctx.lineTo(size, row * rowH);
        ctx.stroke();
      }
      noise(ctx, size, 29, 1800, 0.14);
    },
  },
  concrete: {
    color: '#bfae93',
    tiles: 3,
    draw: (ctx, size) => {
      const random = seeded(41);
      ctx.fillStyle = '#c1b39a';
      ctx.fillRect(0, 0, size, size);
      for (let i = 0; i < 90; i += 1) {
        ctx.fillStyle = `rgba(${120 + random() * 60},${112 + random() * 55},${96 + random() * 50},0.22)`;
        const r = 6 + random() * 26;
        ctx.beginPath();
        ctx.arc(random() * size, random() * size, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(88,78,62,0.35)';
      ctx.lineWidth = 1.4;
      for (let i = 0; i < 8; i += 1) {
        let x = random() * size;
        let y = random() * size;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let step = 0; step < 5; step += 1) {
          x += (random() - 0.5) * 26;
          y += (random() - 0.5) * 26;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      noise(ctx, size, 43, 1500, 0.12);
    },
  },
  wood: {
    color: '#7a5732',
    tiles: 1.6,
    draw: (ctx, size) => {
      const random = seeded(59);
      ctx.fillStyle = '#7d5a34';
      ctx.fillRect(0, 0, size, size);
      const planks = 4;
      for (let p = 0; p < planks; p += 1) {
        const shade = 96 + Math.floor(random() * 42);
        ctx.fillStyle = `rgb(${shade + 24},${shade - 4},${Math.max(20, shade - 46)})`;
        ctx.fillRect(0, (p * size) / planks + 2, size, size / planks - 4);
        ctx.strokeStyle = 'rgba(48,32,18,0.45)';
        ctx.lineWidth = 1.2;
        for (let i = 0; i < 9; i += 1) {
          const y = (p * size) / planks + random() * (size / planks);
          ctx.beginPath();
          ctx.moveTo(0, y);
          for (let x = 0; x <= size; x += 12) {
            ctx.lineTo(x, y + Math.sin(x * 0.08 + i) * 1.6);
          }
          ctx.stroke();
        }
      }
      noise(ctx, size, 61, 900, 0.1);
    },
  },
  metal: {
    color: '#767d84',
    tiles: 1.8,
    draw: (ctx, size) => {
      const random = seeded(71);
      ctx.fillStyle = '#767d84';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = 'rgba(210,216,224,0.16)';
      for (let i = 0; i < 160; i += 1) {
        ctx.lineWidth = 0.6;
        const y = random() * size;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size, y + (random() - 0.5) * 2);
        ctx.stroke();
      }
      for (let i = 0; i < 22; i += 1) {
        ctx.fillStyle = 'rgba(60,64,70,0.5)';
        ctx.beginPath();
        ctx.arc(random() * size, random() * size, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(150,92,48,0.22)';
      for (let i = 0; i < 18; i += 1) {
        ctx.beginPath();
        ctx.arc(random() * size, random() * size, 4 + random() * 12, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  },
  cloth: {
    color: '#b6a888',
    tiles: 0.9,
    draw: (ctx, size) => {
      const random = seeded(83);
      ctx.fillStyle = '#b7a98a';
      ctx.fillRect(0, 0, size, size);
      const cell = 8;
      for (let y = 0; y < size; y += cell) {
        for (let x = 0; x < size; x += cell) {
          const odd = ((x / cell) + (y / cell)) % 2 === 0;
          ctx.fillStyle = odd ? 'rgba(160,146,118,0.5)' : 'rgba(196,182,152,0.45)';
          ctx.fillRect(x, y, cell, cell);
        }
      }
      for (let i = 0; i < 40; i += 1) {
        ctx.fillStyle = `rgba(${110 + random() * 70},${96 + random() * 60},${70 + random() * 50},0.18)`;
        ctx.fillRect(random() * size, random() * size, 2, 14);
      }
    },
  },
};

export class MaterialLibrary {
  private readonly textures = new Map<SurfacePattern, PatternTextures>();
  private readonly surfaces = new Map<string, THREE.MeshStandardMaterial>();
  private readonly plain = new Map<string, THREE.MeshStandardMaterial>();
  /** 程序化 Canvas 纹理边长：高档 512，中低档 256（按 meshDetail 联动）。 */
  private readonly textureSize: number;

  constructor(
    private readonly theme: LevelTheme,
    private anisotropy = 4,
    meshDetail?: number,
  ) {
    // Arena 会直接传 preset.meshDetail；只传 anisotropy 的调用方按各向异性过滤档位
    // （1/4/8）推算，与 QualityPreset 的低/中/高一一对应，纹理尺寸仍然正确。
    const detail =
      typeof meshDetail === 'number'
        ? meshDetail
        : anisotropy >= 8
          ? 3
          : anisotropy >= 4
            ? 2
            : 1;
    this.textureSize = textureSizeFor(detail);
  }

  /** 画质切换时更新各向异性过滤；贴图是共享的，只改参数 + 重新上传。 */
  setAnisotropy(value: number): void {
    const clamped = Math.max(1, Math.round(value));
    if (clamped === this.anisotropy) return;
    this.anisotropy = clamped;
    for (const set of this.textures.values()) {
      for (const texture of [set.map, set.detail]) {
        if (!texture) continue;
        texture.anisotropy = clamped;
        texture.needsUpdate = true;
      }
    }
  }

  /** 每种 SurfaceKind 共享一份 PBR 材质（同 kind 的 tone 分桶缓存）。 */
  surface(kind: SurfaceKind, tone = 1): THREE.MeshStandardMaterial {
    const bucket = Math.round(tone * 20) / 20;
    const key = `${kind}:${bucket}`;
    const cached = this.surfaces.get(key);
    if (cached) return cached;

    const style = this.theme.surfaces[kind] ?? this.theme.surfaces.sand;
    const material = this.build(style, bucket);
    this.surfaces.set(key, material);
    return material;
  }

  /** 非关卡盒体的小件（锈迹、玻璃、橡胶等）。 */
  detail(color: number, roughness: number, metalness: number, pattern: SurfacePattern = 'none'): THREE.MeshStandardMaterial {
    const key = `${color}:${roughness}:${metalness}:${pattern}`;
    const cached = this.plain.get(key);
    if (cached) return cached;
    const style: SurfaceStyle = { color, roughness, metalness, pattern };
    const material = this.build(style, 1);
    this.plain.set(key, material);
    return material;
  }

  tileSize(pattern: SurfacePattern): number {
    return pattern === 'none' ? 1 : PATTERNS[pattern].tiles;
  }

  /** 某类表面使用的程序化图案（决定 UV 密度）。 */
  patternOf(kind: SurfaceKind): SurfacePattern {
    return this.theme.surfaces[kind]?.pattern ?? 'none';
  }

  dispose(): void {
    for (const set of this.textures.values()) {
      set.map?.dispose();
      set.detail?.dispose();
    }
    this.textures.clear();
    for (const material of this.surfaces.values()) material.dispose();
    for (const material of this.plain.values()) material.dispose();
    this.surfaces.clear();
    this.plain.clear();
  }

  private build(style: SurfaceStyle, tone: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(style.color).multiplyScalar(tone),
      roughness: style.roughness,
      metalness: style.metalness,
      envMapIntensity: 1,
    });
    const set = this.texturesFor(style.pattern);
    if (set.map) {
      material.map = set.map;
      material.map.colorSpace = THREE.SRGBColorSpace;
    }
    if (set.detail) {
      material.roughnessMap = set.detail;
      material.bumpMap = set.detail;
      material.bumpScale = style.pattern === 'metal' ? 0.06 : 0.22;
    }
    if (style.pattern === 'metal') {
      material.metalness = Math.max(style.metalness, 0.55);
      material.roughness = Math.min(style.roughness, 0.6);
    }
    return material;
  }

  private texturesFor(pattern: SurfacePattern): PatternTextures {
    const cached = this.textures.get(pattern);
    if (cached) return cached;
    const empty: PatternTextures = { map: null, detail: null };
    if (pattern === 'none') {
      this.textures.set(pattern, empty);
      return empty;
    }
    const spec = PATTERNS[pattern];
    const size = this.textureSize;
    const colorCanvas = makeCanvas(size);
    const detailCanvas = makeCanvas(size);
    if (!colorCanvas || !detailCanvas) {
      this.textures.set(pattern, empty);
      return empty;
    }
    const colorCtx = colorCanvas.getContext('2d');
    const detailCtx = detailCanvas.getContext('2d');
    if (!colorCtx || !detailCtx) {
      this.textures.set(pattern, empty);
      return empty;
    }
    spec.draw(colorCtx, size);

    // 灰度细节图：由彩色贴图近似，用于粗糙度与轻微凹凸。
    detailCtx.drawImage(colorCanvas, 0, 0);
    detailCtx.globalCompositeOperation = 'saturation';
    detailCtx.fillStyle = '#808080';
    detailCtx.fillRect(0, 0, size, size);
    detailCtx.globalCompositeOperation = 'source-over';

    const map = new THREE.CanvasTexture(colorCanvas);
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = this.anisotropy;

    const detail = new THREE.CanvasTexture(detailCanvas);
    detail.wrapS = THREE.RepeatWrapping;
    detail.wrapT = THREE.RepeatWrapping;
    detail.anisotropy = this.anisotropy;

    const set: PatternTextures = { map, detail };
    this.textures.set(pattern, set);
    return set;
  }
}
