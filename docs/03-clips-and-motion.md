# 03 · 片段与动作

> 状态：已定（2026-10-19）

## 1. 三个概念，互不越界

| 概念 | 管什么 | 不管什么 |
|---|---|---|
| **片段（Clip）** | 画面：一张图、一段帧序列、一段视频 | 位置、旋转、缩放等任何运动 |
| **动作（Motion）** | 变换：位移、旋转、缩放、斜切、透明度 | 显示哪张图 |
| **状态键（State key）** | 语义：宠物「处于什么状态」 | 具体画面和运动 |

宠物包把状态键映射到「片段 + 动作」（见 04）。v0 中「动画里带 pose-swap 事件并指定换哪张图」的做法废除：**动作永远不选图。**

## 2. 片段

```ts
interface Clip {
  id: string
  type: 'still' | 'frames' | 'video' | string   // string：插件注册的片段类型
  source: string            // 宠物包内的相对路径
  fps?: number              // frames / video
  /** frames 的精灵图布局；单帧尺寸 = 图宽 / columns。columns 缺省 = count（单行） */
  frames?: { count: number; columns?: number }
  /** 分段（帧号区间）。没有 enter/exit 就整段当 loop。 */
  segments?: { enter?: [number, number]; loop?: [number, number]; exit?: [number, number] }
  /** 标记点：帧号 → 名字，例：{ 12: 'land' } */
  markers?: Record<number, string>
  anchor: { x: number; y: number }   // 0..1，默认脚底中心 (0.5, 0.96)
  scale?: number                      // 片段自身缩放，用于统一不同来源的图的大小
}
```

### 导入管线（宿主 + 运行时协作）

AI 生成的素材格式五花八门，导入时统一处理：

| 输入 | 处理 | 存为 |
|---|---|---|
| PNG / JPG / WebP 静态图 | 原样（JPG 无透明，提示用户） | `still` |
| GIF / APNG / 动态 WebP | 解码为帧 | `frames`（WebP spritesheet + 元数据） |
| 短视频（≤ 10s） | 解码为帧（可选降帧率） | `frames` |
| 长视频 | 保留，播放时用 `<video>` | `video`（带透明需 WebM VP9 alpha；macOS 需另备 HEVC alpha，v1 只保证 Windows） |

转成帧序列的理由：所有素材都能**暂停、调速、跳段、对齐标记点**，透明通道跨平台一致，命中掩码可以从透明通道直接算出来。代价是内存，所以对时长和分辨率设上限（默认长边 ≤ 512px、≤ 10s）。

导入时同时生成**命中掩码**（每帧的低分辨率 alpha 位图），供鼠标穿透的命中检测使用。

## 3. 动作

### 3.1 统一接口

所有运动来源——K 帧、物理、程序生成、插件代码——都实现同一个接口：

```ts
interface TransformDelta {
  x?: number; y?: number          // px
  rotate?: number                 // deg
  scaleX?: number; scaleY?: number // 倍数，1 = 不变
  skewX?: number; skewY?: number   // deg
  opacity?: number                 // 倍数，1 = 不变
}

interface MotionContext {
  pet: PetHandle                  // 读位置、速度、当前状态键等
  params: Record<string, unknown> // 来自宠物包的参数
  strength: number                // 全局/状态级的强度系数
  reducedMotion: boolean
}

interface MotionSource {
  /** 每帧调用。t = 本动作开始后的毫秒数，dt = 距上一帧的毫秒数。 */
  evaluate(t: number, dt: number, ctx: MotionContext): TransformDelta
  /** 一次性动作返回总时长；循环动作返回 null。 */
  readonly duration: number | null
  /** 时间点 → 标记名（一次性动作可用，例：{ 180: 'swap' }） */
  readonly markers?: Record<number, string>
  /** 不定时长的一次性动作（如冲量弹簧）用它报告结束 */
  isDone?(): boolean
  dispose?(): void
}

/** 动作类型 = 一个工厂。宠物包用 { type, ...params } 引用。 */
interface MotionType {
  id: string                                  // 'keyframes' | 'spring' | 'noise' | 'sine' | 插件注册的
  create(params: unknown): MotionSource
  paramsSchema?: JSONSchema                    // 让编辑器能自动生成参数面板
}
```

### 3.2 内置动作类型

