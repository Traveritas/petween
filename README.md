# petween-next

跨 agent、可扩展的桌面宠物。宠物会对 Claude Code、Codex 等 AI 编程 agent 的活动做出反应；美术可以全部用 AI 生成（图片 / GIF / 短视频）；几乎所有功能都是插件，插件作者的自由度尽量高。

本仓库是 [petween-desktop](../petween-desktop) 的重做：**先写文档定契约，再按契约移植旧代码**。

## 文档

| # | 文档 | 回答什么 |
|---|---|---|
| 00 | [愿景与边界](docs/00-vision.md) | 做给谁、v1 做什么、明确不做什么 |
| 01 | [架构总览](docs/01-architecture.md) | 进程/窗口、内核职责、每只宠物的管线 |
| 02 | [资源与仲裁](docs/02-channels.md) | 谁能改宠物的什么、冲突怎么解决 |
| 03 | [片段与动作](docs/03-clips-and-motion.md) | 画面和运动如何分离、如何合成 |
| 04 | [宠物包格式](docs/04-pet-pack.md) | 画图的人交付什么 |
| 05 | [Agent 信号](docs/05-agent-signals.md) | 各 agent 的 hook 如何变成统一信号、如何绑定到宠物 |
| 06 | [插件 API](docs/06-plugin-api.md) | 写插件的人能做什么、L0–L4 分级 |
| 07 | [从 v0 迁移](docs/07-migration.md) | 旧仓库哪些搬、哪些扔 |
| 08 | [技术原型计划](docs/08-spike.md) | 开工前要先验证的风险（已验证，含实测） |
| 09 | [路线图](docs/09-roadmap.md) | 里程碑、已确认的取舍、怎么看当前效果 |

给 AI 助手的工作约定见 [AGENTS.md](AGENTS.md)。

## 开发

前置：Windows 10+、Node.js ≥ 20、Rust stable（MSVC）。

```bash
npm install
npm run tauri dev     # 开发运行
npm test              # 单元测试（vitest）
npm run typecheck
npm run tauri build   # NSIS 安装包 → src-tauri/target/release/bundle/nsis/
```

目录：`src-tauri/` 宿主（Rust）· `src/kernel/` 内核 · `src/render/` 渲染器 · `src/plugins/` 内置插件 · `src/api/types.ts` 插件 API 类型 · `public/packs/default/` 内置宠物包 · `examples/plugins/` 示例插件 · `tools/` 一次性脚本 · `spike/` 已冻结的技术原型。

## 许可

AGPL-3.0-or-later。
