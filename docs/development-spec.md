# DSH Motion Pet — 完整项目开发文档

> 文档版本：v0.2  
> 日期：2026-08-18  
> 项目暂定名：`dsh-motion-pet`  
> 目标平台：DeepSeek Harness（DSH）Web UI  
> 状态：可直接交给编码智能体执行（Timeline Engine 架构版）  
> 核心理念：**用少量静态 Pose 图片 + 程序化 Motion Engine，生成具有漫画感、弹性形变和循环动画的 Agent Pet。**  
> 术语对照：中文叙述中的「循环动画」即本规格技术体系里的 ambient（环境动画）能力——`AmbientEngine`、`states.*.ambient` 配置字段与 `bounce.*` / `sway.*` / `breathe.*` motion property 通道等标识符一律保留原名。


## v0.2 关键架构变更

v0.2 在 v0.1 基础上正式引入 **Keyframe Timeline Engine**，并将其设为 Motion Runtime 的底层硬性架构。

核心变化：

```text
v0.1:
Preset
  ↓
TransitionEngine / AmbientEngine
  ↓
WAAPI

v0.2:
Built-in Preset ─────┐
                     ▼
User Animation ─→ AnimationDefinition
                     │
                     ▼
               Timeline Engine
                     │
                     ▼
               Timeline Compiler
                     │
                     ▼
                 WAAPI Runtime
```

因此：

- Comic Pop / Soft / Jelly / Jump / Snap 不再以分支式 TypeScript 动画逻辑硬编码；
- Bounce / Sway / Breathing 也统一建模为 Timeline；
- V1 UI 仍保持简单，仅暴露 Preset / Strength / Duration / Ambient 参数；
- V1.1 才开放完整关键帧编辑器；
- 底层从 V1 开始就必须支持 Track、Keyframe、Event、Repeat Policy；
- `pose-swap` 正式成为 Timeline Event；
- 用户关键帧不能直接写 CSS `transform`，只能操作白名单 Motion Channel；
- Preset 必须可复制为 Custom Animation，为后续 `Customize` 功能做好数据结构准备；
- 后续允许将动画独立导出为 Motion Pack，与 Pet 图片资产解耦。

---

## 0. 给编码智能体的执行指令

本文件同时承担 PRD、技术设计、实现规范和验收清单的职责。

编码时遵守以下优先级：

1. **当前 DSH 官方源码/官方客户端插件规范**
2. 本文档的产品与架构约束
3. 当前可运行的社区 Pet 插件实现
4. 编码智能体自行推断

若本文档中某个 DSH API 与当前安装版本不一致：

- 不要为了“符合文档”而使用已废弃 API；
- 以当前 DSH 官方源码中的实际 Slot、Client Plugin、Cordis、WebServer 契约为准；
- 只在 `integration/dsh/` 层做兼容调整；
- 不要让 DSH 版本差异渗透进 Motion Engine、状态机和 Renderer；
- 在 `docs/implementation-notes.md` 记录实际采用的 DSH API 与本文档的差异。

**特别注意：不要直接照抄社区 `dsh-codex-pet` 文档中的旧 Slot 注册写法。当前 DSH 客户端规范已经收敛到 `ctx.slots.register(...)` 为主要注册入口。编码前必须读取当前版本官方源码确认。**

开发过程中优先做可运行的纵向切片，不要先写大量空接口。每个里程碑完成后必须执行对应测试，再进入下一阶段。

**v0.2 新增硬性要求：**

- 不得把 `comic-pop`、`jelly`、`bounce` 等实现成散落在 React Component / switch-case 中的专用动画；
- 所有内置动画必须首先表示为 `AnimationDefinition`；
- Motion Runtime 必须通过同一 Timeline Engine 执行内置 Preset 与未来用户自定义动画；
- V1 可以不实现高级 Timeline Editor，但数据模型、Runtime、测试必须已经允许自定义关键帧定义被加载和执行；
- 若实现过程中为了赶进度暂时需要 helper，helper 最终也必须编译为/生成 `AnimationDefinition`，不得绕过 Timeline Engine。


---

# 1. 项目目标

## 1.1 要解决的问题

目前常见 Agent Pet 有两种主要制作方式：

1. 为每个状态绘制完整 spritesheet / 多帧动画；
2. 为每个动作准备完整视频或动画素材。

这两种方式都要求创作者投入大量动画资产。

本项目采用相反方向：

> 用户只需要准备少量静态角色 Pose，Pet Runtime 自动为它们增加状态切换动画和持续动态。

例如用户只有：

```text
idle.webp
thinking.webp
happy.webp
```

插件也应该能够得到：

```text
Idle      → idle.webp + breathing / sway
Thinking  → thinking.webp + periodic bounce / sway
Working   → thinking.webp + faster pulse
Waiting   → idle.webp + slow sway
Success   → happy.webp + celebrate transition
Error     → idle.webp + deflate transition
```

核心价值不是“又一个桌宠”，而是：

> **Animation Middleware for Agent Pets**

---

## 1.2 项目成功标准

用户应该能够在 DSH 设置页面完成：

```text
导入几张 PNG / WebP
        ↓
分配给不同状态
        ↓
选择过渡动画
        ↓
选择循环动态
        ↓
实时 Preview
        ↓
保存
        ↓
DSH 中的 Pet 立即按 Agent 状态自动变化
```

第一版不要求用户制作 spritesheet。

---

# 2. V1 产品范围

## 2.1 必须实现

### Pet 状态

V1 固定支持：

```ts
type VisualState =
  | 'idle'
  | 'active'
  | 'waiting'
  | 'success'
  | 'error'
```

编辑器面向用户显示以下 Pose 槽：

```text
Idle
Thinking
Working
Waiting
Success
Error
```

其中 `Thinking` 和 `Working` 是素材/表现层概念。

Agent Runtime 内部允许进一步区分：

```ts
type ActivityMode =
  | 'thinking'
  | 'working'
  | 'coding'
  | 'command'
```

但这些 ActivityMode 默认都属于：

```text
VisualState = active
```

避免 reasoning → tool → reasoning 时频繁换图。

---

### 图片导入

支持：

- PNG
- WebP
- JPEG（允许，但提示无透明背景）
- 明确拒绝 SVG
- V1 不依赖 GIF 动画

至少导入一张图片后 Pet 即可运行。

推荐格式：

- 透明 PNG / WebP
- 正方形或近似正方形画布
- 角色完整身体
- 尽量保持不同 Pose 的角色视觉尺寸一致

---

### 状态图片 fallback

不能要求六个状态都有图片。

Resolver 默认：

```text
idle:
  idle → first available

thinking:
  thinking → working → idle → first available

working:
  working → thinking → idle → first available

waiting:
  waiting → idle → thinking → first available

success:
  success → idle → thinking → first available

error:
  error → idle → thinking → first available
```

如果没有任何图片：

```text
Pet overlay = 不渲染
Settings = 显示“请先导入至少一张图片”
```

---

### 进入过渡动画

V1 必须包含：

```text
None
Soft
Comic Pop
Jelly
Jump
Snap
```

推荐额外实现：

```text
Celebrate
Deflate
```

其中 **Comic Pop 是产品默认和标志性效果。**

---

### Ambient / Loop 动态

V1 必须支持可叠加的三个 channel：

```text
Bounce
Sway
Breathing
```

它们不是一段写死动画，而是独立 channel。

V1 可选增加：

```text
Micro Shake
Tilt
Float
```

但不要因为这些附加效果延迟 MVP。

---

### Live Preview

设置页必须能：

- 当前状态预览；
- 点击状态按钮立即模拟状态变化；
- 实时调整动画参数；
- 不需要触发真实 LLM 请求；
- 能重复播放当前 Enter Transition；
- 能开关 Anchor 标记。

