# 07 · 从 v0 迁移

> 状态：已定（2026-10-19）。v0 = `../petween-desktop`（v0.8.1）+ 子模块 `vendor/petween`、`vendor/petween-physics`。

原则：**按契约移植，不整块复制。** 每移植一个模块，先对照本仓库文档改接口，再搬实现，**测试一起搬**。

## 搬（改接口后）

| v0 位置 | 去向 | 说明 |
|---|---|---|
| `petween/src/core/pet-state-resolver.ts` + `state-machine.ts` + 测试 | `brain-default` 插件 | 稳定化规则是踩坑换来的，原样保留；输出从 `MotionTarget` 改为状态键 |
| `petween/src/motion/timeline-*`、`animation-definition.ts` | `keyframes` 动作类型 | 去掉 `pose-swap` 事件的「指定 pose」语义，改为通用标记 |
| `petween/src/motion/ambient-engine.ts` | `sine` / `noise` 动作类型 | bounce / sway / breathe 拆成独立动作 |
| `petween/src/core/transition-presets.ts` | 内置宠物包模板里的具名动作 | 预设变成数据 |
| `petween/src/client/overlay/particles.ts` | 一个 L3 插件 | |
| `petween-desktop/src/main/connectors/*-hooks.ts` | `claude-code` / `codex` 插件的 hook 安装逻辑 | Node fs → `ctx.host.fs` |
| `petween-desktop/src/main/connectors/hook-connector.ts` 的 watchdog | 内核会话表 | 参数化，见 05 §3 |
| `petween-desktop/src/main/connectors/line-count.ts`、`stats-ledger.ts` | `stats-hud` 插件 | |
| `petween-desktop/src/main/connectors/*-dialogue-source.ts` | connector 的 `extra` + 一个插件 | 读 transcript 需要 `fs:read` |
| `petween-desktop/src/main/pointer-through-logic.ts` | 运行时命中检测 | 纯几何，可直接搬 |
| `petween-desktop/src/renderer/companions/roamer/*` | `roamer` 插件 | 1ms flashPose hack 改为 `state` 租约；per-action 图片改为宠物包里的 `roamer.*` 状态键 |
| `petween-desktop/src/renderer/companions/bubbles/*` | `bubble` 插件 | |
| `petween-desktop/src/renderer/companions/stats-hud/*` | `stats-hud` 插件 | |
| `petween-physics` | `physics` 插件 | 改为 `position` 租约 + `spring` 动作 |

## 不搬

| v0 内容 | 原因 |
|---|---|
| `petween/src/integration/dsh/*`、`host/migrate*.ts`、DSH 相关依赖（`@deepseek-ai/*`） | DSH 形态已停止维护 |
| `PoseKey` 六槽、`states: Record<PoseKey, …>` | 被开放状态键 + 回退取代 |
| `flashPose` / `flashAsset` / `getExternalPoseHold` | 被 `clip` / `state` 通道取代 |
| 本地 HTTP 伺服页面、SSE 状态通道、`RoutesHost` | Tauri 下运行时直接持有状态，不需要 HTTP 同源绕路 |
| `ConfigHub` 3 秒轮询 | 设置与运行时之间用 Tauri 事件 |
| Electron 主进程（窗口、托盘、穿透） | 用 Rust 重写；思路参考 `pointer-through.ts` |
| 动画编辑器（`TimelineEditor`、`BezierCurveEditor`、`KeyframeInspector` 等） | 作者决定（2026-10-19）：M3 **重新设计**，不搬 |
| 设置页等所有前端 UI 的外观 | 作者决定（2026-10-19）：**重新设计**，不照搬 v0；只搬背后的逻辑 |

## v0 数据导入工具

已实现为一次性脚本 `tools/convert-v0.mjs`（作者决定不做通用导入功能）。默认读 `%APPDATA%/petween-desktop/petween-home`，写到 `%APPDATA%/com.petween.app/pets`；`--main` 同时把主宠物换成 v0 当前激活的那只。规则：

- 6 个 pose 槽 → 6 个 `still` 片段（`idle`、`thinking`……）。
- 状态映射：`idle/waiting/success/error` 同名；`thinking` → `active.thinking`；`working` → `active`。
- `TransitionConfig` 的预设 → 具名 `keyframes` 动作（直接读 v0 源码里的预设表，`pose-swap` 时刻变成 `swap` 标记）；ambient 的 sway / breathe → `sine`，bounce（随机间隔跳动）近似为 `noise`，在报告里注明。
- 图片统一缩到长边 ≤ 512px 的 WebP；v0 按 160px 方框显示，换算进片段的 `scale`。
- 用户自建动画（`user:*`）→ `keyframes` 动作；带 `pose` 的 pose-swap 事件丢弃并在导入报告里列出。
- roamer 的 per-action 图片 → `roamer.*` 状态的片段。
