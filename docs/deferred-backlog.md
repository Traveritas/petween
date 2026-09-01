# 暂缓项备忘录（deferred-backlog）

> 用途：收录**明确暂缓、待拍板、排队**的内容；已修复项记录在
> `docs/implementation-notes.md` 同日条目，不在此重复。
>
> **2026-08-27 全量梳理**：原按评审来源分的 A/B/D/E/F 五节合并为下述主题分组；
> 已随后续迭代落地的条目（isPlaying、listAnimations、快照增补、resync、
> host pack 可选隔离等）移入文末「已解决存档」；每条带状态标记——
> **【待拍板】**需要用户决策、**【近期】**建议尽快（小成本/正确性）、
> **【前置】**某大功能开工前建议先落、**【排队】**已拍板"后面再加"、
> **【按需】**无明确触发点、**【搁置】**拍板不做（带重开条件）。

---

## 0. 速览（2026-08-28）

| 优先级 | 条目 | 一句话 | 状态 |
| --- | --- | --- | --- |
| 1 | Motion Pack 导入导出本体 | 格式/路由/命名空间/迁移 seam/会话拆分地基已全部就位 | 【进行中】 |
| 2 | F2 attachStageOverlay | 贴身挂件层 | 【排队】 |
| 3 | F3 playAnimationOn | 跟班/配件复用动画引擎 | 【排队】 |

> 2026-08-27 晚收口（两批）：原【近期】两项已离场——E1 经核实已于 f84bc50
> 随 visibleSize 统一落地；F1 经核实**前提不成立**（编译层坍缩自 v1.0.0
> 覆盖全部引擎播放路径），端到端用例锁定后关闭；C4 已在 physics 418a6e0
> 落地。A2/A5/E3 三个【待拍板】项同晚拍板并落地（§9 存档）。npm publish
> 已拍板「暂不发布、GitHub link 分发」（§1）。
> **2026-08-28 Motion Pack 地基包（B2/B10/B3/B1/B6 + C1-A/工具链）落地并
> 经外部评审跟进加固**（§9 存档）；**C1-B/C 会话拆分主体同日完成**（§9
> 存档）——overlay-session 1160→624 行，扩展面独立成 ExtensionSurface，
> 双会话共享 session-core。Motion Pack 本体开工。
>
> **2026-08-30 整体评审收口**（7 子智能体分维 + 4 组并行修复，详见
> implementation-notes 同日条目）：12 项 P1 全部修复——含 HEAD typecheck
> 阻断、revision 缓存锁外回退、宠物包 kind 检查缺失与回滚扩围、kind-change
> 探测入锁、reduced-motion 坍缩乱序取值、playInteraction repeat 守卫、
> Live Preview 草稿别名致热更新失效、B6 消费端 user: 硬编码两处、
> importAnimations 孤儿与保留 id、physics 卡片兜底草稿覆写；P2 批次
> （CORS same-site 收紧、pack 导出除重、-N 堆积、回滚误删共享资产、
> subscribePose 隔离、pointer-gesture 卸载清理等）同批落地。主插件
> 51 文件 / 950 用例、physics 9 文件 / 135 用例全绿。三个新增拍板项
> 同日拍板：G1 once 末帧语义**维持现状**（§8；文档约定已写入
> motion-format.md §5）、G2 getMeta 死代码**删除**（已落地）、
> G3 physics slide interrupt**做成配置项**（已落地）；排队小项若干
> （§6 B11）。

---

## 1. 待用户拍板（决策类，非编码）

### npm publish 与对外发布【已拍板 2026-08-27 晚】

- 拍板：**暂不 npm publish**。分发方式 = GitHub 仓库公开，感兴趣的用户
  `dsh plugin add link:<本地路径>`（clone 后 link）安装体验；physics 同理。
- 因零存量用户，**旧客户端/旧 provider 兼容议题整体作废**：B2/B3 的
  「对外发布前先行」紧迫性解除（两者仍保留在 §3 Motion Pack 前置组——
  B3 的多 writer 冲突信号与 B2 的能力发现在 pack 场景仍有独立价值）；
  B9 维持「开放第三方客户端前再议」；E4 维持已关闭。