---

### DSH 状态联动

至少支持：

```text
Idle
Active
Waiting For User
Success
Error
```

Agent 在一个视觉状态内部发生 reasoning/tool/coding/command 变化时：

- 不换 Pose；
- 不播放完整 Comic Pop；
- 只更新 Ambient Profile。

---

### 拖动与尺寸

Overlay Pet：

- 可拖动；
- 位置持久化；
- 默认靠右下角，避免耦合 DSH Sidebar DOM；
- 用户可设置整体 Scale；
- Scale 推荐范围 `0.5 ~ 2.0`；
- Overlay 外层 `pointer-events: none`；
- Pet 实体交互层 `pointer-events: auto`。

---

### 配置持久化

刷新和重启 DSH 后保留：

- 图片
- Pose Anchor
- 状态配置
- Transition 配置
- Ambient 配置
- Pet Scale
- Pet 位置
- Enabled 状态

---

## 2.2 V1 明确不做

以下功能不得阻塞 V1：

- Native Win32/X11 桌面窗口；
- Live2D；
- 骨骼动画；
- 自动 AI 生图；
- Pet Creation Skill；
- Codex spritesheet 完整兼容；
- Pet 社区/商城；
- 云同步；
- 多 Pet 同屏；
- 物理碰撞；
- 屏幕自动漫游；
- 视频 Pet；
- 音效；
- 对话气泡；
- LLM 驱动状态分类。

这些进入后续版本。

此外，即使 V1.1 开放关键帧编辑器，也明确不做：

```text
通用视频编辑
无限 CSS property
任意 JavaScript expression
脚本轨
骨骼动画编辑
曲线图编辑器全集
AE/Blender 级动画工具
```

目标始终是 **Pet-specific Animation Editor**。

---

# 3. 设计原则

## 3.0 Animation Runtime 也必须与 Preset 分离

v0.2 增加第三个核心解耦：

```text
Pose
≠
Motion Preset
≠
Timeline Runtime
```

Preset 只是动画数据模板，不是执行逻辑。

正确架构：

```text
Built-in Preset
      │
      ▼
AnimationDefinition
      ▲
      │
Custom Animation
      │
      ▼
Timeline Engine
      │
      ▼
Timeline Compiler / Scheduler
      │
      ▼
WAAPI
      │
      ▼
PetRenderer
```

这意味着：

- 新增动画风格优先增加数据定义；
- Runtime 不应该知道 `"comic-pop"` 的特殊业务语义；
- Preview 与真实 Overlay 使用同一个 Timeline Runtime；
- 用户未来创建的关键帧动画与内置 Preset 走同一执行路径。

## 3.1 Pose 与 Motion 必须分离

错误设计：

```text
thinking.webp = thinking 的完整动画
```

正确设计：

```text
Pose:
  thinking.webp

Motion:
  enter = comic-pop
  ambient = bounce + sway
```

因此同一张 Pose 可以：

```text
Thinking → 慢 Bounce + Sway
Working  → 快速微 Bounce + Breathing
```

---

## 3.2 DSH Adapter 与 Motion Runtime 必须分离

整个核心层不允许知道：

```text
session/event
agent/status
shell.overlay
Cordis
DSH runtime object
```

这些必须仅存在：

```text
integration/dsh/
```

目标：

```text
DSH
 │
 ▼
DshStateAdapter
 │
 ▼
NormalizedAgentEvent
 │
 ▼
PetStateResolver
 │
 ▼
MotionDirector
 │
 ▼
DOM Renderer
```

未来才能复用到其他 Agent UI。

---

## 3.3 不以“收到事件”为动画触发条件

严禁：

```ts
onAssistantChunk(() => playComicPop())
```

因为流式输出可能产生大量事件。

只能：

```text
Raw Event
   ↓
Normalized Event
   ↓
Semantic / Visual State
   ↓
if visual state changed
   → transition
else
   → update ambient only
```

---

## 3.4 Transform ownership 必须分层

禁止多个逻辑同时写一个元素的 `transform`。

推荐 DOM：

```html
<div class="motion-pet-position">
  <div class="motion-pet-user-scale">
    <div class="motion-pet-sway">
      <div class="motion-pet-bounce">
        <div class="motion-pet-breathe">
          <div class="motion-pet-transition">
            <div class="motion-pet-stage">
              <img class="motion-pet-pose" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

职责：

```text
position      → 拖动位置
user-scale    → 用户整体大小
sway          → rotation
bounce        → 周期性 translateY + 小 squash
breathe       → 极小 scale
transition    → Comic Pop / Jelly / Jump
stage         → Pose Anchor 对齐
pose          → 纯图片
```

---

# 4. 技术栈

推荐：

```text
Language        TypeScript
UI              React
Animation model AnimationDefinition + Keyframe Timeline Engine
Animation runtime Web Animations API
Styling         CSS
Persistence     Host-side JSON + local asset files
Plugin model    DSH Host + Client dual-half plugin
Tests           Vitest
Build           跟随当前 DSH 外部插件标准 / tsdown
```

不要引入：

- Electron
- Tauri
- Canvas renderer
- PixiJS
- Three.js
- GSAP
- Framer Motion
- 游戏引擎

V1 使用浏览器原生 WAAPI 足够。

---

# 5. DSH 接入策略

## 5.1 当前实现基线

截至本文档编写时，现有 DSH 社区 Web Pet 已验证以下模式可行：

```text
一个 npm plugin package
    ├── Host half
    └── Client half
```

包声明通常包含：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web"
    }
  }
}
```

社区 `dsh-codex-pet` 目前即采用：

```text
main: lib/index.js
./client: lib/client.js
dsh.bundle.patch
dsh.client.platform = web
```

但具体 manifest 字段、inject 和构建方式必须在编码时重新对照当前 DSH 官方源码。

---

## 5.2 Slot

目标 UI Surface：

```text
shell.overlay
settings.section
```

用途：

```text
shell.overlay
→ Pet overlay

settings.section
→ Motion Pet Editor / Settings
```

**编码时先检查当前 DSH Slot Registry。**

不要把旧版本示例：

```ts
ctx.slots.inject(... ctx.slots.register(...))
```

当成硬编码规范。

当前官方客户端架构应优先使用：

```ts
ctx.slots.register(options, Component)
```

以实际版本类型签名为准。

---

## 5.3 Client Plugin 纪律

遵循当前 DSH 官方客户端规范：

- Client plugin 通过 Cordis DI 协作；
- 不要随意 value-import 其他 plugin package；
- 跨 plugin 共享优先 Slot / Service / Inject；
- React Component 不直接拿整个 `ctx`；
- 组件输入尽量保持 serializable data + callbacks；
- DSH 依赖差异封装在 adapter / apply 层。

---

## 5.4 Host 与 Client 通讯

V1 推荐使用：

```text
same-origin HTTP
```

Host 注册：

```text
/api/motion-pet/*
/motion-pet-assets/*
```

理由：

- 图片是二进制；
- 配置是 JSON；
- 不需要把 Blob 穿过 RPC；
- 调试简单；
- 社区 Web Pet 已验证 Host WebServer route 模式。

---

# 6. 推荐仓库结构

优先单包仓库：

