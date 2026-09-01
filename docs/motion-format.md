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
| `version` | 固定为 `1`。更高版本的定义来自更新版本的 petween——宿主会**明确拒绝**（不静默跳过、不误读），错误信息会指明「由更新的 petween 写出」。 |
| `id` | 必须是 `<命名空间>:<名称>`：`builtin:` 保留给内置动画（注册会被拒绝）。自定义命名空间为**小写字母开头的小写字母/数字/`-` 串**（如 `user:`、`motion:`）；名称段**以字母或数字开头**，其后允许字母数字、`-`、`_`。编辑器手作动画默认 `user:`；Motion Pack 会使用自己的命名空间前缀（见 §11）。 |
| `name` | 展示名称。 |
| `kind` | `transition`（进入过渡）/ `ambient`（循环动画）/ `interaction`（交互动效）。`transition` 的 duration 会被 clamp 到 60~2000ms。 |
| `durationMs` | 基准时长（1~60000ms）。关键帧时间是归一化的，改 duration 不影响比例。 |
| `repeat` | 重复策略，见第 5 节。 |
| `tracks` | 关键帧轨道数组；可以为空数组（配合 `at: 0` 的 pose-swap 即"无动画直接换图"）。 |
| `events` | 可选，时间线事件，见第 6 节。 |
| `parameters` | 可选，声明 `strength` 参数的默认值与范围，供 UI 滑杆使用。 |

**未知字段政策（B1）**：schema 之外的字段在加载与再保存时**原样保留、永不解释**——
这样旧版本读取器往返新版本动画包时不会破坏其中的新增字段。运行时只消费上表及
下文列出的字段。

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