- 重开条件：出现真实的 npm 分发需求，或首批 link 用户中出现「主插件/
  附属版本组合管理麻烦」的实际反馈。

### B9. 未知字段全量 strip 是单向兼容

- 现状：strict/repair 均 strip 未知字段（符合 §19.2）；client 比 host 新时
  PUT 的新字段被静默丢弃。
- 建议：面向第三方客户端二选一——`extensions`/`x-*` 保留袋，或 PUT 响应带
  `stripped` 列表。开放第三方客户端前拍板。

（A2 / A5 / E3 三个原【待拍板】项已于 2026-08-27 晚拍板并落地，见 §9 存档。
G1 / G2 / G3 已于 2026-08-30 同日拍板：G1 维持现状关闭（§8），G2 删除落地、
G3 配置化落地（implementation-notes 同日条目）。）

---

## 2. 建议近期修（小成本、正确性/无障碍）

> 2026-08-27 晚清空：原 F1（外部播放 reduced-motion）与 E1（clamp 尺寸
> 一致性，含 A7 拖拽手势同根项）均已收口——前者前提不成立、测试锁定，
> 后者已随 f84bc50 的 visibleSize 统一落地。详见 §9 存档。当前无欠账的
> 【近期】项；新增正确性/无障碍小修按主题归入下述分组。

---

## 3. Motion Pack 后续（v1 导入导出已落地）

> **v1 已落（2026-08-28 第四批，§9 存档）**：单文件 JSON 包格式（manifest +
> 内联定义 + 可选 mounts）、`POST /packs/import`（单锁段事务：同内容幂等
> 跳过 / 异内容 `-N` 改号 + mounts 改写回报 / 包内命名空间纪律）、
> `GET /packs/export?ids=`、动画库「导入/导出动画包」入口。**待拍板**：
> mounts「一键应用到状态」的形态（导入结果已带最终 id 的 mounts，应用=
> 一次 config PUT，产品语义待用户定）；zip 容器（需要时再做，格式向前
> 兼容）；编辑器内多选导出（v1 为整库导出）。

---

## 4. 附属生态排队（已拍板「后面再加」）

### 中断池 per-caller 分池（forCaller 方案）【搁置，带重开条件】

- 拍板（2026-08-27）：**不做，保留全局 interrupt「谁都能掐断」**。理由：
  插件作者有动机保证体验；讲礼貌的协调工具已齐（isPlaying / interrupt:false
  / subscribeAnimation 结束事件）；分池防的是"不靠谱附属互相干扰"，该前提
  目前不成立，符合「主插件提供能力不做策略」。被掐断的进场动画有 settle
  兜底（落姿势 + 重启 ambient，测试锁定），最坏是观感截断不是状态故障。
- 重开条件：真实出现多附属互相干扰的用户反馈。届时按 implementation-notes
  2026-08-27 第二批末节已定稿方案实施（`forCaller` 句柄 + `Map<caller,Set>`
  分池 + 默认只掐自己 + preempt external-only），纯增量。

### F2. attachStageOverlay 挂载层 API

- 气泡/配件/HUD 贴身跟随。核心不难（PetStage stageLayer 受控插入点，挂
  userScale 层内即继承位置/缩放/全部身体变换）；成本在契约——session 重建
  重挂约定、pointer-events 禁止、z 序规则、dispose 传播。

### F3. playAnimationOn(id, layers) 外部元素动画通道

- 让跟班/配件复用动画引擎（含 reduced-motion/隐藏页冻结全套语义），化解
  「Animation Middleware 只作用于主舞台」的定位冲突。

### F4. playAnimation 返回 {ok, reason}（随 v2）

- 消 null 三义（无会话/未知 id/遇忙）；破坏性变更，攒下一次服务大版本。

---

## 5. UX 债（中期，按需排期）

### A1. 空状态塌缩：删掉最后一张图后编辑器只剩导入框