```text
dsh-motion-pet/
├── package.json
├── cordis.patch.yml
├── tsconfig.json
├── tsconfig.client.json
├── tsdown.config.ts
├── README.md
├── AGENTS.md
├── docs/
│   ├── development-spec.md
│   ├── implementation-notes.md
│   └── motion-format.md
├── src/
│   ├── host/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── storage.ts
│   │   ├── assets.ts
│   │   ├── validation.ts
│   │   └── routes.ts
│   │
│   ├── core/
│   │   ├── types.ts
│   │   ├── defaults.ts
│   │   ├── pose-resolver.ts
│   │   ├── pet-state-resolver.ts
│   │   ├── state-machine.ts
│   │   ├── transition-presets.ts
│   │   └── ambient-presets.ts
│   │
│   ├── motion/
│   │   ├── motion-director.ts
│   │   ├── timeline-engine.ts
│   │   ├── timeline-compiler.ts
│   │   ├── timeline-scheduler.ts
│   │   ├── animation-definition.ts
│   │   ├── animation-registry.ts
│   │   ├── motion-properties.ts
│   │   ├── transition-engine.ts
│   │   ├── ambient-engine.ts
│   │   ├── animation-handle.ts
│   │   └── math.ts
│   │
│   ├── integration/
│   │   └── dsh/
│   │       ├── state-adapter.ts
│   │       ├── event-normalizer.ts
│   │       └── capability-detection.ts
│   │
│   └── client/
│       ├── index.ts
│       ├── api.ts
│       ├── stores/
│       │   └── editor-store.ts
│       ├── overlay/
│       │   ├── PetOverlay.tsx
│       │   ├── PetRenderer.tsx
│       │   └── useDrag.ts
│       ├── settings/
│       │   ├── MotionPetSettings.tsx
│       │   ├── StateList.tsx
│       │   ├── PoseEditor.tsx
│       │   ├── TransitionEditor.tsx
│       │   ├── AmbientEditor.tsx
│       │   └── LivePreview.tsx
│       └── styles.css
│
├── tests/
│   ├── core/
│   ├── motion/
│   ├── host/
│   └── integration/
└── scripts/
    └── smoke-test.mjs
```

如果当前 DSH build tooling 对目录有明确要求，可以调整目录，但模块边界不要破坏。

---

# 7. 核心数据模型

## 7.1 PoseKey

```ts
export type PoseKey =
  | 'idle'
  | 'thinking'
  | 'working'
  | 'waiting'
  | 'success'
  | 'error'
```

---

## 7.2 AssetMeta

```ts
export interface AssetMeta {
  id: string
  fileName: string
  mimeType: 'image/png' | 'image/webp' | 'image/jpeg'
  width: number
  height: number
  sizeBytes: number
  sha256: string
  url: string
}
```

Host 生成 `id`。

不要用用户原始 filename 作为磁盘路径。

---

## 7.3 PoseConfig

```ts
export interface PoseConfig {
  assetId?: string

  anchor: {
    x: number // 0..1
    y: number // 0..1
  }

  zoom: number // default 1
}
```

默认：

```ts
anchor = { x: 0.5, y: 0.96 }
zoom = 1
```

---

## 7.4 TransitionConfig

```ts
export type TransitionPreset =
  | 'global'
  | 'none'
  | 'soft'
  | 'comic-pop'
  | 'jelly'
  | 'jump'
  | 'snap'
  | 'celebrate'
  | 'deflate'

export interface TransitionConfig {
  preset: TransitionPreset
  strength: number
  durationMs: number
}
```

限制：

```text
strength    0 .. 1.8
durationMs  80 .. 650
```

---

## 7.5 Ambient Config

```ts
export interface BounceConfig {
  enabled: boolean
  strength: number
  intervalMinMs: number
  intervalMaxMs: number
  durationMs: number
}

export interface SwayConfig {
  enabled: boolean
  angleDeg: number
  periodMs: number
}

export interface BreatheConfig {
  enabled: boolean
  strength: number
  periodMs: number
}

export interface AmbientConfig {
  bounce: BounceConfig
  sway: SwayConfig
  breathe: BreatheConfig
}
```

---

## 7.6 StateAppearance

```ts
export interface StateAppearance {
  pose: PoseKey
  enter: TransitionConfig
  ambient: AmbientConfig
}
```

---

## 7.7 完整持久化配置

```ts
export interface MotionPetConfig {
  version: 1

  enabled: boolean

  global: {
    scale: number
    transition: {
      preset: Exclude<TransitionPreset, 'global'>
      strength: number
      durationMs: number
    }
    reducedMotion: 'system' | 'always' | 'never'
    successHoldMs: number
    errorHoldMs: number
  }

  poses: Record<PoseKey, PoseConfig>

  states: {
    idle: StateAppearance
    thinking: StateAppearance
    working: StateAppearance
    waiting: StateAppearance
    success: StateAppearance
    error: StateAppearance
  }

  overlay: {
    x: number | null
    y: number | null
  }
}
```

默认 `scale = 1`。

---

# 8. Timeline Engine 数据模型

Timeline Engine 是 v0.2 的核心新增能力。

## 8.1 设计目标

必须同时支持：

```text
Built-in Presets
Custom User Animations
Transition
Ambient Loop
Interaction Motion
```

这些都使用同一底层模型。

V1 UI 不需要暴露全部能力，但 Runtime 必须能够加载和执行合法的 `AnimationDefinition`。

---

## 8.2 Motion Property 白名单

用户动画不得直接写：

```text
transform
filter
任意 CSS property
任意 JavaScript expression
```

Timeline 只能写入受控属性。

V1 白名单建议：

```ts
export type MotionProperty =
  | 'transition.scaleX'
  | 'transition.scaleY'
  | 'transition.x'
  | 'transition.y'
  | 'transition.rotation'
  | 'transition.opacity'
  | 'sway.rotation'
  | 'bounce.x'
  | 'bounce.y'
  | 'bounce.scaleX'
  | 'bounce.scaleY'
  | 'breathe.scaleX'
  | 'breathe.scaleY'
```

属性映射必须集中维护在：

```text
src/motion/motion-properties.ts
```

每个 property 声明：

```ts
interface MotionPropertyDescriptor {
  kind: 'scale' | 'px' | 'deg' | 'ratio'
  min?: number
  max?: number
  defaultValue: number
  targetLayer:
    | 'transition'
    | 'sway'
    | 'bounce'
    | 'breathe'
}
```

这样 Timeline Engine 不会破坏 Transform Ownership。

---

## 8.3 Keyframe

关键帧时间统一使用：

```text
0..1 normalized time
```

不要把关键帧位置持久化成绝对毫秒。

```ts
export interface MotionKeyframe {
  at: number // 0..1
  value: number | ParameterizedValue
  easing?: MotionEasing
}
```

原因：

```text
同一关键帧结构
duration 260ms
→ duration 500ms
```

动画比例保持不变。

---

## 8.4 Track

```ts
export interface MotionTrack {
  property: MotionProperty
  keyframes: MotionKeyframe[]
}
```

要求：

- keyframe 按 `at` 排序；
- 至少 1 个 keyframe；
- `at` 必须在 `0..1`；
- 同一个 Track 不允许出现非法 property；
- Compiler 对缺失起点/终点做明确策略，不允许隐式随机行为。

推荐：

```text
若首帧 at > 0
→ 使用 property default / current value 补 0

若尾帧 at < 1
→ 使用最后值保持到 1
```

具体策略必须写单测。

---

## 8.5 Timeline Event

```ts
export type TimelineEvent =
  | {
      at: number
      type: 'pose-swap'
    }
```

V1 只允许：

```text
pose-swap
```

未来可扩展：

```text
sound
particle
screen-shake
callback
```

但 V1 不实现。

`pose-swap` 必须成为正式数据，而不是 TransitionEngine 中的 magic timeout。

---

## 8.6 Repeat Policy

```ts
export type RepeatPolicy =
  | { mode: 'once' }
  | { mode: 'loop' }
  | { mode: 'alternate' }
  | {
      mode: 'random-interval'
      minDelayMs: number
      maxDelayMs: number
    }
```

用途：

```text
Transition
→ once

Breathing
→ loop

Sway
→ alternate 或 loop

Thinking Bounce
→ random-interval
```

---

## 8.7 Easing

V1 必须支持：

