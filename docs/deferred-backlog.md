# 暂缓项备忘录（deferred backlog）

> 来源：2026-08-23 独立代码审查（用户体验 + 接口可扩展性）。已修复项（UX-1..UX-4、
> 运行时小项、EXT-1 enter kind 契约、EXT-2 跨源写防护）见
> `docs/implementation-notes.md` 同日条目，此处只收录**明确暂缓、待拍板**的内容。
> 每项按「现状 → 影响 → 建议」组织；条目无优先级排序，做不做由后续迭代决定。

---

## A. 用户体验

### A1. 空状态塌缩：删掉最后一张图后编辑器只剩导入框

- 现状：`MotionPetSettings.tsx` 在 `hasAnyUsableImage === false` 时提前 return，全局设置、
  高级卡、动画库全部不可达（未保存的其它配置仍在 draft 里但无法编辑）。
- 影响：误删唯一图片后，用户无法在此状态下关闭宠物、管理动画库或改全局设置。
- 建议：空状态保留可折叠的全局/高级卡与「启用宠物」开关；需要重排 §2.1 门控的布局
  结构，建议单独一轮 + 真机目视。

### A2. 「另存为新宠物」：无法携带未保存修改建副本

- 现状：宠物操作永不隐式保存（`preparePetAction`），create/apply 一律要求 clean draft；
  想做角色变体必须先「保存修改」覆盖当前宠物（store 层已放宽 rename/delete 非 active，
  但 create 未动）。
- 影响：变体工作流有覆盖风险，无法无损试验。
- 建议：提供「另存为新宠物」入口 = 先隐式落盘克隆再回切，或 draft 快照携带克隆；
  是产品语义决策，不只是代码。

### A3. 撤销（undo / Ctrl+Z）

- 现状：关键帧/轨道/事件删除等破坏性操作无 undo；「撤回修改」只覆盖整体放弃。
- 影响：时间轴调误一键删除需手工恢复。
- 建议：`timeline-model.ts` 已是纯函数，加 history 栈成本低；涉及全套快捷键与 UI，
  建议按需排期。

### A4. 预览页（preview/index.html）增强

- 现状：无点击交互试播、无拖拽/位置夹紧验证；`successHoldMs/errorHoldMs`、
  `terminalHold`、`changePoseWithinActive/activityTransition`、coding/command 活动面
  无开关；设置页 Live Preview 的键盘互动也未接线。
- 影响：V1.1 招牌交互在无 DSH 环境下无法验证，只能真机试错。
- 建议：预览页接入 `playInteraction()` 按钮 + hold/terminalHold 控件，顺手改用
  `embedded` 模式消除对 fixed+flex 静态位置的脆弱依赖。

### A5. waiting 无限压制 error（回退聚合模式）— 需产品拍板

- 现状：sessions 桥不可用的回退模式下 `waiting` rank 高于 `error` 且无 TTL
  （`state-adapter.ts` rankOf）；一个会话停在 approval 时其它会话的报错脸永远出不来。
- 建议：给 waiting 加长 TTL（如 30s）或让 error 短暂穿透；属优先级策略取舍。

### A6. 时间轴键盘可达性

- 现状：lane 是 `div onClick`，键盘无法添加关键帧；菱形可聚焦但不能用方向键微调时间。
- 建议：lane 聚焦后 Enter 加帧、选中菱形方向键 ±snap 步进；中等工作量。

### A7. 其余小项（低）

- 错误通知固定在页面顶部，滚动后远离触发点 → toast 化或内联。
- 拖动手势中的实时 clamp 仍用未缩放方块（`setPosition` 已按 scale 收紧，手势内较宽松）。
- `config-hub` 轮询开关无引用计数，防御性问题（暂无现实触发路径）。
- 默认位置 CSS 锚定与 px 换算在经典滚动条下有约一个滚动条宽的偏差。

---

## B. 接口可扩展性

### B1. AnimationDefinition 无版本迁移 seam（做 Motion Pack 前建议先落）

- 现状：`version: 1` 是硬门，无 `upgradeAnimationDefinition()`；未知字段静默容忍并
  原样持久化。config 侧有集中 migration 入口，动画侧没有。
- 影响：未来 v2 定义 ↔ v1 运行时（或反向）在 pack 导入导出、host 加载、client 同步
  三个入口各自为政，现在只能整文件跳过。
- 建议：补一个集中升级/拒绝 seam 供三入口共用，并写下未知字段政策（建议非阻断 warning）。

### B2. HTTP API 无版本化与能力发现（开放第三方客户端前建议先落）

- 现状：全部路由挂无版本的 `/api/motion-pet/*`；旧 host 面对新客户端只能逐端点 404 试错。
- 建议：加 `GET /api/motion-pet/meta`（apiVersion / configVersion / features）；
  约定「字段只加不改、删字段升 v2 路径」。

### B3. 无乐观并发控制

- 现状：多 writer（编辑器/拖动/未来 CLI）靠字段分区约定避免冲突，PUT 无 revision/ETag。
- 影响：两个客户端编辑同一 section 时 last-writer-wins 且无冲突信号。
- 建议：config GET/PUT 带单调 revision，PUT 可选携带期望值，不匹配 409/412。