- `MotionPetSettings.tsx` 在无可用图时提前 return，全局设置/高级卡/动画库
  不可达。建议空状态保留可折叠卡片与「启用宠物」开关；需重排 §2.1 门控
  布局 + 真机目视。

### A3. 撤销（undo / Ctrl+Z）

- 关键帧/轨道/事件删除无 undo，「撤回修改」只覆盖整体放弃。timeline-model
  已是纯函数，加 history 栈成本低；涉及全套快捷键与 UI。

### A4. 预览页（preview/index.html）增强

- 无点击交互试播、无拖拽/位置夹紧验证；`successHoldMs/errorHoldMs`、
  `terminalHold`、`changePoseWithinActive/activityTransition`、coding/command
  活动面无开关。建议接 `playInteraction()` 按钮 + hold/terminalHold 控件，
  顺手改 `embedded` 模式。

### C2. 原生 prompt/confirm 依赖宿主 modals 权限【已落地 2026-08-31】

- 已落地：`src/client/dialog-queue.ts`（React-free 模态队列，promise 式
  `confirmDialog`/`promptDialog`；无宿主挂载即按取消结案、宿主卸载排空
  挂起请求——破坏性流程绝不在无人应答的确认上继续）+ `settings/modals.tsx`
  （ModalHost：Enter/Escape/autofocus/遮罩），8 处原生调用点全部替换，
  PetweenSettings 四处返回与 PetweenCard 各自挂载宿主。
- 残余：`PetweenCard.tsx` 卸载清理对脏草稿的 `window.alert`（组件拆除中
  模态无法替代；IAB 中同样静默失效）→ 待拍板：改挂载时 notice 或其他方案。

### C5. 删除「当前生效宠物」后的落点【已拍板落地 2026-08-31，方案 a】

- 拍板 (a) 禁止删除生效宠物：host `DELETE /pets/<id>` 对当前 activePetId
  返回 409 `ACTIVE_PET`；宠物卡删除按钮对生效宠物禁用并提示「生效中的
  宠物不能删除，请先切换到其他宠物」；`describeError` 补 ACTIVE_PET 文案。
- **遗留 UX 缺口（新登记，待拍板）**：宠物卡的删除按钮按构造只能作用于
  生效宠物，方案 a 下它恒禁用——**UI 里删除宠物已无入口**（host API 对
  非生效宠物仍可用）。若意图是「切走后再删」，卡片需要非生效宠物的删除
  目标（如宠物列表逐行删除按钮）。

### C3. 编辑器性能化与代码卫生小项【2026-08-27 五维评审新增】

- AnimationLibrary 每次渲染重复 evaluateDraft + 全量 JSON.stringify diff，
  且全树无 memo——动画库变大后拖滑块可能掉帧：evaluation/draftDirty 上
  useMemo、子卡片 React.memo。
- 拖动位置持久化失败只有 console.error，用户无感知丢失重启即回弹；可把
  最近保存状态放进 StageSnapshot 让有界面的附属卡片代为展示。
- ~~keyframe/event marker 的 React key 用索引+at 组合而非稳定 id~~
  【2026-08-30 核实：登记描述与代码不符】实际代码是**纯 `key={index}`**
  且为有意的正确选择（TrackLane.tsx 注释有论证：at 入 key 会因微调
  remount 导致焦点掉 `<body>`、键盘 ←→ 微调失效）。对就地 move 语义的
  TrackLane/EventTrack 而言纯索引正确，此子项撤销，勿按原文执行。
- api.ts request() 无调用方 signal 透传（在途请求不能随组件取消）。
- settings brand 色 fallback hex 有四种、NoticeBar 单槽位不支持排队提示。

### A6. 时间轴键盘可达性 → 已于 2026-08-27 下午解决（§9 存档）

### A7. 其余小项（低）

- 错误通知固定页面顶部，滚动后远离触发点 → toast 化或内联。
- 默认位置 CSS 锚定在经典滚动条下约一个滚动条宽偏差。
- （拖拽手势内 clamp 未按 scale 收紧 → 已并入 §2 E1 同修。）

---

## 6. 引擎 / 数据模型中期项

### B4. ambient channel 是分散的封闭枚举