```ts
export type MotionEasing =
  | 'linear'
  | 'ease'
  | 'ease-in'
  | 'ease-out'
  | 'ease-in-out'
  | `cubic-bezier(${number},${number},${number},${number})`
```

推荐再提供语义 alias：

```text
spring-soft
spring-snappy
overshoot
anticipate
```

若实现 alias：

```text
alias
→ compiler
→ cubic-bezier
```

V1 不要求物理 Spring Solver。

---

## 8.8 Parameterized Value

Preset 仍然需要：

```text
Strength
```

但不得把 strength 逻辑散落到每个动画函数。

建议：

```ts
export interface ParameterizedValue {
  base: number
  parameter: 'strength'
  amount: number
}
```

计算：

```ts
value = base + params[parameter] * amount
```

例如 Comic Pop：

```json
{
  "base": 1,
  "parameter": "strength",
  "amount": 0.16
}
```

当 `strength = 0.5`：

```text
1 + 0.5 × 0.16 = 1.08
```

禁止在 JSON 中支持：

```text
eval
Function
任意 JS expression
```

---

## 8.9 AnimationDefinition

```ts
export interface AnimationDefinition {
  version: 1

  id: string
  name: string

  kind:
    | 'transition'
    | 'ambient'
    | 'interaction'

  durationMs: number

  repeat: RepeatPolicy

  tracks: MotionTrack[]

  events?: TimelineEvent[]

  parameters?: {
    strength?: {
      default: number
      min: number
      max: number
    }
  }
}
```

---

## 8.10 示例：Comic Pop

```json
{
  "version": 1,
  "id": "builtin:comic-pop",
  "name": "Comic Pop",
  "kind": "transition",
  "durationMs": 260,
  "repeat": {
    "mode": "once"
  },
  "tracks": [
    {
      "property": "transition.scaleX",
      "keyframes": [
        { "at": 0, "value": 1 },
        {
          "at": 0.18,
          "value": {
            "base": 1,
            "parameter": "strength",
            "amount": 0.05
          }
        },
        {
          "at": 0.38,
          "value": {
            "base": 1,
            "parameter": "strength",
            "amount": 0.16
          }
        },
        {
          "at": 0.57,
          "value": {
            "base": 1,
            "parameter": "strength",
            "amount": -0.10
          }
        },
        { "at": 1, "value": 1 }
      ]
    }
  ],
  "events": [
    {
      "at": 0.40,
      "type": "pose-swap"
    }
  ]
}
```

完整内置定义应补齐 ScaleY 和 Y Track。

---

## 8.11 Timeline Compiler

职责：

```text
AnimationDefinition
        +
Runtime Parameters
        +
Motion Property Registry
        ↓
Compiled Timeline
```

Compiler 必须负责：

- Schema validation；
- keyframe normalization；
- ParameterizedValue 求值；
- easing 校验；
- repeat policy 校验；
- MotionProperty → DOM Layer / WAAPI property 映射；
- Event 时间排序；
- duration clamp；
- Reduced Motion adaptation；
- 输出可执行 timeline。

Runtime 不得重复做 Schema 解释。

---

## 8.12 Timeline Scheduler

Scheduler 负责：

```text
WAAPI Animation
+
Timeline Events
+
Cancellation
+
Repeat Policy
```

特别是：

```text
pose-swap
```

不能依赖容易漂移的普通 `setTimeout`。

推荐策略：

```text
把 Timeline 按 event point 切成 segment
```

例如：

```text
0 → 0.4
await animation.finished

pose-swap

0.4 → 1
await animation.finished
```

这样：

- Event 与视觉时间一致；
- cancellation 更简单；
- 浏览器 background throttling 时更稳定。

对于未来多个 Event：

```text
0 → event A
A → event B
B → end
```

Scheduler 分段执行。

---

## 8.13 Animation Registry

所有内置与用户动画统一注册：

```ts
interface AnimationRegistry {
  get(id: string): AnimationDefinition | undefined
  list(kind?: AnimationDefinition['kind']): AnimationDefinition[]
  register(definition: AnimationDefinition): void
  unregister(id: string): void
}
```

ID 规范：

```text
builtin:comic-pop
builtin:thinking-bounce
builtin:soft-breathe

user:<uuid>
```

不得让用户覆盖 `builtin:*`。

---

## 8.14 Preset 是 AnimationDefinition 的引用

TransitionConfig 从 v0.1 的：

```ts
preset: 'comic-pop'
```

逐步演化为：

```ts
animationId: string
```

为了保持 V1 UI 简单，可以在 UI 层仍显示：

```text
Comic Pop
Soft
Jelly
Jump
Snap
```

内部实际保存：

```text
builtin:comic-pop
builtin:soft
builtin:jelly
builtin:jump
builtin:snap
```

---

## 8.15 Preset → Customize

V1 不要求 Timeline Editor，但数据结构必须支持未来操作：

```text
Comic Pop
   ↓
Customize
   ↓
clone AnimationDefinition
   ↓
user:<uuid>
```

克隆后用户修改的是独立 Timeline，不影响内置 preset。

---

## 8.16 Ambient 也必须使用 Timeline

以下内置 Ambient：

```text
Bounce
Sway
Breathing
```

必须表示为 AnimationDefinition。

例如：

```text
builtin:thinking-bounce
builtin:idle-sway
builtin:soft-breathe
```

`AmbientEngine` 的职责变为：

```text
根据当前 AmbientConfig
→ 为对应 channel 创建/停止 Timeline instance
```

而不是自己硬编码 keyframe。

---

## 8.17 Timeline Instance

同一个 Definition 可以多次实例化。

```ts
interface TimelineInstance {
  id: string
  definitionId: string
  status: 'idle' | 'running' | 'paused' | 'cancelled' | 'finished'
  play(): Promise<void>
  pause(): void
  resume(): void
  cancel(): void
  dispose(): void
}
```

每个 Motion Channel 最多只能有预期数量的 active instance。

---

## 8.18 Motion Pack 前置兼容

V1 不需要导入导出 Motion Pack，但 AnimationDefinition 应从一开始就可序列化。

未来：

```text
motion-pack.zip
├── motion-pack.json
└── animations/
    ├── manga-pop.json
    ├── slime-bounce.json
    └── sleepy-sway.json
```

Pet 图片资产与 Motion Pack 独立。

因此：

```text
Pet Pack
=
角色资产

Motion Pack
=
动画资产

Pet Config
=
二者组合
```

---

# 9. 默认 Motion Preset

## 9.1 Comic Pop

核心流程：

```text
normal
  ↓
anticipation
  ↓
strong squash
  ↓
SWAP POSE
  ↓
stretch
  ↓
overshoot
  ↓
settle
```

默认：

```text
duration = 260ms
strength = 1.0
swap point ≈ 38~42%
```

基准 keyframe：

```text
0%
scaleX 1.00
scaleY 1.00
translateY 0

18%
scaleX 1.05
scaleY 0.95
translateY +2

38%
scaleX 1.16
scaleY 0.82
translateY +4

--- SWAP ---

57%
scaleX 0.90
scaleY 1.13
translateY -6

76%
scaleX 1.04
scaleY 0.96
translateY +1

90%
scaleX 0.985
scaleY 1.02
translateY -1

100%
1 / 1 / 0
```

---

## 9.2 Strength 算法

Scale 不直接乘 strength。

使用：

```ts
scaled = 1 + (base - 1) * strength
```

Translate：

```ts
translated = basePx * strength
```

例如：

```text
base scaleX = 1.16
strength = 0.5

实际 =
1 + (1.16 - 1) * 0.5
= 1.08
```

---

## 9.3 Soft

目标：非常轻的状态切换。

```text
1
→ 1.04 / .96
→ .98 / 1.03
→ 1
```

默认 220ms。