### B4. ambient channel 是分散的封闭枚举（V1.1 P2「更多 ambient channel」前建议先落）

- 现状：motion 层数据驱动没问题；封闭点在 config 侧——`AmbientConfig` 三字段定死、
  `resolveAmbientChannel` switch、`ambientField` 校验器、六个状态各一份默认值手写，
  加一个 channel（如 blink）要同步改约 8~10 个文件。
- 建议：channel 描述成单一数据表（id/definition/config 片段/resolve/defaults 派生）。

### B5. 参数化维度单参焊死 + 编译器默认上限不一致（建议尽早处理一致性部分）

- 现状：`ParameterizedValue.parameter` 字面量 'strength' 三处焊死；未声明 parameters 的
  定义编译时 strength 静默钳到 **1.8**（`timeline-compiler.ts` 默认值），而
  `TRANSITION_STRENGTH_LIMITS` 与内置 preset 已放宽到 3，`motion-format.md` 未记载该默认。
  另：`parameters` 声明未知键放行、keyframe 使用点拒绝，校验不对称。
- 建议：短期先对齐默认 max（或写入文档）；中期把 parameter 放宽为受声明集约束的字符串。

### B6. Motion Pack 命名空间与 id 重映射（P2 设计时必须回答）

- 现状：registry 本身支持任意小写命名空间，但 host store / validation / client sync
  三处硬编码 `user:`；config 与 pet preset 中的动画引用是全局绝对 id，导入撞车/重复导入
  没有「改写 id + 同步改写引用」机制，dangling 只会静默回落。
- 建议：现在不必实现，但应固化两个决定——① 可持久化命名空间白名单（非 builtin）；
  ② pack 格式把「导入 = id 重映射 + 引用改写」列为必备能力。

### B7. 新增 VisualState 的静默失败点

- 现状：`state-machine.ts` reducer 的兜底 return 使新事件类型不报编译错误而是 no-op；
  terminal 语义（success/error）与 hold 字段散落硬编码在 resolver/adapter。
- 建议：reducer 改穷尽检查（`default: never`）；导出 `TERMINAL_STATES` + hold 字段映射表。
  （加新 ActivityMode 只需 2 处，路径健康，无需动。）

### B8. config migration 链无结构

- 现状：`loadConfig` 直接是 `repairConfig`，无版本分派；v2 文件被静默重标 v1 且有测试
  锁定该行为；host 降级读新配置静默丢字段。
- 建议：改为显式 `version → migrationSteps[]` 分派（哪怕只有 no-op），降级路径至少告警。

### B9. 未知字段全量 strip 是单向兼容

- 现状：strict/repair 均 strip 未知字段（符合 §19.2）；client 比 host 新时 PUT 的新字段
  被静默丢弃。
- 建议：面向第三方客户端二选一——`extensions`/`x-*` 保留袋，或 PUT 响应带 `stripped` 列表。

### B10. 引用校验不对称 + 删除保护 TOCTOU

- 现状：`pose.assetId` 只要是 string 就入库（animationId 有存在性/kind 校验，assetId 没有）；
  跨 store 的删除引用检查在锁外快照，并发窗口可产生悬空引用（运行时有 fallback 兜底）。
- 建议：`poseField` 至少加形状校验（16 hex），可选注入 assetExists；跨 store 检查移入
  同一把锁，或文档声明 409 为尽力而为。

### B11. 低优先级清单

- 错误体双形状（409 扁平 / 其余信封）、POST 返 200 而非 201、405 无 `allow` 头 → 统一信封 + 文档标注遗留。
- SSE 无 `id:`/`retry:` 字段（快照即补偿，自洽；多 client 序号去重前预留最便宜）。
- `lastBySession` map 依赖 session/disposed 事件，无上界 → LRU 或定期清扫。
- `Symbol.for` mount flag 吞掉第二份插件副本且无日志 → key 带版本 + 跳过时 warn。
- `NormalizedAgentEvent.sessionId` 声明可选但 host 恒填充 → 协议层改必填。
- pets POST 非幂等（双击建重复）→ 可选客户端稳定 id 或 Idempotency-Key。
- `GET /pets/<id>` 单读端点缺失（`readPet` 已有但无路由）→ pack 导出会需要。
- `TransitionEngine.onEvent` 未知事件类型静默吞 → 显式默认处理器或注释声明。
- core ⇄ motion 互相 import → 抽独立动画 SDK 前解环（内置动画数据挪层或 registry 注入式）。
- `AnimationRegistry` 无变更通知 → pack 动态装载前加 `onChange`（现在加成本最低）。
- reduced-motion 下「transition 应以属性默认值收尾」的建议应写入 motion-format.md
  （自定义 transition 结尾停在非中性值会永久停留）。
- motion-format.md 内置 id 清单遗漏 `builtin:activity-swap` 与四个 `builtin:click-*`。
- 错误文案直接透传 host 英文信息（如 "invalid AnimationDefinition: …"）→ 面向用户中文化。