- `AmbientConfig` 三字段定死、`resolveAmbientChannel` switch、`ambientField`
  校验器、六个状态默认值手写——加一个 channel（如 blink）要同步改 8~10 个
  文件。建议 channel 描述成单一数据表。V1.1 P2「更多 ambient channel」前落。

### B5（完整）. 参数化维度单参焊死

- `ParameterizedValue.parameter` 字面量 'strength' 三处焊死；`parameters`
  声明未知键放行、keyframe 使用点拒绝，校验不对称。中期把 parameter 放宽
  为受声明集约束的字符串。

### B7. 新增 VisualState 的静默失败点

- `state-machine.ts` reducer 兜底 return 使新事件类型 no-op 而非编译错误；
  terminal 语义与 hold 字段散落硬编码。建议 reducer 改穷尽检查
  （`default: never`）+ 导出 `TERMINAL_STATES` 与 hold 字段映射表。
  （加新 ActivityMode 只需 2 处，路径健康。）

### B8. config migration 链无结构

- `loadConfig` 直接是 `repairConfig`，无版本分派；v2 文件被静默重标 v1；
  host 降级读新配置静默丢字段。建议显式 `version → migrationSteps[]` 分派，
  降级路径至少告警。

### B11. 低优先级清单

- 错误体双形状（409 扁平 / 其余信封）、POST 返 200 而非 201、405 无
  `allow` 头 → 统一信封 + 文档标注遗留。
- SSE 无 `id:`/`retry:` 字段（快照即补偿，自洽；多 client 序号去重前预留）。
- `lastBySession` map 无上界 → LRU 或定期清扫。
- `Symbol.for` mount flag 吞第二份插件副本且无日志 → key 带版本 + 跳过时 warn。
- `NormalizedAgentEvent.sessionId` 声明可选但 host 恒填充 → 协议层改必填。
- pets POST 非幂等（双击建重复）→ 可选客户端稳定 id 或 Idempotency-Key。
- `TransitionEngine.onEvent` 未知事件类型静默吞 → 显式默认处理器或注释声明。
- core ⇄ motion 互相 import → 抽独立动画 SDK 前解环。
- `AnimationRegistry` 无变更通知 → pack 动态装载前加 `onChange`（现在加
  成本最低）。
- reduced-motion 下「transition 应以属性默认值收尾」写入 motion-format.md。
- （内置 id 清单补 `builtin:activity-swap` 与四个 `builtin:click-*` → 已于
  2026-08-27 下午解决，§9 存档。）
- 错误文案直接透传 host 英文信息 → 面向用户中文化。
- 资产总量记账依赖 assets.json：清单损坏后计数清零、旧文件成孤儿游离在
  60MB 红线之外 → 启动/定期扫描孤儿文件计入或 GC【2026-08-27 五维评审新增】。
- 目录迁移 copy 分支的并发盲区：~~B 进程停滞期间 A 完成迁移后，B 的
  rmSync 可能误删 A 的成果~~【2026-08-30 核实：登记描述为旧代码】
  migrate.ts 已加双重 existsSync 复查，残余窗口收窄为微秒级 TOCTOU，
  以及「copy 失败 + 清理失败 → 半成品 target 被后续启动当作完整数据、
  legacy 永远不再重试」——真正解法不变：copy 先落唯一临时目录再 rename
  【2026-08-27 五维评审新增，2026-08-30 描述同步；physics 仓同款冗余
  检查已删并指向本条】。
- ~~`routes.ts`（1030+ 行）把配置领域逻辑留在 HTTP 编排层~~【2026-08-31
  已落地】`applyPatchFor`/`expandPetSwitchPatch` 下沉 `pets.ts`（与
  `petSliceFromConfig` 同域对称）、`mountsStatesPatch` 下沉 `packs.ts`，
  纯搬家零行为变化。`editor-store.ts`（1132 行）拆分仍**保留排队**。
- ~~校验常量双源硬编码~~【2026-08-31 已落地】新增 `src/core/assets-contract.ts`
  单一事实源（MIME 数组派生类型联合、10MB/60MB/4096、accept 字符串、
  `isAssetMimeType` guard），五处硬编码全部改 import；包炸弹护栏与运动
  像素边界有意保留独立（不同旋钮）。