---

## 9.4 Jelly

目标：明显果冻感。

```text
1
→ 1.16 / .84
→ .90 / 1.13
→ 1.07 / .94
→ .98 / 1.03
→ 1
```

默认 380ms。

---

## 9.5 Jump

```text
squash
→ upward stretch
→ pose swap
→ land
→ landing squash
→ settle
```

默认最高 `translateY ≈ -16px * strength`。

---

## 9.6 Snap

快速动漫式 Cut。

```text
normal
→ squash
→ swap
→ strong overshoot
→ settle
```

默认 `140~180ms`。

---

# 10. Transition Engine 实现要求

## 10.1 Timeline Event 必须由 Scheduler 驱动

更稳定的实现：

```text
pre-swap animation
    ↓ await finished
swap pose
    ↓
post-swap animation
    ↓ await finished
```

Preset 必须首先表示为 `AnimationDefinition`，再由 Timeline Compiler / Scheduler 执行。TransitionEngine 不得持有专用 preset keyframe 逻辑。

例如：

```ts
await animatePre()
assertCurrentGeneration()

swapPose()

await animatePost()
assertCurrentGeneration()
```

---

## 10.2 Transition generation

所有 transition 必须支持中断。

```ts
let generation = 0

async function transitionTo(next) {
  const gen = ++generation

  stopAmbient()

  await pre()

  if (gen !== generation) return

  swap()

  await post()

  if (gen !== generation) return

  startAmbient(next)
}
```

新状态到达：

```text
旧 transition 立即失效
```

不要等待旧动画自然结束。

---

## 10.3 同状态不转场

```ts
if (next.visualState === current.visualState &&
    next.poseKey === current.poseKey) {
  updateAmbient(next.activityMode)
  return
}
```

这是防止流式事件导致连续弹跳的关键。

---

# 11. Ambient Engine

## 11.1 Thinking 默认

```text
Bounce:
  enabled = true
  strength = 0.35
  interval = random 800~1300ms
  duration = 360ms

Sway:
  enabled = true
  angle = 1.3deg
  period = 2700ms

Breathing:
  false
```

视觉：

```text
慢慢左右摇
   +
偶尔“啵”一下
```

Bounce 间隔必须有随机性。

不要固定每秒一次。

---

## 11.2 Working 默认

```text
Bounce:
  enabled = true
  strength = 0.22
  interval = 550~850ms

Sway:
  false

Breathing:
  true
  strength = 0.18
```

看起来更紧凑、忙碌。

---

## 11.3 Idle 默认

```text
Bounce:
  false

Sway:
  true
  angle = 0.7deg
  period = 3600ms

Breathing:
  true
  strength = 0.25
  period = 2800ms
```

---

## 11.4 Waiting 默认

```text
Bounce:
  false

Sway:
  true
  angle = 0.9deg
  period = 4200ms

Breathing:
  true
  strength = 0.16
```

---

## 11.5 Success / Error

Success 主要依赖 Enter Transition。

Ambient 保持轻微，不应持续疯狂庆祝。

Error 可以：

```text
slow sway + weak breathing
```

---

# 12. Anchor 系统

Anchor 是 V1 必须真正实现的功能，不能只画一个十字。

## 12.1 原因

两张 AI 图片的角色位置可能不同：

```text
idle:     脚底 y=91%
thinking: 脚底 y=96%
```

如果直接换图：

```text
角色会“瞬移”
```

Comic Pop 只能部分遮盖，不能解决本质问题。

---

## 12.2 Anchor 定义

每张 Pose：

```ts
anchor.x: 0..1
anchor.y: 0..1
```

默认：

```text
x = 0.50
y = 0.96
```

代表：

```text
脚底中心附近
```

---

## 12.3 Renderer 处理

Pet Stage 有一个固定 World Anchor。

例如：

```text
stage anchor = 50% / 90%
```

每张图片根据：

```text
naturalWidth
naturalHeight
object fit scale
pose anchor
```

计算图片偏移，使：

```text
Pose anchor
==
Stage world anchor
```

无论 Pose 自身画布如何变化，切换时脚底保持世界坐标不动。

---

## 12.4 Transform Origin

Transition 的 squash/stretch 应围绕 World Anchor。

不要使用浏览器默认中心：

```css
transform-origin: center;
```

应在 Stage 上采用：

```text
transform-origin = world anchor
```

视觉目标：

```text
squash:
  头部下压
  脚底不离地
```

---

# 13. DSH State Adapter

这是整个系统唯一允许依赖 DSH raw event 的模块。

---

## 13.1 NormalizedAgentEvent

```ts
export type NormalizedAgentEvent =
  | { type: 'idle'; sessionId?: string; ts: number }
  | { type: 'turn-start'; sessionId?: string; ts: number }
  | { type: 'thinking'; sessionId?: string; ts: number }
  | { type: 'tool-start'; toolKind: 'edit' | 'command' | 'other'; sessionId?: string; ts: number }
  | { type: 'tool-end'; sessionId?: string; ts: number }
  | { type: 'waiting'; sessionId?: string; ts: number }
  | { type: 'success'; sessionId?: string; ts: number }
  | { type: 'error'; sessionId?: string; ts: number }
```

---

## 13.2 当前 DSH 调研方向

已有 DSH Pet 实现使用过：

```text
session/event
agent/status
```

并观察：

```text
assistant/chunk
tool/call
approval/asked
turn/end
```

但编码智能体必须以当前版本 DSH 实际事件类型为准。

优先检查：

```text
packages/client/runtime
session projection
agent status
selected/current session snapshot
session/event
agent/status
```

优先用稳定的状态 snapshot。

只有必要时依赖细粒度 raw chunk event。

---

## 13.3 状态映射

建议：

```text
agent idle
→ IDLE

turn start / reasoning
→ ACTIVE + thinking

tool edit
→ ACTIVE + coding

shell / command
→ ACTIVE + command

other tool
→ ACTIVE + working

approval / ask user
→ WAITING

completed
→ SUCCESS

error / aborted
→ ERROR
```

---

# 14. Pet State Machine

## 14.1 VisualState

```ts
enum VisualState {
  IDLE,
  ACTIVE,
  WAITING,
  SUCCESS,
  ERROR
}
```

---

## 14.2 ActivityMode

```ts
enum ActivityMode {
  THINKING,
  WORKING,
  CODING,
  COMMAND
}
```

---

## 14.3 状态关系

```text
                 ┌──────┐
                 │ IDLE │
                 └──┬───┘
                    │
                turn start
                    ▼
              ┌──────────┐
        ┌────►│  ACTIVE  │◄────┐
        │     └────┬─────┘     │
        │          │           │
     user reply  waiting    new activity
        │          ▼           │
        │      ┌─────────┐     │
        └──────│ WAITING │─────┘
               └─────────┘

ACTIVE → SUCCESS → IDLE
ACTIVE → ERROR   → IDLE
```

---

## 14.4 Success / Error transient

默认：

```text
SUCCESS hold = 1600ms
ERROR hold   = 1800ms
```

之后：

```text
如果没有新 activity
→ IDLE
```

如果期间新 turn 开始：

```text
立即中断
→ ACTIVE
```

---

## 14.5 事件优先级

若存在多个并发 session/task：

优先使用 **当前 DSH 前台/选中 session**。

如果当前版本无法稳定获取：

使用聚合策略：

```text
WAITING
>
ERROR
>
ACTIVE
>
SUCCESS
>
IDLE
```

Success/Error 使用 TTL，不永久占用优先级。

---

# 15. 状态稳定器

必须实现。

## 15.1 identical state dedupe

```text
ACTIVE thinking
→ ACTIVE thinking
→ ACTIVE thinking
```

不做任何 transition。

---

## 15.2 ActivityMode change

