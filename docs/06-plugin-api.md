# 06 · 插件 API

> 状态：已定（2026-10-19）。具体方法签名在实现时细化，本文定形状和边界。

## 1. 信任模型

装插件 = 信任作者。插件代码在运行时里和内核同权运行，不做沙盒。manifest 里的 `permissions` 只用于安装时向用户展示「这个插件会做什么」，不做拦截。

内核仍然做**稳定性隔离**（不是安全隔离）：插件的每个回调都包在 try/catch 里；动作求值超预算会被停用；一个插件激活失败不影响其他插件。

## 2. 插件结构

```
plugins/roamer/
├─ plugin.json
├─ main.js          运行时入口（ESM），跑在舞台 webview
├─ settings.js      （可选）自带设置页，跑在设置窗口（§8）
├─ assets/          （可选）插件自带的图、片段
└─ bin/             （可选）L4 sidecar 可执行文件
```

### plugin.json

```jsonc
{
  "id": "roamer",                       // 小写、短横线；也是状态键前缀
  "name": "漫游",
  "version": "1.2.0",
  "apiVersion": 1,                      // 依赖的插件 API 大版本
  "main": "main.js",
  "settings": "settings.js",
  "dependencies": { "physics": "^1.0.0" },   // 可选；决定加载顺序
  "permissions": ["fs:read", "shell"],       // 仅展示

  "contributes": {                      // 声明式贡献：不用运行代码就能知道
    "stateKeys": [
      { "key": "roamer.walk",  "label": "走路" },
      { "key": "roamer.doze",  "label": "打瞌睡" }
    ],
    "motionTypes": ["roamer:wobble"],
    "channels": ["state", "position", "motion"],   // 会写哪些通道（检查器与开关用）
    "sidecar": { "command": "bin/helper.exe" }     // L4，可选
  }
}
```

`contributes.stateKeys` 让宠物包编辑器在插件**没启动**时也能列出它的状态键。

## 3. 生命周期

```ts
export default definePlugin({
  activate(ctx: PluginContext) {
    // 在这里注册一切。ctx 上注册的东西在停用时全部自动清理：
    // 订阅、租约、注册表条目、舞台层、定时器（用 ctx.setTimeout）、sidecar 进程
  },
  deactivate?() { /* 只在需要额外清理时写 */ },
})
```

- 加载顺序：按 `dependencies` 拓扑排序；无依赖者按 id 排序（确定性）。
- 热重载：开发模式下监听插件文件夹，变化时 停用 → 重新 import → 激活。依赖它的插件一起重载。
- 版本：`apiVersion` 大版本不同的插件拒绝加载并提示。API 只增不改（bump and widen, never mutate）。

## 4. PluginContext 一览

```ts
interface PluginContext {
  readonly id: string
  readonly log: Logger

  // —— 宠物 ——
  pets: {
    list(): PetHandle[]
    on(event: 'added' | 'removed', fn: (pet: PetHandle) => void): Disposable
  }

  // —— 信号 ——
  agent: {
    on(event: 'event', fn: (e: AgentEvent) => void): Disposable
    sessions(): SessionInfo[]
  }

  // —— 注册表（扩展点，见 01 §3） ——
  register: {
    connector(def: ConnectorDef): Disposable
    brain(def: BrainDef): Disposable
    motionType(def: MotionType): Disposable
    clipType(def: ClipTypeDef): Disposable
    transitionType(def: TransitionTypeDef): Disposable
    bindingRule(def: BindingRuleDef): Disposable
  }

  // —— 舞台与界面 ——
  stage: {
    addLayer(opts: { z: number; hitTest?: (x: number, y: number) => boolean }): StageLayer  // 拿到一个 DOM 容器
    openWindow(opts: WindowOptions): PluginWindow                                          // 独立窗口
  }
  tray: { addItem(item: TrayItem): Disposable }

  // —— 存储 ——
  settings: Store       // 本插件的设置（设置页读写同一份）
  data: Store           // 本插件的运行数据

  // —— 宿主能力（透传给 Rust） ——
  host: {
    fs: { read, write, list, watch, ... }
    shell: { exec(cmd, args, opts): Promise<ExecResult> }
    http: { fetch(...) }
    openExternal(url: string): Promise<void>
    sidecar?: SidecarHandle   // contributes.sidecar 声明时可用：stdin/stdout 消息通道
  }

  // —— 插件间 ——
  bus: { emit(topic: string, payload: unknown): void; on(topic, fn): Disposable }
  services: { provide(name, impl): Disposable; use<T>(name): T | undefined }

  setTimeout / setInterval / requestFrame   // 自动随插件清理
}

interface PetHandle {
  readonly id: string
  readonly pack: PetPackInfo
  readonly position: { x: number; y: number }
  readonly velocity: { x: number; y: number }
  readonly bounds: Rect                        // 当前画面在桌面上的包围盒

  on(event: 'stateKey' | 'clip' | 'input' | 'playback', fn): Disposable
  channel(name: 'state' | 'clip' | 'position' | 'bubble'): ChannelApi   // 02 §2
  motion: { add(source: MotionSource | MotionRef, opts: { layer; blend?; weight? }): MotionHandle }

  // 便捷方法（都是 channel / motion 的薄包装）
  showState(key: string, opts?): Lease | null
  say(text: string, opts?): BubbleHandle
  play(motion: MotionRef, opts?): MotionHandle     // 一次性动作，默认 plugin 层
  pluginConfig<T>(): T | undefined                  // 宠物包里给本插件的配置（04 §5）
}
```