| 类型 | 用途 | 关键参数 |
|---|---|---|
| `keyframes` | 手 K 的过渡、点击反馈 | 轨道（属性 → 关键帧 + 缓动），可带标记 |
| `spring` | 拖拽惯性、落地回弹、果冻感 | 刚度、阻尼、驱动源（宠物速度 / 一次性冲量） |
| `noise` | 随机颤动、紧张发抖 | 振幅、频率、作用属性 |
| `sine` | 呼吸、摇摆、上下浮动 | 振幅、周期、相位、作用属性 |

插件注册新类型后（例如「心跳」「受风吹」），宠物包就能用 `{ type: 'my-plugin:wind', ... }` 引用。

### 3.3 合成

每个活跃动作带三个属性：

- `layer`：固定的层，决定合成顺序
- `blend`：`add`（叠加）或 `override`（覆盖下面的层）
- `weight`：0..1

**固定层序**（从下到上）：

| 层 | 典型来源 |
|---|---|
| `base` | 状态的循环动作（呼吸、摇摆） |
| `transition` | 状态切换时的一次性动作 |
| `physics` | 弹簧、惯性 |
| `plugin` | 插件的动作 |
| `interaction` | 点击、悬停反馈 |

**合成规则**：

- `add`：位移、旋转、斜切相加；缩放、透明度相乘（按 `weight` 插值：`1 + (v - 1) * weight`）。
- `override`：把累计值向本层值按 `weight` 插值；`weight = 1` 时完全覆盖。
- 合成结果最后绕片段锚点施加。

这样同一个画面可以同时被 K 帧、物理和噪声驱动，彼此不知道对方存在。

## 4. 状态切换的时序

状态键从 A 变成 B 时：

```
时间 →
A 的 exit（可选）  ──┐  被打断则跳过
                    ▼
B 的 enter 动作  ───────●────────────┐      ● = 'swap' 标记
                       │             │
片段：A 的画面 ───────────┘ B 的 enter 段 → B 的 loop 段
                                     ▼
B 的循环动作（base 层）                └─────────→
```

1. A 配了 `exit` 且未被打断 → 先播 A 的退出动作和片段退出段。
2. 开始 B 的 `enter` 动作（transition 层）。**片段在 enter 动作的 `swap` 标记处切换**；没有 `swap` 标记则立即切换。
3. 切换方式由 `transition` 决定：`cut`（硬切，默认）、`crossfade`（交叉淡化，参数：时长）、`onMarker`（等 A 片段的某个标记再切）、`afterLoop`（等 A 当前循环播完）。
4. enter 动作开始时，A 的循环动作在 250ms 内**淡出**（不是当场掐断，否则摇摆中的姿态会一下子弹回原位）；enter 动作结束后，B 的循环动作在 base 层**淡入**。A、B 共用的循环动作（同一个引用）不中断、不重启，保持相位连续。
5. 切换过程中又来了新状态 C → 取消 B 的 enter，从当前画面直接开始 A→C 的流程（不播 B 的 exit）。

**推荐做法：先换图，再做反应动作**（2026-10-21 作者确认）。enter 动作默认不带 `swap` 标记：画面立刻换成 B，enter 动作作为换上之后的「反应」（弹一下、挤压回弹、蹦一下）。反馈即时，也不会出现「旧脸先动一下」的迟疑感。`swap` 标记只用于画面本身连贯的动作（先蹲下再起跳、而 B 的图正是起跳姿势），编辑器里表现为「换图时机：立即（默认）/ 动作中途」。默认宠物包和 v0 转换脚本都按此处理。

> v0 的规则「transition 必须恰有一个 pose-swap 事件、且不得指定 pose」在这里变为「enter 动作可选地带一个 `swap` 标记」。标记只表达「时机」，不表达「换成什么」。

## 5. 片段通道上的插件直控

插件通过 `clip` 通道直接指定片段时（见 02 §4），同样可以指定 `transition` 和一个可选的 enter 动作；释放时按同一时序切回 `state` 解析出的片段。

## 6. 性能约束

- 动作在渲染循环里求值，单个 `evaluate` 应在 0.1ms 内完成。内核统计每个动作的耗时，**连续 30 帧超过 1ms** 的动作会被停用并记日志（浏览器计时精度约 0.1ms，所以硬阈值放宽）；抛异常的动作立即停用。
- 舞台不可见（全屏游戏、锁屏）时暂停渲染循环，所有动作的时间冻结。
- `reducedMotion` 为真时，内置动作类型自动降低强度或静止（sine / noise 静止，keyframes / spring 降到 30%）；插件动作应自行遵守。