```text
ACTIVE thinking
→ ACTIVE command
→ ACTIVE thinking
```

只更新 Ambient：

```text
不换图片
不 Comic Pop
```

除非用户明确把 Thinking 和 Working 配成不同 Pose，并开启：

```text
advanced.changePoseWithinActive = true
```

该开关不进入 V1 UI，默认 false。

---

## 15.3 Coalescing

建议对同一 tick / 极短时间内的事件做：

```text
50~100ms coalescing
```

避免：

```text
turn-start
assistant-start
tool-start
```

在同一瞬间产生三次视觉操作。

---

# 16. Renderer

## 16.1 不使用 Canvas

V1 Renderer：

```text
DOM + img + CSS transform + WAAPI
```

原因：

- 静态 Pose；
- 浏览器原生图片解码；
- transform 合成成本低；
- Settings Preview 与 Overlay 可共享。

---

## 16.2 统一 Renderer

Settings Preview 和真实 Overlay 必须复用：

```tsx
<PetRenderer />
```

不要分别实现两套动画逻辑。

区别只来自 Controller：

```text
Preview:
  ManualStateSource

Overlay:
  DshStateSource
```

---

## 16.3 图片 preload

状态切换前图片应已 preload。

配置加载时：

```text
所有当前 Pose asset URL
→ preload
```

用户刚导入新图：

```text
decode()
→ ready
→ 才允许 Preview transition
```

避免切换时闪空。

---

# 17. Settings / Editor UI

推荐三栏：

```text
┌──────────────┬────────────────────────┬──────────────────────────┐
│ STATES       │ STATE SETTINGS         │ LIVE PREVIEW             │
│              │                        │                          │
│ Idle         │ Pose Image             │                          │
│ Thinking     │ Anchor                 │          PET             │
│ Working      │                        │                          │
│ Waiting      │ Enter Transition       │                          │
│ Success      │                        │                          │
│ Error        │ Ambient                │                          │
│              │                        │                          │
│ Global       │ Advanced               │ Idle Thinking Working... │
└──────────────┴────────────────────────┴──────────────────────────┘
```

窄屏时改纵向。

---

## 17.1 State List

每个状态显示：

```text
● 已导入
○ 使用 fallback
```

点击选中。

---

## 17.2 Pose Editor

包含：

```text
[ 导入 / 更换图片 ]

Anchor X
Anchor Y

Zoom
```

Preview 中可显示 Anchor 十字。

P1 可加入拖动 Anchor。

V1 Slider 足够。

---

## 17.3 Transition Editor

```text
Preset
Strength
Duration

[▶ Preview Enter]
```

`global` 表示继承全局。

---

## 17.4 Ambient Editor

```text
☑ Bounce
   Strength
   Min interval
   Max interval

☑ Sway
   Angle
   Period

☑ Breathing
   Strength
   Period
```

---

## 17.5 Basic / Advanced

如果开发成本允许：

Basic：

```text
Style:
Calm
Lively
Bouncy
Chaotic

Amount
Speed
```

Advanced：

显示具体参数。

但 V1 可以先只做 Advanced 参数界面。

---

## 17.6 Manual Preview

必须有：

```text
[ Idle ]
[ Thinking ]
[ Working ]
[ Waiting ]
[ Success ]
[ Error ]
```

点击后必须走真正的：

```text
StateMachine
→ MotionDirector
```

不能写一套 Preview 专用 transition。

---

# 18. Host 持久化设计

## 18.1 磁盘

```text
$DSH_HOME/motion-pet/
├── config.json
└── assets/
    ├── <asset-id>.webp
    ├── <asset-id>.png
    └── ...
```

---

## 18.2 Config write

必须 atomic：

```text
config.json.tmp
→ fsync / close
→ rename config.json
```

至少做到 temp + rename。

---

## 18.3 配置 migration

入口：

```ts
loadConfig(raw): MotionPetConfig
```

未来：

```text
v1 → v2
```

必须集中在：

```text
src/host/config.ts
```

不要让版本判断散落 UI。

---

# 19. HTTP API

路径前缀：

```text
/api/motion-pet
```

---

## 19.1 GET config

```http
GET /api/motion-pet/config
```

返回：

```json
{
  "config": {},
  "assets": {}
}
```

---

## 19.2 PUT config

```http
PUT /api/motion-pet/config
Content-Type: application/json
```

只接受 schema 中存在的字段。

服务端重新 validation。

---

## 19.3 POST asset

推荐：

```http
POST /api/motion-pet/assets
multipart/form-data
```

字段：

```text
file
```

返回：

```json
{
  "asset": {
    "id": "...",
    "url": "/motion-pet-assets/...",
    "width": 1024,
    "height": 1024
  }
}
```

Client 收到后再把 `assetId` 写入对应 Pose。

---

## 19.4 DELETE asset

```http
DELETE /api/motion-pet/assets/:id
```

若仍被 Pose 引用：

推荐返回：

```text
409 ASSET_IN_USE
```

Client 更换图片时：

1. upload new；
2. update config；
3. 再删除旧 asset。

---

## 19.5 Static asset

```text
GET /motion-pet-assets/:id
```

只允许已登记 asset。

不要把 path 参数直接拼 filesystem path。

---

# 20. 图片安全

必须：

- 单文件大小默认上限 10MB；
- 总资产建议上限 60MB；
- MIME 与 magic bytes 做基础一致性校验；
- 拒绝 SVG；
- 拒绝路径输入；
- 只由 Host 生成文件名；
- 不执行用户资产；
- 静态 route 不允许 `..`；
- 设置合理 Content-Type；
- URL Import 不属于 V1，因此没有 SSRF 问题。

推荐限制：

```text
max dimension: 4096 × 4096
```

---

# 21. 配置保存 UX

Slider 拖动过程中：

```text
只更新本地 Preview
```

在：

```text
pointerup / change
```

后：

```text
debounce 250~400ms
→ PUT config
```

页面显示：

```text
Saving…
Saved
Error
```

不要每个 `input` event 写磁盘。

---

# 22. Reduced Motion

必须尊重：

```css
prefers-reduced-motion
```

配置：

```text
System
Always reduce
Never reduce
```

Reduce 模式：

```text
Ambient:
  off

Transition:
  None 或极轻 Soft
  <= 120ms
```

---

# 23. 性能约束

本项目的 Motion Engine 不允许：

- 永久 JavaScript 60fps loop；
- 每帧 getBoundingClientRect；
- 每帧改 width/height/top/left；
- 每帧重新设置 image src；
- 大量 box-shadow/filter 动画；
- 页面 hidden 时继续 Bounce timer。

必须：

- 动画主要使用 `transform`；
- WAAPI；
- Pet 不可见时停止 Ambient；
- `document.visibilityState === hidden` 时暂停/取消；
- 状态变化时才执行 JS；
- Bounce 使用低频 timer + 一次性 WAAPI；
- Sway/Breathe 使用浏览器 compositor animation；
- 组件卸载时 cancel 所有 Animation 与 timer。

---

# 24. MotionDirector API

建议：

```ts
export interface MotionTarget {
  visualState: VisualState
  activityMode?: ActivityMode
  poseKey: PoseKey
  reason:
    | 'agent-state'
    | 'terminal-success'
    | 'terminal-error'
    | 'manual-preview'
    | 'session-switch'
    | 'config-change'
}

export interface MotionDirector {
  setTarget(target: MotionTarget): Promise<void>
  replayEnter(): Promise<void>
  refreshAmbient(): void
  stop(): void
  dispose(): void
}
```

---

## 24.1 transition context

不要只设计：

```ts
transitionTo('thinking')
```

保留：

```ts
{
  from,
  to,
  reason
}
```

未来允许：

```text
success → idle
```

和：

```text
error → idle
```

使用不同退出感。