- `once`：播放一次。所有内置 transition 都是 once。**once / interaction 定义的末帧
  应回归属性默认值**：Scheduler 在时间线收尾时会 cancel 段动画（`fill:'forwards'`
  不保留），末帧非默认值的定义在最后一帧会被直接抹回默认值，看起来就像"没写完"。
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
{ "at": 0.4, "type": "pose-swap", "pose": "user:my-pack-doze" }
{ "at": 0.45, "type": "particle", "effect": "confetti" }
```

**pose-swap**：时间线播放到 40% 时切换 Pose 图片。编译器会在事件点把时间线**切成两段**，
Scheduler 逐段执行并 `await animation.finished`，因此换图时机与视觉时间严格一致，不会用
`setTimeout` 近似（§10.1）。

可选的 **`pose` 字段**（2026-08-27 开放）给事件命名换图目标：六个内置槽名之一
（`idle`/`thinking`/`working`/`waiting`/`success`/`error`，走各自 fallback 链），或一个经
`petween/client` 服务 `registerPoses` 注册的 `user:` pose id（附属插件自带图片）。目标在
**播放时**解析：未注册的键静默跳过（与悬空 `animationId` 回落同一纪律）。enter 路径
（transition）**忽略**该字段——进场换哪张图由状态机决定，不由动画数据决定；因此 transition
的 pose-swap 声明 `pose` 会被校验拒绝。

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

事件数量约束（注册时强制）：

- **`kind: 'transition'` 必须恰好包含 1 个 pose-swap 事件**，且不得声明 `pose` 字段（进场
  pose 归状态机所有）——transition 的语义就是"换一次图"，如 Comic Pop 的 `0.40`；0 个或
  2 个以上 pose-swap 都会被拒绝。
- **`kind: 'interaction'` 允许 0..n 个 pose-swap**，但每个**必须声明 `pose` 目标**——交互动效
  可以换图（如打盹动画切睡眠姿势），结束后自动回到状态机当前 pose（复用 flash 记账：真实
  状态变化随时可抢占）。另允许 0..n 个 particle。
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
confetti 粒子）/ `builtin:deflate` / `builtin:activity-swap`（供「活跃内切换姿势」的 subtle
模式内部使用，对应配置 `advanced.activityTransition`）。

Ambient：`builtin:bounce` / `builtin:sway` / `builtin:breathe`。

Interaction（点击互动可选的内置项，也可挂自定义 interaction 动画）：`builtin:click-pop` /
`builtin:click-wiggle` / `builtin:click-bounce` / `builtin:click-spin`。

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

校验规则汇总（注册时强制执行，与 §6 的事件规则一致）：未知 property 拒绝；同一 property 重复 track
拒绝；同一 track 内重复 `at` 拒绝；`at` 必须 0..1；每条轨道至少 1 帧；easing 必须合法；同层 track 的
easing 必须逐区间一致；repeat policy 必须合法（`alternate` 不允许带 events，运行时 repeat 覆盖同样受此
约束）；`random-interval` 要求 `1 <= minDelayMs <= maxDelayMs <= 600000`；`transition` 必须恰好 1 个
pose-swap 且不得声明 `pose`（particle 事件 0..n 允许）；`interaction` 允许 0..n 个 pose-swap 但每个必须
声明 `pose` 目标（particle 允许），ambient 不允许任何 events、也不得使用 transition 层的轨道（避免与
进场过渡在同一 DOM 层打架）；particle 的 `effect` 必须是 `confetti` / `star-burst` / `sparkle` 之一；
`durationMs` 1~60000；`id` 必须符合命名空间规范。

## 11. Motion Pack：动画包格式（P2）

一个 Motion Pack 是**单个 JSON 文件**（规格 §8.18 的 zip 是未来容器——动画包不含
二进制内容，单文件分发最简单）。结构：

```json
{
  "format": "motion-pack",
  "version": 1,
  "name": "漫画弹跳包",
  "namespace": "manga-pop",
  "animations": [ { "……第 1 节的 AnimationDefinition……" } ],
  "mounts": { "idle": { "enter": "manga-pop:bounce", "ambient": "manga-pop:sway" } }
}
```

| 字段 | 说明 |
| --- | --- |
| `format` / `version` | 固定 `motion-pack` / `1`。更高版本由更新的 petween 写出——导入会**明确拒绝**并提示升级插件，绝不静默误读。 |
| `name` | 展示名（≤120 字符）。 |
| `namespace` | 包声明的命名空间（小写字母/数字/`-`）。包内所有 `animations` 的 id 必须落在该命名空间——包不能夹带他人命名空间的动画。特殊值 `mixed` 表示各动画保留自己的命名空间（跨命名空间导出时自动产生）。 |
| `animations` | 1~200 个合法 `AnimationDefinition`；包内 id 不得重复；未知字段原样保留。 |
| `mounts` | 可选。键为六个状态槽（`idle`/`thinking`/…），`enter` 引用包内 **transition** 类动画、`ambient` 引用包内 **ambient** 类动画。导入时会解析为**最终 id** 随结果返回——是否应用到配置由用户决定（v1 不自动应用）。 |

### 导入语义（撞车策略）

对每个动画，按库里现状三选一，**绝不静默覆盖、不整包拒绝**：

- 目标 id 空闲 → 原样导入；
- 目标 id 已有**完全相同**内容 → 跳过（重复导入同一包是幂等的）；
- 目标 id 已有**不同**内容 → 改用第一个空闲后缀导入（`-2`、`-3`…；空闲 = 库里不存在，
  且不被**本包自己**请求或占用——包内同伴请求的 id 即使在库里空闲也应原样导入，改号者
  让位），`mounts` 引用同步改写到最终 id，导入结果里逐条回报 `requestedId → finalId`。

### 导出

`GET /api/petween/packs/export?ids=…` 按选中动画生成清单：同命名空间时
`namespace` 为该命名空间，跨命名空间时为 `mixed`；导出**不携带 mounts**
（挂载是包作者的意图，不是用户当前的配置状态）。导出的包再导入应当全部
`identical`（幂等往返）。

### 挂载应用（applyPatch，2026-08-29）

导入响应在带有 mounts 时附带 `applyPatch`：一个**最小 states 补丁**（`{states: {<槽位>: {enter: {animationId}, ambient: {customAnimationId}}}}`，只含挂载覆盖的字段，id 已解析为碰撞规划后的**最终 id**）。它不是导入的一部分——客户端把它留给用户确认；PUT `/api/petween/config` 时按字段级补丁语义并入当前活配置（未涉及字段回落当前值），镜像随之写进**当前激活宠物**。这就是「把动画包装到当前宠物身上」的标准路径。

## 12. 宠物包：Pet Package（v1）

一个可分享的完整宠物——图片 + 设定 + 动画，zip 容器（图片是二进制，单 JSON 需 base64 膨胀 33%，不取）。

### 结构

```text
pet-package.zip
├── manifest.json
└── assets/<assetId>.<png|webp|jpeg>
```

```json
{
  "format": "pet-package",
  "version": 1,
  "name": "≤120 字符",
  "pet": { "scale": 1.1, "poses": { "……六个槽位……": {完整 PoseConfig} }, "states": { "……六个状态……": {完整 StateAppearance} } },
  "assets": [ { "id": "16-hex", "sha256": "64-hex", "file": "assets/<id>.<ext>", "mimeType": "image/png", "width": 1254, "height": 1254 } ],
  "motionPack": { "format": "motion-pack", "version": 1, "name": "…", "namespace": "mixed", "animations": [ "……§11 内联定义……" ], "mounts": { "idle": { "ambient": "ns:x" } } },
  "attribution": { "character": "DeepSeek 女仆鲸鱼娘（溟月）", "creators": ["上善无形（原型）", "ZipZipPipe（女仆装）"], "sourceUrl": "https://…", "license": "CC BY-NC-SA 4.0" },
  "pluginConfigs": { "petween-physics": { "config": { "……opaque：附属自己的配置……" }, "animationIdRemap": { "user:wall-bounce": "user:wall-bounce-2" } } }
}
```

| 字段 | 规则 |
| --- | --- |
| `pet` | 完整角色切片（scale/poses/states），同 §11 `applyPatchFor` 的权威语义：states 中缺席的动画引用按 null 清空。 |
| `assets` | `id` 为内容 sha256 前 16 hex（与资产库同一命名法，天然去重）；`poses` 引用的每个 assetId 必须在清单内且文件存在于包中；未被引用的清单条目冗余，导入忽略并 warning。 |
| `motionPack` | 可选。完整 §11 Motion Pack v1 对象。**与纯动画包导出相反，宠物包的 mounts 必须携带**——导出时从 `pet.states` 的动画引用推导（`enter.animationId`→`mounts.<槽>.enter`，`ambient.customAnimationId`→`mounts.<槽>.ambient`；`builtin:*` 不入包），导入时经碰撞规划改号后重写进新宠物的 states。 |
| `attribution` | 可选。角色形象署名/来源/许可，导出端从宠物预设的 attribution 字段带入，导入端原样存到新建宠物上；编辑器宠物区可编辑。分享传播时署名随包走。 |
| `pluginConfigs` | 可选。附属插件配置 blob（形状与纪律见「附属插件配置」小节），导出端从宠物记录原样携带，导入端存到新建宠物记录上。petween 只做形状/大小校验，对内容**零校验、零解释**。 |

### 校验（导入拒绝，逐字段错误）

zip 条目数 ≤ 64、解压总大小 ≤ 60MB、单文件 ≤ 12MB；条目路径白名单（`manifest.json` 或 `assets/<16hex>.<ext>`，拒绝穿越/绝对路径/反斜杠）；图片走资产侧同一套校验（magic bytes 与 MIME 一致、尺寸 ≤ 4096、拒绝 SVG），sha256 与清单一致；`version > 1` 明确拒绝并提示升级插件（B1 seam 同款规则）。states 引用的包内动画另做 kind 交叉检查（enter 必须 transition、ambient 必须 ambient），同样拒绝在任何落盘之前。`pluginConfigs` 逐字段校验：键必须匹配 `^[a-z0-9][a-z0-9-]*$` 且 ≤64 字符，条目数 ≤ 8，每条必含 `config`（任意 JSON 值、序列化 ≤16KiB），整体序列化 ≤64KiB，`animationIdRemap` 必须是 string→string 映射。

### 导入语义（原子性）

全部校验（含 states 引用的 kind 交叉检查）与碰撞规划**先行只读**，随后才落盘：图片按内容哈希幂等入库（已有同内容资产直接复用原 id）→ 动画走 §11 既有三选一规划（单锁段事务）→ **宠物创建是最后一步**（states 引用改写为最终 id，attribution 与 pluginConfigs 原样带入同一原子记录，pluginConfigs 每条注入本次改号表）→ 创建后立即 apply。任何一步失败（含建宠与 apply）都会**尽力回滚**本次写入：先删宠物文件，再按引用探针回滚动画与资产，且只删除本次真正新建的资产（去重复用的共享资产不动）。回滚自身再失败时最多留下可清理的未引用资产/动画，绝无「半只宠物」被激活。导入即用：apply 切换为激活宠物，响应携带完整报告（资产 新增/复用、动画 新增/相同/改号、挂载映射、新宠物与配置）。

### 附属插件配置（pluginConfigs）

宠物包可携带**附属插件**（如 petween-physics）的配置 blob，让接收方获得完整的「宠物性格」。纪律是「主插件提供能力不做策略」：petween 只搬运、存盘、做命名空间与大小校验，**对 blob 内容零校验、零解释**——schema 归各附属自己（物理参数范围只有附属知道）；应用（重写 blob 内的动画 id、弹确认 UI、写入自己的配置）也永远由附属在用户确认后经自己的 API 完成，导入流程对附属数据目录零接触。

```json
"pluginConfigs": {
  "<plugin-id>": {
    "config": "……任意 JSON：附属自己的完整或部分配置……",
    "animationIdRemap": { "<旧动画 id>": "<最终动画 id>" }
  }
}
```

- 键 = 附属插件 cordis 名（如 `petween-physics`），charset 与上限见上「校验」；每条必含 `config`；`animationIdRemap` 可选，string→string 映射。
- **改号表注入**：导入时 host 用本次动画改号表（§11 碰撞规划的 `requestedId → finalId` 全集，含 identical 恒等项）**覆盖注入**每条的 `animationIdRemap`；host 只注入映射、**不重写 blob 内容**——它不知道 blob 里哪些字符串是动画 id，用映射重写自己的 blob 是附属应用时的事。本次导入无动画条目时保留包内原值（petween 不解释，也不删）。
- `version` 保持 1：纯增量字段，旧导入端对顶层未知字段本就静默忽略，新构建读取；与 API_FEATURES「只增不减」同规。
- 存储：随新建宠物记录持久化（**切片外**字段，与 name/attribution 同层——config 镜像只重写切片三键，不动它）；附属之后可随时经 `GET /api/petween/pets/<id>` 拉取自己命名空间的 blob，附属缺席时 blob 静卧记录等待后装。
- 导出：默认携带记录里已存的 blob；客户端导出前可经 `petween/client` 服务的 `registerSharedPluginConfigProvider`（additive，v1）向**在场**附属收集当前配置，随 `POST` 导出变体提交——按命名空间整体**覆盖**记录快照（收集结果就是附属的当前真相，remap 反正由导入时重新注入），未收集到的命名空间保留记录快照；导出纯读不回写记录。
- **分享卫生约定**：附属 provider 只放**可公开的可调参数**（重力/弹性这类「性格」数值）；秘密、令牌、个人数据**不得进包**——包会被原样转发给接收方。
- 导入响应 `report.pluginConfigs` 附带本次携带的命名空间列表（无 blob 时该键缺席）。

### HTTP

- `GET /api/petween/pets/<id>/export` → `application/zip`
- `POST /api/petween/pets/<id>/export`（可选 JSON body `{ pluginConfigs }` ≤64KiB，同 §12 校验规则，非法 → 400 `INVALID_PLUGIN_CONFIGS`）→ `application/zip`（收集覆盖后的打包结果）
- `POST /api/petween/pets/import`（body 为 zip 二进制，≤ 48MB）→ `{ pet, config, report }`