---

## 7. physics 仓

### E2. `config-hub.update()` 无客户端串行化（low-medium）【已落地 2026-08-31】

- 已修为最小代际守卫：`updateSeq` 自增，过期响应（含 saving/saveError）
  整体丢弃，latest-wins；load 兜底语义不动。+2 用例（乱序完成/正常顺序）。
- 残余观察（登记不追）：`load()` 落地仍可能短暂覆盖在途保存的旧视图，
  下一次保存成功即自愈。

（G3 slide interrupt 配置化已于 2026-08-30 拍板并落地为扁平字段
`slideInterrupt`（默认 true 保持现状），卡片带开关；见 implementation-notes
同日条目。）

（E1 的跨仓对齐与 C4 镜像升级已于 2026-08-27 收口，E3 同晚落地，见 §9。）

---

## 8. 已拍板关闭

- **D1** commit 往返期间租约未还、快速再掷被吞——用户拍板「不好修就没必要
  修」（往返 <100ms，只丢一次手势，无状态损坏）。若将来要修：commit 在途
  允许新租约接管待写位置（代际标记）。
- **D2** commit 与在途防抖 PUT 的 last-write-wins 交错窗口——极窄，记录在案
  即可；真要修在 persistPosition 加单调 writeSeq。
- **E4** 改名无旧服务名 alias——已决策 README 配套矩阵；对外发布且有真实
  旧版用户再议。
- **G1** once 时间线末帧语义——用户拍板「维持现状」（2026-08-30）：
  scheduler 收尾 cancel 段动画、末帧不保留；内置动画全部回归默认值故无
  感知。内容侧约定「once / interaction 定义的末帧应回归属性默认值」已
  写入 motion-format.md §5。重开条件：出现真实需要末帧滞留的自定义内容。

---

## 9. 已解决存档（从本清单移除，详见 implementation-notes 对应日期条目）

- **Motion Pack v1** 导入导出 → 2026-08-28 第四批落地。**格式**：单文件
  JSON（`{format:'motion-pack', version, name, namespace, animations[],
  mounts?}`；规格 §8.18 的 zip 为未来容器——动画包无二进制内容，JSON
  分发零新依赖、零二进制解析面；motion-format.md §11 定稿）。**校验**
  （host/packs.ts `validateMotionPack`）：B1 版本 seam 贯通（更高版本明确
  拒绝）、包内 id 必须落在本包命名空间（或 `mixed` 保留各自 ns）、包内
  无重复、≤200 条、mounts 键限六状态槽且 enter→transition/ambient→ambient
  的 kind 纪律与包内引用检查。**撞车策略**：同内容幂等跳过 / 异内容
  `-N` 改号（`AnimationsStore.importAnimations` 单锁段事务——规划见最新
  库、写入同段原子落盘，writeValidated 抽出为段内无锁写路径防自等）；
  mounts 改写到最终 id 随结果回报。**路由**：`POST /packs/import`（2MB
  上限，400 PACK_INVALID 带逐字段错误）+ `GET /packs/export?ids=`（未知
  id/空清单 400；导出不带 mounts）；meta features 增 `packs`。**client**：
  api `importMotionPack/exportMotionPack`；`EditorStore.importPack(file)`
  （file.text → host → 刷新 customs → notice 汇总：新增/相同/改号映射）与
  `exportPack()`（整库导出 + Blob 下载 + 文件名 `motion-pack-<ns>.json`）；
  动画库工具行「导入动画包」（FileImportButton 增 accept 参数复用）/
  「导出动画包」。测试 +19（packs 单元 9 / 路由 5 / store 3 / UI 2），
  全仓 863 绿；coverage 90.31% statements 持平。**留待**：mounts 一键应用
  （拍板点）、zip 容器、编辑器内多选导出。