V1 可以暂时只根据目标状态选择 preset。

---

# 25. AmbientEngine API

```ts
interface AmbientEngine {
  apply(config: AmbientConfig): void
  stop(): void
  pause(): void
  resume(): void
  dispose(): void
}
```

所有 channel 独立管理 Timeline Instance / Animation handle。AmbientEngine 只负责选择和编排 Timeline，不负责硬编码关键帧。

---

# 26. 配置默认值

建议初始 config：

```json
{
  "version": 1,
  "enabled": true,
  "global": {
    "scale": 1,
    "transition": {
      "preset": "comic-pop",
      "strength": 1,
      "durationMs": 260
    },
    "reducedMotion": "system",
    "successHoldMs": 1600,
    "errorHoldMs": 1800
  }
}
```

State defaults：

```text
Idle:
  enter = soft
  sway + breathing

Thinking:
  enter = global
  bounce + sway

Working:
  enter = global
  bounce + breathing

Waiting:
  enter = soft
  sway + breathing

Success:
  enter = celebrate (若没实现则 jump)
  very weak ambient

Error:
  enter = deflate (若没实现则 soft)
  weak sway
```

---

# 27. Overlay 行为

默认位置：

```text
right: 24px
bottom: 24px
```

不要为了贴 Sidebar 而读取 DSH 内部 DOM 尺寸。

用户拖动后改为绝对 viewport position。

Resize：

```text
clamp into viewport
```

Pet 不能完全拖出屏幕。

推荐至少保留：

```text
32px clickable area
```

---

# 28. 拖拽

Pointer API：

```text
pointerdown
setPointerCapture
pointermove
pointerup
```

区分 click 和 drag：

```text
移动距离 < 4px
→ click

>= 4px
→ drag
```

V1 click 可以：

```text
播放一次轻微 pop
```

但不切状态。

---

# 29. 测试策略

## 29.0 Timeline Engine Unit Tests

v0.2 新增必须覆盖：

```text
AnimationDefinition schema validation
normalized keyframe ordering
invalid property rejection
invalid at rejection
parameterized value resolution
strength = 0 / 1 / 1.8
easing validation
pose-swap event ordering
multiple segment scheduling
generation cancellation before event
generation cancellation after event
repeat once
repeat loop
repeat alternate
repeat random-interval
reduced-motion compilation
builtin registry protection
custom animation registration
```

必须特别验证：

```text
Timeline A 在 pose-swap 前被 B 中断
→ A 不得换 Pose

Timeline A 在 pose-swap 后被 B 中断
→ A 不得继续 post segment
→ B 接管最终状态
```

## 29.1 Core Unit Tests

必须覆盖：

### PoseResolver

```text
exact pose
fallback
only one image
no image
```

### StateResolver

```text
idle → active
active thinking → active command 不产生 visual transition
waiting priority
success transient
error transient
new activity interrupts terminal state
```

### Transition math

```text
strength 0
strength 1
strength 1.8
duration clamp
```

### generation cancellation

```text
transition A 未完成
transition B 到达
A 不得 swap / restart ambient
```

---

## 29.2 Host Tests

必须覆盖：

```text
config load
default config
invalid config
atomic save
upload valid PNG/WebP
reject SVG
reject oversized
static asset access
unknown asset 404
delete referenced asset 409
path traversal
```

---

## 29.3 Client / Motion Tests

至少使用 mocked element.animate 验证：

```text
pre transition
swap
post transition
ambient start
interrupt
dispose
```

---

## 29.4 Integration Test

Fake DSH adapter：

```text
idle
→ thinking
→ command
→ waiting
→ thinking
→ success
→ idle
```

断言：

```text
Idle→Active transition once

Thinking→Command:
  zero pose transition

Active→Waiting:
  one transition

Waiting→Active:
  one transition

Active→Success:
  celebrate once

Success→Idle:
  return
```

---

# 30. Manual DSH E2E Checklist

每次 release 必须手测：

```text
[ ] dsh plugin add 成功
[ ] DSH 启动无 plugin error
[ ] Settings 中出现 Motion Pet
[ ] 未导入图片时 Overlay 不占位
[ ] 导入 Idle 图片后 Overlay 出现
[ ] 导入 Thinking 图片
[ ] 手动 Idle→Thinking Comic Pop 正常
[ ] 图片切换时脚底 Anchor 不跳
[ ] Thinking Bounce + Sway 正常
[ ] Working 不会因为 chunk/tool 高频反复 Comic Pop
[ ] Waiting 正确
[ ] Success 正确
[ ] Error 正确
[ ] 快速连续状态不会卡在 squash
[ ] 拖动正常
[ ] Resize 后位置仍在视口
[ ] Scale 正常
[ ] 刷新后配置保留
[ ] 重启 DSH 后配置保留
[ ] prefers-reduced-motion 正常
[ ] 深色/浅色主题 Editor 可读
[ ] 卸载插件后 DSH 正常
```

---

# 31. 里程碑

## M0 — DSH API Spike

目标：

只验证插件接入。

任务：

```text
1. 读取当前 DSH 官方 client plugin 文档与源码。
2. 创建最小 external plugin package。
3. Host apply 能加载。
4. Client bundle 能加载。
5. shell.overlay 出现一个简单 div。
6. settings.section 出现测试页面。
7. 确认 Host webServer route 注册方式。
8. 确认当前可用 Agent/Session 状态源。
```

产出：

```text
docs/implementation-notes.md
```

记录：

```text
DSH version
slot registration signature
client manifest
build command
webServer API
state source
```

验收：

```text
DSH 页面真实可见两个 Surface。
```

---

## M1 — Core + Timeline Motion Engine

目标：

把现有独立 HTML Prototype 的视觉能力正式模块化，并从一开始建立可扩展关键帧 Runtime。

实现：

```text
MotionProperty Registry
AnimationDefinition Schema
AnimationRegistry
TimelineCompiler
TimelineScheduler
TimelineInstance
Built-in Transition Definitions
Built-in Ambient Definitions
PoseResolver
TransitionEngine
AmbientEngine
MotionDirector
PetRenderer
ManualStateSource
```

硬性要求：

```text
Comic Pop
Soft
Jelly
Jump
Snap
Bounce
Sway
Breathing
```

全部通过 `AnimationDefinition` + Timeline Engine 执行。

不得存在一套“Builtin Preset 直接 WAAPI”、另一套“Custom Animation 走 Timeline”的双轨 Runtime。

验收：

```text
独立 Preview：
Idle ↔ Thinking
Comic Pop
Bounce
Sway
Breathing
interrupt

以及：
加载一个测试用 custom AnimationDefinition
→ Runtime 无需特殊代码即可执行
```


---

## M2 — Editor + 图片导入

实现：

```text
Host storage
HTTP API
Image upload
Config persistence
State List
Pose Editor
Transition Editor
Ambient Editor
Live Preview
```

验收：

```text
导入 Idle + Thinking 两张图
调整参数
刷新页面
配置仍在
```

---

## M3 — Overlay

实现：

```text
真实 shell.overlay
PetRenderer
drag
scale
position persistence
visibility / reduced motion
```

验收：

```text
Editor 配置与 Overlay 共享同一 config / renderer。
```

---

## M4 — DSH Agent State

实现：

```text
DshStateAdapter
NormalizedAgentEvent
PetStateResolver
StateMachine
State Stabilizer
```

验收主线：

```text
IDLE
→ ACTIVE
→ WAITING
→ ACTIVE
→ SUCCESS
→ IDLE
```

以及：

```text
THINKING
→ TOOL
→ THINKING
```

期间不得重复完整 Transition。

---

## M5 — Polish

实现：

```text
Anchor 真正对齐
Error handling
loading state
save status
theme tokens
responsive editor
preload
cleanup
performance
```

