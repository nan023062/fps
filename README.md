# DUST STRIKE · 浏览器 FPS

一个可离线运行的 CS 风格网页第一人称射击游戏：Vite + TypeScript + Three.js，3v3 回合歼灭，先取 5 分者胜。

## 运行

```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览 dist
npm test           # Vitest 纯逻辑测试
```

要求桌面浏览器支持 WebGL2 与 Pointer Lock（Chrome / Edge / Firefox 新版本）。

## 操作

| 按键 | 功能 |
| --- | --- |
| W A S D | 移动 |
| 鼠标 | 瞄准 |
| 左键 | 射击 |
| R | 换弹 |
| 1 / 2 | 切换步枪 / 手枪 |
| Space | 跳跃 |
| Ctrl / C | 下蹲 |
| Shift | 静步 |
| Tab | 计分板 |
| Esc | 释放鼠标并暂停 |
| F1 / F2 / F3 | 切换低 / 中 / 高画质 |

点击「开始对局」后鼠标锁定；按 Esc 会释放鼠标并暂停，点击「继续对局」恢复。

## 画质档位

默认高画质，也可用 URL 参数固定：`?quality=low` / `?quality=medium` / `?quality=high`。

| 档位 | 像素比上限 | 阴影贴图 | 环境光遮蔽 | 泛光 | 抗锯齿 | 色彩分级 / 暗角 |
| --- | --- | --- | --- | --- | --- | --- |
| high（默认） | 1.75 | 2048 | GTAO | 有 | SMAA | 有 |
| medium | 1.25 | 1024 | SSAO | 有（较弱） | SMAA | 有 |
| low | 1.0 | 512 | 关 | 关 | 关 | 关（直接渲染，无重后处理） |

三档共用：ACES Filmic 色调映射、sRGB 输出、PBR 材质、程序化天空与 PMREM 环境贴图、
方向光软阴影（PCF + shadow.radius）以及半球/环境补光。

## 技术结构

```text
src/
├── core/         主循环辅助、输入与指针锁定、数学、程序化音频
├── world/        关卡契约、地图数据、AABB 碰撞与射线、渲染管线、程序化模型、特效
├── player/       第一人称控制器、视图模型（复用 world/weapon 的程序化枪械）
├── combat/       武器数值、射击/换弹/后坐力、命中与护甲
├── ai/           Bot 感知、导航、交战与射击
├── game/         比赛与回合状态机、HUD 快照、类型
└── ui/           入口、HUD、菜单/暂停/结算、计分板、样式
```

设计约定：

- 玩法纯逻辑不 import Three.js 与 DOM，可在 Node 中测试。
- 可见几何与碰撞体来自 `LevelDefinition.boxes` 的同一份盒体定义（`src/world/level.ts` 契约）。
- 移动使用限幅步长与分轴碰撞，支持 0.45m 台阶。
- 后坐力与扩散按时间积分，不按帧数。
- 地图、音效与武器命名均为原创或程序化生成，不使用商业游戏素材。

## 关卡契约

`src/world/level.ts` 定义 `LevelDefinition`（id、name、boxes、spawns、navNodes、theme、lighting、decor）
与 `createArena(level, options)`：

```ts
import { createArena } from './src/world/level';
import { getLevel } from './src/world/levels';

const arena = createArena(getLevel('redoubt')!, { container, quality: 'high' });
```

- 默认关卡是 `src/world/map.ts` 的 `DUST_LEVEL`（id `dust`）；示例关卡在 `src/world/level_redoubt.ts`（id `redoubt`）。
- `Arena` 构造函数接受 `LevelDefinition`；战斗层只用 `WorldCollider` 的 AABB/射线接口，
  因此接入新关卡只需要新增数据，不改 `src/game`、`src/combat`、`src/ai`。
- `validateLevel()` 检查盒体尺寸、出生点是否卡在实体里、导航节点与链接是否合法。

## 已实现

- 启动菜单、操作说明、暂停与结算界面，指针锁定与菜单状态互斥。
- WASD 移动、跳跃、下蹲、静步、AABB 碰撞与台阶。
- 步枪与手枪：射速、弹匣、备弹、换弹、后坐力、扩散、爆头倍率、护甲减伤。
- 3v3：玩家 + 2 名 CT Bot 对抗 3 名 T Bot；Bot 具备视线检测、导航、走位与射击。
- 回合状态机：75 秒、歼灭或超时判定、比分推进、先到 5 分结束、回合重置。
- HUD：生命/护甲/弹药/武器、比分与计时、击杀信息、准星扩散、命中标记、受击方向、计分板、观战提示。
- Three.js 渲染：ACES Filmic + sRGB、PCF 软阴影、PBR 材质、程序化天空 + PMREM 环境贴图、
  GTAO/SSAO + Bloom + SMAA + 暗角与色彩分级，low/medium/high 三档预设。
- 程序化场景与模型：墙体倒角/压顶/壁柱、拱门、木箱、沙袋、围栏、残骸、立柱、沙丘与远景岩台；
  分段角色（躯干/四肢/头盔/护具/背包）与分层枪械（机匣/枪管/护木/弹匣/瞄具/握把/枪托），
  玩家视图模型与 Bot 共用同一份枪械构建代码；全部为程序化几何 + Canvas 贴图，无外部模型/贴图/字体。
- 特效：弹道拖尾、命中粒子、枪口闪光、浮尘粒子。
- 程序化音效：枪声、命中、换弹、回合开始/结束。

## 验证记录

- `npm test`：4 个测试文件、21 个用例通过（含关卡契约：结构校验、盒体同源、示例关卡碰撞/射线/导航路径）。
- `npm run build`：TypeScript 严格检查与 Vite 生产构建通过。
- Chrome（ANGLE D3D11 / RTX 5060 Ti）真实浏览器验证：三档画质均 60fps（requestAnimationFrame 上限），
  控制台无 error/warning、无 WebGL 异常；真实鼠标点击进入对局后指针锁定成功，
  菜单 → 对局 → 结算（CT 5:0）覆盖层依次正确出现；`probeLevel('redoubt')` 用示例关卡
  构建了完整 Arena（20 boxes → 71 meshes）后正常释放。

## 未验证与限制

- 真实浏览器中的手感、难度与画面偏好需要人工试玩确认；无头环境帧率受 60fps 上限，
  未测得三档在大量粒子/多人同屏等极限场景下的帧率差异。
- 角色与 Bot 仍为静态姿态（无骨骼动画），只有相机摆动与换弹动画。
- 示例关卡 `redoubt` 仅用于验证关卡契约（浏览器内以离屏 Arena 构建），尚未接入对局轮换。
- 当前为单机离线版本：无联机、无经济购买、无炸弹目标、无多地图轮换。
- 团队静态角色与共享 Skill、模块 Workflow 已入库；可执行成员岗位仍需在桌面为模型选型后才能登记。