- **C1** OverlaySession 拆分与双会话去重 → 2026-08-28 全段落定。**A 段**
  （评审前）：`session-surface.ts` 类型搬家破静态环 + `fanOutSafely` 单一
  实现 + coverage/lint 工具链（基线 90.5%/85.4%）。**B 段**：扩展面整体
  迁入 `overlay/extension-surface.ts`（五组订阅、外部播放池、外部 pose、
  flash 台账、驱动租约、点击/悬停记账、快照组装、全部探针）；OverlaySession
  以结构化 `ExtensionSurfaceHost` 注入并保留逐字委托——公共 API 与全部
  844 用例零改动全绿；构造顺序解法 = surface 先建（只做 stage 侧接线）、
  director 构造时 seam 指向 surface、`attachDirector` 二段挂接目标流。
  overlay-session 1160→624 行。**C 段**：`client/session-core.ts` 收拢双会
  话共享流（adoptConfigFields / collectBootPoses / sameRestingPose /
  effectiveReducedMotion / refreshTargetPose）+ `reconcileCustomAnimations`
  变更检测包装（顺手修掉 preview updateCustoms 残留的 B6 前 user: 过滤）。
  验证：844 全绿零改动、typecheck 干净、lint 维持基线 10 警告、coverage
  90.61% statements（不低于基线）。
- **B2** HTTP API 无能力发现 → 2026-08-28 落地 `GET /api/petween/meta`
  （apiVersion=1 / configVersion / revision / 只增不减 features 清单）+
  client `getMeta()`。旧客户端一次探测替代逐端点 404 试错。
- **B10** 引用校验不对称 + 删除保护 TOCTOU → 2026-08-28 落地：pose
  assetId 形状校验（16 hex；strict 400 / repair 降级无图走 fallback 链）；
  `GET /pets/<id>` 单读端点（pack 导出用）；asset/animation DELETE 的引用
  探测改为**异步**且在 store 串行删除段内**新鲜读取**，四 store
  （config/assets/animations/pets）共用一把 `WriteLock`（`createWriteLock`，
  host/storage.ts）——跨 store 变更不再交错，TOCTOU 关闭。注意：pet 镜像
  onSaved 刻意移到锁段外执行（锁内回调 saveSlice 会等自己死锁）；镜像
  各自带 slice 载荷排队同锁，乱序完成仍收敛（镜像本就是 best-effort）。
  **评审跟进（同日第二批）**：补并发交错回归测试（探测被测试 gate 挂起
  期间，排队的 config 写不得完成——退回私有链/探测移出锁段即红；探测内
  的锁无关 load() 同时钉住「读永不拿锁」不变量）；措辞修正：探测期间无
  并发写段（不撕裂）≠ 读到最新逻辑状态——镜像滞后可致假阳性 409（安全
  方向）；「删除后才新增引用」的悬空属 B11 邻接缺口，非本锁职责。
- **B3** 无乐观并发 → 2026-08-28 落地：单调 revision 记在旁车文件
  `config.revision.json`（config schema 保持 client 纯净），GET/PUT /config
  响应携带；PUT 可选 `x-petween-expected-revision` 头（缺省保持 last-
  writer-wins 完全兼容；过期 → 409 REVISION_MISMATCH 带 currentRevision；
  畸形头 400）；client `patchConfig(patch, {expectedRevision})` 已通管道
  （现有调用方未启用）。**评审跟进（同日第二批）**：写序定为 fail-closed
  ——先写 revision 旁车再写 config，两写间崩溃只会多出假 409（重试即愈），
  绝不让滞后计数放过过期的 expectedRevision；头解析收紧为纯数字。
- **B1** AnimationDefinition 无版本 seam → 2026-08-28 落地：
  `ANIMATION_DEFINITION_VERSION` 出口；更高版本定义**明确拒绝**（PUT 400
  「written by a newer petween」/ loadAll 跳过并同文案警告，绝不静默误读）；
  未知字段政策定稿为**原样保留、永不解释**（v1 读取器往返新包不破坏新增
  字段），写入 motion-format.md 与代码注释。