完成完整 E2E Checklist。

---

## M6 — Packaging / Release

实现：

```text
README
installation
screenshots
license
npm package
GitHub Actions
versioning
```

验收：

```text
从干净环境：
dsh plugin --profile web add <package>
→ restart
→ Settings 导入图片
→ Pet 工作
```

---

# 32. Definition of Done — V1

只有全部满足，V1 才算完成：

### Plugin

- 能通过正常 DSH plugin 流程安装；
- 不需要修改 DSH 核心源码；
- 卸载后不影响 DSH。

### User Asset

- 至少一张图片即可工作；
- 可分别配置六个 Pose；
- 有 fallback；
- 图片持久化。

### Motion

- Comic Pop；
- Soft；
- Jelly；
- Jump；
- Snap；
- Bounce；
- Sway；
- Breathing；
- 所有内置 Motion 均由 AnimationDefinition 驱动；
- Timeline Compiler / Scheduler 可执行 custom AnimationDefinition；
- `pose-swap` 由 Timeline Event 驱动；
- 所有动画可取消；
- 无 transform ownership 冲突。

### Editor

- 图片导入；
- Anchor；
- Transition；
- Ambient；
- 实时预览；
- 状态模拟；
- 参数保存。

### Agent

- Idle；
- Active；
- Waiting；
- Success；
- Error；
- Active 子状态不会高频换 Pose。

### UX

- 可拖动；
- 可缩放；
- 位置保存；
- Reduced Motion；
- 页面刷新不丢设置。

### Engineering

- Core 与 DSH adapter 解耦；
- Motion 与 Pose 解耦；
- Preset 与 Timeline Runtime 解耦；
- Built-in 与 Custom Animation 共用同一 Runtime；
- Host / Client 分层；
- 单测；
- Integration test；
- 生命周期清理；
- 无明显 timer / animation leak。

---

# 33. 后续路线

## V1.1 — Advanced Timeline Editor

在 V1 已存在的 Timeline Runtime 上开放高级编辑能力：

```text
Timeline / Track UI
Keyframe create / move / delete
Property Track selection
Easing editor
Event track
Pose Swap event
Duration
Repeat policy
Preset → Customize
Custom Animation management
Sequence Preview
```

UI 范围保持 Pet-specific，不做通用 After Effects。

V1.1 Motion Property 首批开放：

```text
Scale X
Scale Y
Translate X
Translate Y
Rotation
Opacity
```

同时增加：

```text
Transition Matrix override
Motion Pack import/export
更多 Ambient channel
```

---

## V1.2 — Codex Compatibility

增加：

```text
pet.json
spritesheet.webp
```

Loader。

目标不是取代 Codex 动画，而是：

```text
Codex frame animation
+
Motion Engine deformation
```

即：

```text
spritesheet animation
+ squash/stretch
+ sway
```

---

## V1.3 — Pet Package

格式建议：

```text
my-pet.zip
├── motion-pet.json
└── poses/
    ├── idle.webp
    ├── thinking.webp
    ├── working.webp
    ├── waiting.webp
    ├── success.webp
    └── error.webp
```

---

## V2 — Pet Creation Skill

Skill 输入：

```text
一张角色图片
```

输出：

```text
idle
thinking
happy
sad
motion-pet.json
```

甚至只生成：

```text
idle + thinking
```

其他状态依赖 Runtime fallback。

Skill 重点：

```text
透明背景
Pose 一致性
Anchor 自动估计
角色比例一致
Pet 包打包
Preview QA
```

---

## V3 — Native Desktop Backend

Motion Core 继续复用。

新增 renderer：

```text
DOM Renderer
Native RGBA Renderer
```

Native 可考虑：

```text
预生成 deformation cache
```

而非运行时每帧 resize。

---

# 34. 外部实现调研基线

编码智能体开始工作时建议阅读以下公开项目/文件，但只作为参考：

## DeepSeek Harness 官方

重点：

```text
deepseek-ai/deepseek-harness

packages/client/AGENTS.md
client plugin loading architecture notes
Slot registry
client runtime/session state
host webServer
app boot / bundle patch
```

关键原则：

```text
当前官方 DSH 源码 > 社区插件旧文档
```

---

## dsh-codex-pet

项目：

```text
skr311/dsh-codex-pet
```

值得参考：

```text
Host + Client 双半结构
dsh.bundle.patch
dsh.client
shell.overlay
settings.section
same-origin Host HTTP routes
Pet asset storage
drag
Agent state linkage
```

不要直接继承其旧 Slot API 示例。

---

## dsh-desktop-pet

项目：

```text
sereinmono/dsh-desktop-pet
```

最值得借鉴的不是 native renderer，而是：

```text
HarnessBridge
→ NormalizedEvent
→ PetStateResolver
→ StateMachine
→ Renderer
```

其公开设计也使用：

```text
session/event
agent/status
```

并把 raw harness event 隔离在 integration 层。

---

## OpenAI hatch-pet

项目：

```text
openai/skills
skills/.curated/hatch-pet/
```

它代表传统的“完整动画素材”路线：

```text
Codex-compatible 8×9 atlas
```

本项目的产品差异正是：

```text
不要求完整多帧 atlas
```

但未来可增加 Codex loader 兼容。

---

# 35. 编码智能体最终交付物

完成 V1 后仓库至少应包含：

```text
README.md
AGENTS.md
docs/development-spec.md
docs/implementation-notes.md
docs/motion-format.md

src/host/*
src/core/*
src/motion/*
src/integration/dsh/*
src/client/*

tests/*
```

README 必须包含：

```text
项目截图 / GIF
安装
升级
卸载
如何导入图片
如何调动画
状态说明
兼容版本
开发命令
测试命令
Known limitations
```

---

# 36. v0.2 编码决策摘要

编码智能体必须把以下内容视为已经确认的架构决策，而不是待讨论选项：

```text
1. V1 用户界面仍以 Preset 为主。
2. V1 底层已经是关键帧 Timeline Engine。
3. Preset 本质是内置 AnimationDefinition。
4. Ambient Motion 同样使用 AnimationDefinition。
5. Track 操作逻辑 Motion Property，不允许直接覆盖 CSS transform。
6. Keyframe 时间使用 0..1。
7. pose-swap 是 Timeline Event。
8. Timeline Scheduler 必须支持 cancellation / generation。
9. Thinking Bounce 使用 random-interval Repeat Policy。
10. V1 不做高级 Timeline Editor。
11. V1.1 在同一个 Runtime 上开放 Timeline Editor。
12. Custom Animation 和 Built-in Animation 走完全相同的 Compiler / Scheduler。
13. AnimationDefinition 从 V1 开始必须可序列化，为 Motion Pack 做准备。
14. 禁止为赶进度建立无法兼容 Custom Animation 的硬编码 Motion Runtime。
```

如果 M1 的实现无法让以下伪代码成立：

```ts
registry.register(customDefinition)
motionDirector.play(customDefinition.id)
```

且无需为该动画新增专用 TypeScript 分支，则 M1 架构不合格。

---

# 37. 最后一个原则

如果实现过程中出现“动画效果”和“状态触发逻辑”之间的取舍：

> **优先保证触发逻辑稳定，再追求动画夸张程度。**

本项目最差的体验不是动画不够弹，而是：

```text
Agent 每输出一小段内容
Pet 就弹一下
```

因此必须坚持：

```text
Raw Agent Events
        ↓
Semantic State
        ↓
Visual State Stabilizer
        ↓
Motion Director
```

而不是：

```text
Raw Event
↓
Animation
```

V1 的核心产品体验应该始终是：

> **导入两三张静态角色图，就能得到一个会自然切换姿势、思考时轻轻摇摆和弹动、任务完成时有漫画式反馈的 DSH Pet。**
