# AnimationDefinition 数据格式说明

本文面向未来要编写 **Motion Pack**（自定义动画包）的用户，说明 petween 的动画数据格式。
所有动画——无论是内置 Preset（Comic Pop / Bounce / Sway……）还是用户自定义动画——都是一份
`AnimationDefinition` JSON，由同一个 Timeline Engine 编译执行（规格 §8）。运行时没有任何针对
具体动画的专用分支，因此**你写的每一份合法 JSON 都能直接运行**。

类型源码见 `src/motion/animation-definition.ts`，内置示例见
`src/core/transition-presets.ts` 与 `src/core/ambient-presets.ts`。

## 1. 顶层结构

```json
{
  "version": 1,
  "id": "user:manga-pop",
  "name": "Manga Pop",
  "kind": "transition",
  "durationMs": 260,
  "repeat": { "mode": "once" },
  "tracks": [ "……见第 3 节……" ],
  "events": [ { "at": 0.4, "type": "pose-swap" } ],
  "parameters": { "strength": { "default": 1, "min": 0, "max": 1.8 } }
}
```

| 字段 | 说明 |
| --- | --- |
| `version` | 固定为 `1`。 |
| `id` | 必须是 `<命名空间>:<名称>`：`builtin:<name>` 保留给内置动画（用户注册会被拒绝），自定义请用 `user:<uuid>`。只允许字母数字、`-`、`_`。 |
| `name` | 展示名称。 |
| `kind` | `transition`（进入过渡）/ `ambient`（循环动画）/ `interaction`（交互动效）。`transition` 的 duration 会被 clamp 到 60~2000ms。 |
| `durationMs` | 基准时长（1~60000ms）。关键帧时间是归一化的，改 duration 不影响比例。 |
| `repeat` | 重复策略，见第 5 节。 |
| `tracks` | 关键帧轨道数组；可以为空数组（配合 `at: 0` 的 pose-swap 即"无动画直接换图"）。 |
| `events` | 可选，时间线事件，见第 6 节。 |
| `parameters` | 可选，声明 `strength` 参数的默认值与范围，供 UI 滑杆使用。 |

整份定义必须是**纯 JSON 可序列化**的：不允许函数、表达式或 `eval`。

## 2. Motion Property 白名单（§8.2）

Track 只能写以下受控属性，不允许直接写 CSS `transform` 或任意 CSS 属性。属性名前缀即
目标层（transform ownership 分层，规格 §3.4）：

| 属性 | 含义 | 默认值 |
| --- | --- | --- |
| `transition.scaleX` / `transition.scaleY` | 过渡层缩放 | `1` |
| `transition.x` / `transition.y` | 过渡层位移（px，y 向下为正） | `0` |
| `transition.rotation` | 过渡层旋转（度） | `0` |
| `transition.opacity` | 过渡层不透明度（0~1） | `1` |
| `sway.rotation` | 摇摆层旋转（度） | `0` |
| `bounce.x` / `bounce.y` | 弹跳层位移（px） | `0` |
| `bounce.scaleX` / `bounce.scaleY` | 弹跳层缩放 | `1` |
| `breathe.scaleX` / `breathe.scaleY` | 呼吸层缩放 | `1` |

写入未知属性会在注册/编译时直接报错。

## 3. Track 与 Keyframe

```json
{
  "property": "transition.scaleX",
  "keyframes": [
    { "at": 0,    "value": 1 },
    { "at": 0.38, "value": { "base": 1, "parameter": "strength", "amount": 0.16 }, "easing": "ease-out" },
    { "at": 1,    "value": 1 }
  ]
}
```

- `at` 是 **0..1 归一化时间**（规格 §8.3），不是毫秒；同一轨道内按 `at` 排序（乱序会在编译期自动排序，但建议自己排好）。
- 每条轨道至少 1 个关键帧。
- **同一个 property 只允许一条 track**（V1）：编译器按 property 查轨道时只取第一条，重复轨道是永远不会生效的歧义数据，注册时直接拒绝。
- 缺端点的补齐策略（§8.4）：首帧 `at > 0` 时，编译器用**属性默认值**补 0 点；尾帧 `at < 1` 时，用**最后一个值保持**到 1。
- `value` 可以是数字，或 ParameterizedValue（见第 4 节）。
- `easing` 可选，作用于"该帧到下一帧"之间；缺省为 `linear`。

## 4. ParameterizedValue（strength 参数化，§8.8 / §9.2）

Preset 需要支持强度调节，但不能把强度逻辑写进代码。统一用：

```json
{ "base": 1, "parameter": "strength", "amount": 0.16 }
```

求值公式：`value = base + strength * amount`。两个惯用写法覆盖了规格的两种语义：