## 5. 自由度分级

| 级别 | 能做什么 | 用到的 API | 和别人的关系 |
|---|---|---|---|
| **L0 数据** | 做宠物包 | 无代码 | — |
| **L1 语义** | 订阅信号，让宠物进入某状态、说话 | `agent.on`、`showState`、`say` | 外观由宠物包决定，自动适配任何宠物 |
| **L2 通道** | 控制画面、位置、运动 | `channel()`、`motion.add` | 经过仲裁，可共存 |
| **L3 舞台** | 在屏幕上画任何东西，开自己的窗口 | `stage.addLayer`、`openWindow` | 各画各的 |
| **L4 替换 / 外部** | 替换大脑、渲染器、绑定规则；自带原生程序 | `register.brain` 等、`sidecar` | 独占槽位，用户在设置里选用哪个 |

**规则**：能用低级别实现的，文档和示例都引导用低级别。高级别永远可用，但设置页会标出「此插件替换了默认大脑」之类的提示。

## 6. 内置插件清单（v1）

| id | 级别 | 做什么 |
|---|---|---|
| `core` | L4 | 内置注册表条目：四种动作类型、四种过渡类型、`single` 绑定规则 |
| `claude-code` | L4（connector） | Claude Code hook 接入（设置 `configDirs` 可装进多个配置目录） |
| `codex` | L4（connector） | Codex hook 接入 |
| `zcode` | L4（connector） | zcode hook 接入 |
| `brain-default` | L4（brain） | 稳定化规则 + 状态键派生（05 §4） |
| `bubble` | L3 | 气泡渲染（`bubble` 通道的消费者） |
| `physics` | L2 | 拖拽、抛掷、重力、撞墙回弹、贴地滑行（撞墙/滑行表情走 `physics.hit` / `physics.slide` 状态键） |
| `per-session` | L4（binding） | 每个会话生成一只临时宠物，会话结束后离开 |
| `roamer` | L2 + L3 | 自主漫游、小动作、便签（**暂缓**：作者打算以后重新设计，见 09） |
| `stats-hud` | L1 + L3 | 统计面板 |
| `particles` | L3 | 粒子特效（撒花、星星、闪光、爱心、落樱、烟花）。触发方式见下 |

**`particles` 的三种触发方式**：

1. **进入状态**：设置里的「成功时 / 出错时」是用户默认值；宠物包可以在 `plugins.particles.onState` 里加、改或关掉（`null`），宠物包优先（04 §5）。键按点号前缀匹配，最长者胜（`success` 覆盖 `success.big`）。粒子等新画面真正换上时才放（最多等 1.5 秒），所以和换脸同步。
2. **片段标记**：片段的 `markers` 里名字为 `particle:<特效>` 的标记，播到那一帧就放。
3. **其他插件**：`ctx.services.use('particles')` 得到 `{ burst(宠物或坐标, 特效, { amount? }), define(id, spec), effects() }`。`define` 加的特效 id 用 `<插件 id>:<名字>`，插件停用时自己 dispose。

系统开了「减少动态效果」时不放粒子。