- **B6** 命名空间焊死 user: → 2026-08-28 落地：可存自定义 id 从 `user:`
  放宽到**任意非 builtin 小写命名空间**端到端（store 存取/校验挂载/client
  同步，`isCustomAnimationId()` 单一语法源；文件名 `<ns>_<name>.json` 保持
  双射）；伴生插件服务**自身**仍限定 user:/user:<pack>-（能力不做策略）。
  **评审跟进（同日第二批）**：`AnimationSummary.namespace` 从二值放宽为
  `string`（填真实 ns 段，'builtin'/'user' 历史取值不变），pack 动画不再
  伪装成 'user'——伴生作者不会依赖上二值语义。
  pack 导入的「id 重映射 + 引用改写」机制留待 Motion Pack 本体。
- **A2** 「另存为新宠物」无法携带未保存修改 → 2026-08-27 晚拍板方案 A 并
  落地：`POST /api/petween/pets` 新增 `from:'draft'`（请求携带 pet slice，
  经 `validateConfigPatch` 以默认 base 严格校验——动画引用含 kind 检查，
  未知动画 400 INVALID_CONFIG；**不 apply、不动 activePetId**，响应仅
  `{pet}`）；client 侧 `createPetFromDraft` + `EditorStore.saveDraftAsNewPet`
  （dirty 状态可用、不隐式保存、不切换、失败走 notice）+ 宠物卡新按钮
  「另存草稿为新宠物」与提示文案。host 路由 3 例 + store 2 例 + UI 1 例
  锁定。方案 B（已保存版克隆 + 草稿转正）经论证可后补，与 A 不冲突。
- **A5** waiting 无限压制 error → 拍板 (a) 落地：`recompute` 中 winner 为
  waiting 时，**TTL 内且 ts 严格更新**的 error 短暂穿透（约闪 1.8s 报错
  脸）；error 自身 TTL 过期触发的既有 recompute 自动回 waiting，自恢复、
  零新增定时器语义。严格更新守卫（`error.ts > waiting.ts`）保证「waiting
  后到立即压过 error」的既有行为与 §14.5 稳态 rank 完全不变——穿透只发
  生在「陈旧 waiting + 更新的失败」这一原死角场景。集成测试 +2、适配 1。
- **E3** physics 卡片关闭丢弃未保存修改 → 落地 unmount flush：卡片实际
  早已是「每改动 300ms 防抖自动保存」（backlog 原三候选与「DSH 对话框
  不可拦截」前提是对旧手动保存设计的记载，已失效）；真实缺口只剩防抖
  窗口内关闭丢最后一次编辑——unmount 时若 timer 挂着立即发 PUT（fire-
  and-forget，错误走 hub 既有面）。1 例锁定。
- **F1** 外部播放不受 reduced-motion 约束 → 2026-08-27 晚核实**前提不
  成立**：`TimelineEngine.createInstance` 自 v1.0.0 起把 `stage.reducedMotion`
  传入 `compileTimeline`，`playExternal → director.play → engine` 与一切播放
  共用该编译路径，§22 坍缩（轨道坍缩为终值常值帧 + 时长封顶 120ms + 事件
  按比例保留）天然覆盖外部播放；粒子另有 emit 前强制不发射。backlog 原
  「PlayOptions 一行 gate 拒播」建议**否决**——会连 pose-swap 换图语义一并
  吞掉，而坍缩编译恰好做到「动效消失、语义保留」，与 §22 规格措辞一致。
  端到端锁定用例已入 extension-service 测试（reduce 下常值帧/≤120ms/
  pose-swap 落图/settle 回正，翻转 never 后恢复全保真——flag 是播放时读）。
- **E1** `apply()` 预夹与舞台 clamp 尺寸语义不一致 → 实际已于 f84bc50
  （2026-08-27 下午五维评审批次）落地：`PetStage.visibleSize`
  （`max(size × userScale, MIN_VISIBLE_PX)`）确立为 §27 唯一 clamp 基准，
  driver.apply / DragController stageSize 回调 / resize 回写 / setPosition
  四处同源；专项用例锁定（scale=0.5 拖墙，DOM/内存/快照/持久化 −48px 四方
  一致）。原 A7「拖拽手势内 clamp 未按 scale 收紧」同项随之闭合。
