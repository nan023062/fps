/**
 * 相机遮挡回退：从视线焦点向相机方向做一次射线查询，
 * 命中盒体时把相机拉近到命中点之内，避免第三人称/观战相机穿墙。
 */
import { rayAabb, type Aabb, type Vec3 } from '../../core/math';

export interface OcclusionOptions {
  /** 命中点前保留的距离（米），避免相机贴在面上产生近裁剪穿模。 */
  margin?: number;
  /** 允许的最小距离（米），防止相机被拉到焦点内部。 */
  minDistance?: number;
}

export const DEFAULT_OCCLUSION_MARGIN = 0.22;
export const DEFAULT_OCCLUSION_MIN_DISTANCE = 0.18;

/**
 * 返回不被遮挡的相机距离（0..desiredDistance）。
 *
 * 只做中心射线的简单回退：稳定、可确定性测试，足以保证“相机不穿墙”。
 * 起点位于盒体内部时 rayAabb 返回 0，此时夹到 minDistance。
 */
export function resolveOccludedDistance(
  origin: Vec3,
  direction: Vec3,
  desiredDistance: number,
  boxes: readonly Aabb[],
  options: OcclusionOptions = {},
): number {
  if (!(desiredDistance > 0)) return 0;
  const margin = options.margin ?? DEFAULT_OCCLUSION_MARGIN;
  const minDistance = options.minDistance ?? DEFAULT_OCCLUSION_MIN_DISTANCE;
  if (boxes.length === 0) return desiredDistance;

  let limit = desiredDistance;
  for (const box of boxes) {
    const hit = rayAabb(origin, direction, box, limit);
    if (hit === null) continue;
    const candidate = hit - margin;
    if (candidate < limit) limit = candidate;
  }
  if (limit >= desiredDistance) return desiredDistance;
  return Math.min(desiredDistance, Math.max(minDistance, limit));
}