- **缩放**（`scaled = 1 + (v-1) * strength`）：`base: 1`，`amount: v - 1`。
  例：`{ base: 1, amount: 0.16 }`，strength=0.5 时得 1.08。
- **位移/角度**（`px * strength`）：`base: 0`，`amount: px`。
  例：`{ base: 0, amount: -16 }`，strength=0.5 时得 -8px。

strength 超出 `parameters.strength` 声明的 `min`/`max` 会被 clamp。目前唯一支持的参数是
`strength`；sway 的角度等通道参数也由它承载（1 strength = 1 度）。

## 5. Repeat Policy（§8.6）

```json
{ "mode": "once" }
{ "mode": "loop" }
{ "mode": "alternate" }
{ "mode": "random-interval", "minDelayMs": 800, "maxDelayMs": 1300 }
```

- `once`：播放一次。所有内置 transition 都是 once。
- `loop` / `alternate`：**无 events** 的定义会编译成单条 `iterations: Infinity` 的 WAAPI
  动画（compositor 友好，`alternate` 映射为 `direction: 'alternate'`）；有 events 的定义由
  Scheduler 逐段正向重跑。因此 **`alternate` + events 被拒绝**（V1）——Scheduler 对有事件的
  时间线没有反向回播，格式不承诺运行时做不到的事；无事件的 `alternate` 完全合法。
- `random-interval`：随机等待 `minDelayMs~maxDelayMs` → 播放一遍 → 再随机等待……
  Thinking Bounce 必须用它，禁止机械固定循环（§11.1）。

## 6. Timeline Event：pose-swap 与 particle（§8.5 / §8.10）

V1 支持两种事件：

```json
{ "at": 0.4, "type": "pose-swap" }
{ "at": 0.45, "type": "particle", "effect": "confetti" }
```

**pose-swap**：时间线播放到 40% 时切换 Pose 图片。编译器会在事件点把时间线**切成两段**，
Scheduler 逐段执行并 `await animation.finished`，因此换图时机与视觉时间严格一致，不会用
`setTimeout` 近似（§10.1）。

**particle**：在事件点发射一次 DOM 粒子爆发（纸屑/星星/微光），由 client renderer 的粒子层
执行；`effect` 必须是以下之一：

| effect | 效果 |
| --- | --- |
| `confetti` | 彩色纸屑条/圆点向外放射，带翻滚与重力下坠 |
| `star-burst` | 漫画星星/十字小形状放射 |
| `sparkle` | 小十字微光，短距离快速淡出 |

particle 是纯视觉点缀：**reduced-motion 下不发射**（pose-swap 仍会发生，§22），也可由配置的
`advanced.particles` 开关整体关闭。同一个 `at` 上允许多个事件（如 pose-swap 与 particle 同在
0.45），Scheduler 按数组顺序在同一切段边界依次触发。

V1 的事件数量约束（注册时强制）：

- **`kind: 'transition'` 必须恰好包含 1 个 pose-swap 事件**，另允许 0..n 个 particle 事件——
  transition 的语义就是"换一次图"，如 Comic Pop 的 `0.40`；0 个或 2 个以上 pose-swap 都会被拒绝。
- **`interaction` 不允许 pose-swap，允许 0..n 个 particle**——交互动效不换图，但可以撒花。
- **`ambient` 不允许声明任何 events**——循环动画不换图、不发射。
- 事件在 reduced-motion 下依然保留在编译产物里：动画坍缩但**换图仍会发生**（§22）；particle
  事件是否发射由 renderer 在运行时决定。
- 编译器/Scheduler 的切段机制本身是通用的（V1.1 放宽 runtime 语义后可能允许更多事件组合，
  届时再解除该限制）。

## 7. Easing（§8.7）

支持 CSS 关键字：`linear` / `ease` / `ease-in` / `ease-out` / `ease-in-out`，标准
`cubic-bezier(x1, y1, x2, y2)`（x 必须在 0..1），以及四个语义 alias（编译期展开为
cubic-bezier，V1 不做物理弹簧求解）：

| alias | 展开 |
| --- | --- |
| `spring-soft` | `cubic-bezier(0.25, 1.1, 0.45, 1)` |
| `spring-snappy` | `cubic-bezier(0.2, 1.4, 0.4, 1)` |
| `overshoot` | `cubic-bezier(0.34, 1.56, 0.64, 1)` |
| `anticipate` | `cubic-bezier(0.36, 0, 0.66, -0.56)` |

