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
├─ settings.js      （可选）设置页入口，跑在设置 webview
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
| `claude-code` | L4（connector） | Claude Code hook 接入 |
| `codex` | L4（connector） | Codex hook 接入 |
| `brain-default` | L4（brain） | 稳定化规则 + 状态键派生（05 §4） |
| `bubble` | L3 | 气泡渲染（`bubble` 通道的消费者） |
| `physics` | L2 | 拖拽、抛掷、落地回弹 |
| `roamer` | L2 + L3 | 自主漫游、小动作、便签 |
| `stats-hud` | L1 + L3 | 统计面板 |

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
- **宿主能力**：`host.fs`（readText / writeText〔原子写〕/ list / exists / mkdir / remove）、`host.shell.exec`、`host.openExternal`、`host.hookPort()`（connector 写 hook 命令时用）、`host.paths`（home / appData）。
- **clip 通道直接给片段**时，内联 `ClipDef.source` 用绝对 URL（插件自带资源走 `http://petplugin.localhost/<插件目录>/…`）。

**还没有实现、因此不在 apiVersion 1 里的**（加入时只增不改）：`stage.openWindow`、`register.clipType`、`host.http`、`host.fs.watch`、`sidecar`、插件的 `settings.js` 设置页入口、插件声明的状态键在设置页展示。