- **C4** physics StageSnapshot 镜像升级 → 已于 physics 418a6e0（2026-08-27）
  落地：镜像补 viewport/dragging/reducedMotion/poseKey/bodyRect 五个可选
  字段；飞行边界优先消费 bodyRect insets（可见身体贴墙，不再用方块近似），
  `deps.getViewport` 保留为旧 provider 兜底；与 E1 的跨仓对齐完成。
- **D3** isPlaying 查询缺失 → 2026-08-27 落地 `isPlaying(): {enter, external}`。
- **E5-1** playAnimation null 三义 → 部分缓解（isPlaying/listAnimations 可判
  因），完整 `{ok, reason}` 转为 §4 F4 随 v2。
- **E5-2** host registerAnimation 无调用方隔离 → 2026-08-27 落地可选
  `{pack}` 前缀强制；client 侧 per-caller 隔离随中断池拍板搁置（§4）。
- **E5-3** 缺 listAnimations → 2026-08-27 落地（registry 侧可播真值）。
- **E5-4** 快照缺 viewport/dragging → 2026-08-27 落地（另加 poseKey /
  bodyRect / reducedMotion）。
- **E5-5** register→play 同步盲区 → 2026-08-27 落地 `resyncAnimations()`
  （中期方案）。
- **A7 拖拽手势内 clamp** → 并入 §2 E1 同修项。
- 2026-08-27 第二批评估中的其余「待拍板」（pose 通道数据模型/资产来源/
  事件流形状/挂载层）→ 全部已拍板并落地或转入 §4 排队。
- **2026-08-27 下午 · 五维评审（架构/安全/引擎/UI/测试文档）后无争议项批量落地**：
  - **B5(短期)** compiler strength 默认上限对齐 `TRANSITION_STRENGTH_LIMITS`
    （未声明参数的定义不再静默钳 1.8）。
  - **A6** 时间轴键盘可达性：菱形/事件标记 Enter 选中、←→ 按网格微调、
    Delete 删除（事件遵循 schema 删除规则）；`touch-action: none` 补齐触屏拖拽；
    编辑器提示文案更新。
  - TransitionEngine 新增 `onSwap` seam：pose-swap 落台瞬间回写 stagePoseUrl
    台账——中断自愈从「调用方必须配对 settle 的纪律」变为结构保证（director
    端到端回归用例 + 引擎单测锁定；原 settle 冗余换图断言随语义更新）。
  - 动画 schema 收紧三条：ambient 定义禁用 transition 层轨道（防同层无仲裁
    竞争）；同一 track 重复 `at` 拒绝；random-interval `minDelayMs ≥ 1`。
    compileTimeline 对运行时 repeat 覆盖补 alternate+events 守卫；编辑器切换
    类型时自动清理 transition 层轨道并播种默认循环轨道（既有事件规范化惯例的
    延伸，hint 文案同步更新）。
  - ConfigHub.startPolling/stopPolling 支持按 owner 引用计数：PetOverlay 用
    实例令牌、hub 型 EditorStore 以自身为持有者——宠物停用时设置侧仍能收到
    配置变更推送。
  - resize 后 `this.position` 回写 clamp 值：舞台快照与位置租约消费方不再读
    到越界坐标。
  - Host SSE 响应补 `res.on('error') → dropClient` 兜底（异步写错误不再可能
    变 uncaughtException）。
  - 文档修正：motion-format.md 校验汇总与 §6 的 interaction pose-swap 规则
    自相矛盾处改正并纳入本轮新规则；§8 内置 id 清单补 `builtin:activity-swap`
    与四个 `builtin:click-*`；README 测试数 748→800+、独立预览页注明 npm 包
    未收录；host/service.ts 头注释与实际双方法契约对齐；
    animation-definition.ts 错误文案示例去业务名；PetweenSettings 标注
    StrictMode 不兼容约定。
  - 工程：petween-physics 新增 CI workflow；主仓 CI 矩阵补 Node 20（对齐
    engines >=20）。两仓 vitest 811+114 全绿、typecheck 通过。
