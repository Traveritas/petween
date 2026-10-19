# 08 · 技术原型计划

> 状态：第一轮已执行（2026-10-19），结果见文末。目标：在写正式代码前，用最小原型验证 Tauri 2 的风险点。预计 1–2 天。

## 要验证的风险（按严重程度）

| # | 风险 | 验证方式 | 通过标准 |
|---|---|---|---|
| 1 | 透明舞台 + 轮询穿透 | 主显示器铺满一个透明置顶窗口，放一个可拖拽的 PNG；宿主 60Hz 轮询光标，运行时用 alpha 掩码做命中检测，切换 `set_ignore_cursor_events` | 宠物可点可拖；透明处点击正常落到下面的应用；空闲 CPU < 1% |
| 2 | 渲染性能 | 同屏 3 只宠物，各自播放 512px、12fps 的 spritesheet 帧动画，叠加 sine + spring 动作 | 稳定 60fps；舞台 webview 内存 < 150MB |
| 3 | hook 接收 | 宿主内 axum 监听 127.0.0.1 随机端口；用真实 Claude Code hook 打进来，转发到运行时 | 事件端到端延迟 < 50ms |
| 4 | 多显示器 / DPI | 双屏、不同缩放比例下，拖动宠物跨屏 | 位置与大小正确，交接无闪烁 |
| 5 | 插件动态加载 | 从 app data 目录 `import()` 一个 ESM 插件 | 能加载、能热重载；CSP 配置记录在案 |
| 6 | 安装包与待机资源 | 打包 NSIS 安装包 | 安装包 < 20MB；待机总内存（含 WebView2 子进程）记录在案，与 v0 对比 |

macOS 透明窗口（需 `macOSPrivateApi`）列为第二轮，不阻塞决策。

## 失败时的退路

- 1 或 2 不通过且无合理解法 → 退回 Electron（瘦身：只保留需要的语言包、清理依赖）。01–07 的架构不受影响，只是「宿主」从 Rust 换成 Electron 主进程。
- 3–6 的问题视为工程问题，不改变选型。

## 产出

- `spike/` 目录下的原型代码（验证完即冻结，不作为正式代码的基础）。
- 本文末尾追加「结果」一节：每项实测数据、遇到的坑、最终选型结论。

## 结果（第一轮，2026-10-19）

环境：Windows 11，单显示器 2560×1600 @125%，32 逻辑核；Tauri 2.12 / WebView2；release 构建。原型在 `spike/`，运行参数 `--pets N --anim 0|1`，日志在 `%APPDATA%/com.petween.spike/spike.log`。

| # | 结论 | 实测 |
|---|---|---|
| 1 透明舞台 + 穿透 | **通过** | 用 SendInput 模拟：透明处 `WindowFromPoint` 得到下层应用，宠物上得到舞台；拖拽后旧位置恢复穿透、新位置命中。空闲（1 只静止宠物、光标不动）全进程树 CPU **0.24% 单核**（0.008% 整机） |
| 2 渲染性能 | **通过** | 3 只 × 512px 12 帧 spritesheet @12fps + sine/噪声/弹簧三层动作：**59.9fps**，最差帧 17.0ms；JS 堆 ~2MB；舞台渲染进程 37.5MB 私有 / 141MB 工作集（< 150MB）；CPU 合计约 10.6% 单核（GPU 进程 6.2%、渲染 4.0%） |
| 3 hook 接收 | **通过** | 真实 Claude Code（`claude -p`）5 类事件全部到达；宿主收到 → 运行时 → 回执 **1.3–5.1ms**；curl 往返 1.1–2.4ms |
| 4 多显示器 / DPI | **未验证** | 代码已写（每屏一个舞台、全局物理坐标、0 号舞台跑内核、其余为哑渲染端 + 输入转发），当前只有一块屏，需接第二块屏实测 |
| 5 插件动态加载 | **通过** | 自定义协议 `petplugin://`（Windows 上为 `http://petplugin.localhost/`）提供 `<app data>/plugins`，`import()` 加载 1.6–2.0ms；notify 监听文件变化 → dispose → 带版本号重新 import，热重载正常 |
| 6 安装包与待机资源 | **通过（附注）** | NSIS 安装包 **1.20 MiB**（v0 Electron：106 MiB）。待机内存见下表 |

### 待机内存对比（私有内存，进程树合计）

| 场景 | 宿主 | 浏览器主进程 | GPU 进程 | 渲染进程 | 其他 | **合计** |
|---|---|---|---|---|---|---|
| spike：1 只静止，全屏舞台 | 8.8 | 35.8 | 169.8 | 23.4 | 21.9 | **260MB** |
| spike：3 只动画，全屏舞台 | 22.9 | 36.2 | 198.1 | 37.5 | 22.2 | **317MB** |
| spike：1 只静止，600×600 舞台 | 8.8 | 34.8 | 100.7 | 27.2 | 21.7 | **193MB** |
| v0（Electron 0.8.1）待机 | — | 84.1 | 125.1 | 33.8 | 13.6 | **257MB** |

结论：**Tauri 不省运行时内存**（WebView2 本身就是 Chromium），省的是安装包体积和待机 CPU。全屏透明舞台让 GPU 进程多出约 70MB（vs 600×600）。

### 遇到的坑

1. **`AppHandle::cursor_position()` 每次调用都要跳到主线程事件循环**，60Hz 轮询会让空闲 CPU 到 1.5% 单核。改为轮询线程直接调 Win32 `GetCursorPos` 后降到 0.16%。正式代码按平台各写一个直接读取的实现。
2. **Claude Code 在 Windows 上用 PowerShell 执行 hook 命令**（本机配置如此）。`--data-binary @file` 在 PowerShell 里会被解析成 splatting 而失败。可用写法：`$input | curl.exe -s -m 2 -X POST -H "content-type: application/json" --data-binary "@-" http://127.0.0.1:<port>/hook/claude-code`。connector 安装 hook 时必须按目标 shell 生成命令（v0 已有经验，搬代码时注意）。
3. hook 命令本身的启动开销（PowerShell + curl，约数百毫秒）在 agent 一侧，不计入上面的延迟，也不受宿主控制。
4. 本机仍装着 v0 的全局 Claude Code hook，v0 没运行时每次调用都超时报错（curl 退出码 28）。迁移时需要卸载/替换旧 hook。
5. 热重载用 `?v=<时间戳>` 重新 import，旧模块不会被回收（ESM 无卸载），频繁开发时会缓慢涨内存；正式用户场景可忽略。

### CSP（已验证可用）

```
default-src 'self'; script-src 'self' http://petplugin.localhost petplugin:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src ipc: http://ipc.localhost
```

插件协议响应头：`Content-Type: text/javascript`、`Access-Control-Allow-Origin: *`、`Cache-Control: no-store`；路径限制在 plugins 目录内（拒绝 `..`）。

### 选型结论

1、2 通过，**保持 Tauri 2**，不触发 Electron 退路。全屏舞台的 GPU 内存代价（约 +70MB）**作者已接受**（2026-10-19）：总量与 v0 持平，换来插件可在全屏作画；以后如需优化，可让舞台只覆盖有内容的区域，接口不变。#4 待接第二块屏补测。

另：本机 v0 的全局 hook（Claude Code ×2 份配置、Codex、zcode）已于 2026-10-19 移除，原文件备份为 `*.bak-petween-v0`。