注意：`bubble` 通道由内核仲裁（谁的气泡先显示），但气泡**长什么样**由 `bubble` 插件画。第三方可以替换成自己的气泡样式。

## 7. 示例：最小插件

```js
export default definePlugin({
  activate(ctx) {
    ctx.agent.on('event', (e) => {
      if (e.type === 'turn-end' && e.outcome === 'error') {
        for (const pet of ctx.pets.list()) pet.say('出错啦，要不要看看日志？', { ttlMs: 4000 })
      }
    })
  },
})
```

## 8. 实现状态（apiVersion 1，M0）

**权威类型定义在 `src/api/types.ts`**，本文与它冲突时先改文档再改代码。

- **入口形状**：第三方插件的 `main.js` 是 ESM，`export default { activate(ctx) { … }, deactivate?() { … } }`（也接受直接导出 `activate`）。`definePlugin` 只是给 TS 用的恒等函数。
- **命名空间**：`register.motionType` / `register.transitionType` 的 id 必须是 `<插件 id>:<名字>`；不带前缀的名字（`keyframes`、`crossfade`…）保留给内置的 `core` 插件。这是命名规则，不是能力差异。
- **热重载**：只在托盘「插件开发模式」打开时生效。
- **托盘**：`tray.addItem` 返回的句柄带 `update({ label, checked, enabled })`。
- **宿主能力**：`host.fs`（readText / writeText〔原子写〕/ list / exists / mkdir / remove）、`host.shell.exec`、`host.openExternal`、`host.hookPort()`、`host.hookCommand(connectorId, query)`（connector 写 hook 命令时用，见 05 §1.1）、`host.paths`（home / appData）。
- **ConnectorDef**：除 `parse` 外可选 `name`、`session`（watchdog 参数，05 §3.1）、`install` / `uninstall` / `status`——设置页用它们统一显示和操作任何 connector（包括第三方的）。
- **宠物**：`pets.add({ pack, position?, scale?, persist? })` / `pets.remove(id)`；`persist: false`（缺省）的宠物不存盘，插件停用时自动移除。`pet.opaqueBounds` = 当前帧可见像素的包围盒（碰撞、定位气泡用）。
- **桌面**：`desktop.screens()` 返回各显示器工作区（全局坐标，第一个是主屏），`desktop.on('change')`。
- **文件**：`host.fs.readTail(path, maxBytes)` 读大文件末尾（对话记录）。
- **设置页**：manifest 的 `contributes.settings` 声明字段（boolean / number / string / select / list，可带 min/max/step/unit/description；`scale` 让存毫秒、显示秒），设置窗口自动生成表单，值存在 `ctx.settings` 对应的 key 下。
- **自带设置页**（M2）：manifest 的 `settings` 指向插件文件夹里的一个 ESM 文件，导出 `mount(el, api)`（可返回清理函数）。设置窗口在该插件的「设置」展开处把它挂进一个 shadow root：插件的样式漏不出去，设置窗口的样式表复制进去，所以 `btn` / `input` / `field` / `card` 等类和 `--text` / `--accent` 等颜色变量可以直接用。`api` 提供 `settings.all()` / `settings.set(key, value)`（就是运行中插件的 `ctx.settings`）、`call(method, params)`（请求运行中的插件，插件那边用 `ctx.settingsPage.handle(method, fn)` 应答；插件没在运行时报错）、`toast(msg, bad?)`、`baseUrl`。每次展开都重新加载文件，改了不用重启。同时声明了 `contributes.settings` 的话，自动表单排在自带页下面。设置是改了就生效，没有「取消 / 应用」。目前只有第三方插件能带；示例见 `examples/plugins/state-tester`。需要大窗口的界面（如编辑器）以后用 `stage.openWindow`。
- **样式**：插件可以往舞台层里插 `<style>`（宿主关闭了 Tauri 对 `style-src` 的 CSP 改写，否则运行时注入的样式会被浏览器静默拦截）。
- **clip 通道直接给片段**时，内联 `ClipDef.source` 用绝对 URL（插件自带资源走 `http://petplugin.localhost/<插件目录>/…`）。

**还没有实现、因此不在 apiVersion 1 里的**（加入时只增不改）：`stage.openWindow`、`register.clipType`、`host.http`、`host.fs.watch`、`sidecar`、插件声明的状态键在设置页展示。