**同层 easing 一致性（V1 强制）**：共享同一 targetLayer 的多条 track（如 `transition.scaleX` +
`transition.scaleY` + `transition.y`）会被编译器合并成**一条** WAAPI keyframe 列表，每个采样点
只能取一个 easing（取首条 track 的）。因此 V1 要求同层 track 在每个时间区间上的 easing 一致
（按展开后的 cubic-bezier 比较，`linear` 与省略等价）；不一致会在注册时报错并指出 layer 与
时间点。最稳妥的写法是同层 track 使用相同的关键帧时间点与相同的 easing 序列。V1.1 若放宽
runtime（按 track 输出独立动画），该限制会相应解除。

## 8. 内置动画 ID 一览（§8.13）

Transition：`builtin:none` / `builtin:soft` / `builtin:comic-pop`（默认）/ `builtin:jelly` /
`builtin:jump` / `builtin:snap` / `builtin:flip` / `builtin:celebrate`（pose-swap 同时发
confetti 粒子）/ `builtin:deflate`。

Ambient：`builtin:bounce` / `builtin:sway` / `builtin:breathe`。

`builtin:*` 命名空间受保护：用户不能注册同名 id，也不能 unregister。想改造内置动画时，请
克隆一份存为 `user:<uuid>` 再修改（Preset → Customize，§8.15）。

## 9. 将自定义动画挂载到宠物

动画在动画库中保存后，可按类型挂载到对应入口：

- `transition`：`states.<状态>.enter.animationId`
- `ambient`：`states.<状态>.ambient.customAnimationId`
- `interaction`：`interactions.click.animation`

六个状态都可独立选择一个自定义 `ambient` 动画。它会与该状态启用的 Bounce / Sway /
Breathing 同时播放，时长、循环方式和参数默认值取自动画定义；开启「减少动态」后停止播放。
删除仍被任一状态或宠物预设引用的动画时，Host 会返回 `409 ANIMATION_IN_USE`。

```json
{
  "states": {
    "idle": {
      "ambient": {
        "customAnimationId": "user:gentle-float"
      }
    }
  }
}
```

## 10. 完整自定义动画示例

一份"漫画式重击落地"的自定义 transition：先急剧压缩蓄力，换图后向上猛弹并带回转，最后
果冻式稳定。可直接 `registry.register()` 后 `motionDirector.play('user:slam-land')` 执行。

```json
{
  "version": 1,
  "id": "user:slam-land",
  "name": "Slam Land",
  "kind": "transition",
  "durationMs": 320,
  "repeat": { "mode": "once" },
  "tracks": [
    {
      "property": "transition.scaleX",
      "keyframes": [
        { "at": 0,    "value": 1 },
        { "at": 0.3,  "value": { "base": 1, "parameter": "strength", "amount": 0.22 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 1, "parameter": "strength", "amount": -0.14 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 1, "parameter": "strength", "amount": 0.05 } },
        { "at": 1,    "value": 1 }
      ]
    },
    {
      "property": "transition.scaleY",
      "keyframes": [
        { "at": 0,    "value": 1 },
        { "at": 0.3,  "value": { "base": 1, "parameter": "strength", "amount": -0.24 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 1, "parameter": "strength", "amount": 0.18 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 1, "parameter": "strength", "amount": -0.04 } },
        { "at": 1,    "value": 1 }
      ]
    },
    {
      "property": "transition.y",
      "keyframes": [
        { "at": 0,    "value": 0 },
        { "at": 0.3,  "value": { "base": 0, "parameter": "strength", "amount": 6 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 0, "parameter": "strength", "amount": -12 }, "easing": "overshoot" },
        { "at": 0.8,  "value": 0 },
        { "at": 1,    "value": 0 }
      ]
    },
    {
      "property": "transition.rotation",
      "keyframes": [
        { "at": 0,    "value": 0 },
        { "at": 0.3,  "value": 0, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 0, "parameter": "strength", "amount": -4 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 0, "parameter": "strength", "amount": 1.5 } },
        { "at": 1,    "value": 0 }
      ]
    }
  ],
  "events": [ { "at": 0.42, "type": "pose-swap" } ],
  "parameters": { "strength": { "default": 1, "min": 0, "max": 1.8 } }
}
```

校验规则汇总（注册时强制执行）：未知 property 拒绝；同一 property 重复 track 拒绝；`at` 必须
0..1；每条轨道至少 1 帧；easing 必须合法；同层 track 的 easing 必须逐区间一致；repeat policy 必须
合法（`alternate` 不允许带 events）；transition 必须恰好 1 个 pose-swap（particle 事件 0..n 允许），
interaction 禁止 pose-swap（particle 允许），ambient 不允许任何 events；particle 的 `effect` 必须是
`confetti` / `star-burst` / `sparkle` 之一；`durationMs` 1~60000；`id` 必须符合命名空间规范。
