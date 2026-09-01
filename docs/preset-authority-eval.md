# 预设权威化与宠物包附属配置评估（preset-authority-eval）

> 2026-09-01，两项已拍板启动的架构评估。本文只评估、不动工；所有现状论断均经代码核实并附 file:line。
>
> 结论速览：
> - **评估一（预设权威化）**：翻转可行，核心难点不在 host 而在 client 草稿语义与迁移。推荐目标形态 (i)「纯预设权威 + 首跑自动建默认宠物」，分四阶段落地，每阶段可独立验收、可回滚；6 个开放问题需先拍板。
> - **评估二（宠物包携带附属配置）**：推荐 **(b) 存储 + (a) 式应用编排**——petween 把 opaque `pluginConfigs` 存进宠物记录（能力），附属插件经既有 HTTP 拉取、自行重写动画 id、经自己的 API 在用户确认后应用（策略归附属）。与预设权威化互不阻塞，可先行。

---

## 评估一：预设权威化（架构翻转）

### 1. 现状架构（代码核实）

#### 1.1 数据流一图流（文字版）

**权威方是全局 config，预设是镜像。** 唯一配置文档为 `$DSH_HOME/petween/config.json`（旁车 `config.revision.json`，B3 单调修订号），预设为 `$DSH_HOME/petween/pets/<id>.json` 每宠物一文件。

写入方向（谁写 config）：

- 编辑器手动保存 → `PUT /api/petween/config`，只提交编辑器所有的六段 `{enabled, global, poses, states, advanced, interactions}`——**不含 overlay、不含 version**（`src/client/stores/editor-store.ts:1078-1085`，所有权分离注释 :1054-1058）。
- overlay 拖拽结束 → 防抖后 PUT 仅 `{overlay:{x,y}}`（`src/client/overlay-session.ts:557`）。
- 宠物身份操作 → host 内部 `updateConfig(applyPatchFor(pet))`：`POST /pets/<id>/apply`（`src/host/routes.ts:854-862`）、`POST /pets from:'current'/'blank'`（:684-696）、宠物包导入最后一步（:789-795）。
- 任意 HTTP 客户端裸 PUT，可选 `x-petween-expected-revision` 头（B3，`src/host/routes.ts:460-473`）。

镜像方向（config → preset，唯一方向）：

- `ConfigStore.update()` 在共享写锁段内完成「严格校验 → revision 先移 → 原子写盘」（`src/host/config.ts:123-139`）；**锁段释放后**才跑 `onSaved` 镜像（:140-149——镜像回调 PetsStore 时在同一把锁上排队，段内调用会自等死锁，教训记录于 `docs/implementation-notes.md:744`）。
- 镜像接线：`activePetId !== null` 时把 `petSliceFromConfig(config)` 写回活跃预设（`src/index.ts:59-61`）；切片 = `{scale: global.scale, poses, states}`（`src/host/pets.ts:205-207`）。
- `saveSlice` 对内容未变的写入直接跳过——拖拽保存每次只改 overlay.x/y，不搅动预设文件、不假更新 updatedAt（`src/host/pets.ts:457-473`，动机注释 :448-456）。

反向（preset → config）只有三个入口，全部自带完整切片：`applyPatchFor` 构造 `{activePetId, poses, states, global:{scale}}`（`src/host/pets.ts:210-228`，states 缺席的动画引用编码为 null 以清空前任引用）；裸切 activePetId 的 PUT 在路由层被展开为「目标预设切片为基座、调用方字段逐项优先」的补丁（`expandPetSwitchPatch`，`src/host/pets.ts:237-251`；接线 `src/host/routes.ts:474-495`）。

读取方向：

- `GET /config` → `{config, assets, revision}`（`src/host/routes.ts:446-451`）；`GET /pets` → `{pets, activePetId, warnings}`，**activePetId 取自 config**（:639-642）。
- 编辑器 load 用 GET /pets 的指针覆盖 config 响应里的字段（`src/client/stores/editor-store.ts:281-284`）；hub 3s 轮询 + publishGeneration 守卫收敛多标签页（`src/client/config-hub.ts:47,69,131-132`）。
- overlay/扩展面只消费 config：快照的 `scale` 即 `global.scale`（`src/client/overlay/session-surface.ts:21-22`）。

#### 1.2 职责边界

| 数据 | 权威 | 说明 |
| --- | --- | --- |
| poses / states / global.scale（角色切片） | **config**（活跃时镜像进预设） | 预设只是「保存的副本」，`pets.ts:4-9` 头注释 |
| 非活跃预设 | 预设文件自身 | 镜像只写活跃预设，非活跃者本就自我权威 |
| overlay.x/y、enabled、advanced、interactions、global.transition/reducedMotion/holds | config（全局，永不入预设） | `pets.ts:6-9`、`src/core/types.ts:117-169` |
| activePetId | config | null = 当前切片是不属于任何预设的未保存编辑（`types.ts:163-168`） |
| 资产/动画库 | assets.json / animations/*.json | 删除引用探测同时查 config + **全部**预设（`routes.ts:537-543`、`animationReferencedAnywhere` :573-578） |

#### 1.3 失败语义与事故记录

- 镜像失败 warn 吞掉、绝不回滚 config——「config 权威，镜像次要」是明文契约（`src/host/config.ts:42-46`、:143-146）；预设文件消失时镜像按 NOT_FOUND warn 处理（`pets.ts:448-456`）。
- 悬空 activePetId 被刻意容忍：validation 只校验形状不查存在（`src/host/validation.ts:196,478`），裸切展开遇 NOT_FOUND 不展开照常保存（`routes.ts:481-494`）。
- 事故档案：2026-08-29 裸切 activePetId 覆写事故——公开 API 允许「不带切片的切换补丁」，旧宠活数据被镜像写进新激活预设，真实用户数据丢失（`docs/implementation-notes.md:859-866`）。防护（`expandPetSwitchPatch`）是**过渡期止血**；同条方向备注写明：用户产品意图是「宠物预设为最高层容器」，当前「配置权威 + 预设镜像」是其反面，长期方案另行立项（:866），且「③ 预设权威化（架构翻转）按拍板暂缓」（:870）。本次评估即该立项。
- 关联 UX 债：C5「删除当前生效宠物后的落点」——删除后 activePetId 置 null、配置保留已删宠物数值（`routes.ts:896-902`；`docs/deferred-backlog.md:157-162`）。

### 2. 翻转后的目标形态定义

翻转后「预设为角色切片的唯一数据源」。需要重新定义四件事：

**(1)「当前配置」是什么。**  config.json 收缩为**全局文档**：`{version, enabled, global(去掉 scale), overlay, advanced, interactions, activePetId}`；「当前配置」变成一个**物化视图** = 全局文档 + activePetId 指向的预设切片。`GET /config` 继续返回该视图（形状不变），外部消费者与扩展面零感知。

**(2) activePetId 的语义。**  从「config 里一个可悬空的可空字段」变为「全局文档里指向唯一切片来源的指针」。两个形态选项：

- **(i) 纯预设权威（推荐）**：任何编辑必属于某只宠物。首跑/迁移时无预设则自动建一只默认宠物（如「未命名宠物」，可改名），activePetId 恒非空。唯一数据源真正达成，裸切类 bug 在结构上消失。
- (ii) 预设权威 + 草稿切片：保留 activePetId=null 时的 config 内草稿区，命名即「另存」。改动最小、现状语义全保，但切片仍有**两个**家（草稿区 + 预设），「唯一数据源」打折，双写类风险缩小但不归零。

**(3) 未命名工作自动保存惯例的去留。**  今天的惯例是：activePetId=null 的编辑直接落在 config 里（每次 PUT 即自动落盘，命名是显式 fork 点——from:'current' 捕获当前切片建预设，`routes.ts:685-691`）。形态 (i) 下该惯例自然消失（草稿即默认宠物的切片，命名 = 另存/改名）；形态 (ii) 下原样保留。去留随 (1) 的拍板决定。

**(4) 跨宠物字段归属。**  维持现状划分，不进预设：overlay.x/y（窗口位置，与宠物无关）、enabled、advanced、interactions.click、global.transition/reducedMotion/successHoldMs/errorHoldMs。这正是 `pets.ts:4-9` 头注释早已声明的边界（「everything else (overlay, enabled, advanced, interactions, …) stays global and never enters a preset」），翻转不改变它。scale 留在切片内（per-pet，现状如此，`types.ts:196-199`）。

### 3. 改动面清单（S/M/L）

主仓 host：

| 模块 | 改动 | 量级 |
| --- | --- | --- |
| `src/host/config.ts` | 删除 onSaved 镜像与 `onSaved` 选项；schema 收缩为全局段；`update` 拆分为「全局段 update」与「revision 维持」；`save`/`load` 语义不变 | M |
| `src/host/pets.ts` | 预设升为权威：新增**严格**切片写入路径（现状 `saveSlice` 是 repair 式归一化 :457-473，权威写入应对齐 config PUT 的严格校验纪律）；`normalizePetSlice` 仅用于读取/导入修复；`updateMeta`/`saveSlice` 合并为正式 update | M |
| `src/host/validation.ts` | config walker 拆「全局段 walker + 切片 walker」；activePetId 语义收紧（形态 (i) 下不再可空/不可悬空？随拍板） | M |
| `src/host/routes.ts` | `PUT /config` 切片字段重定向到活跃预设（兼容 shim）或整体拆分；`GET /config` 改物化视图；`handleConfig` 裸切展开守卫（:474-495）与 `applyPatchFor`/`expandPetSwitchPatch` 随翻转退役；apply 变指针翻转；delete-active 落点随 C5 拍板；revision 响应合成语义 | **L** |
| `src/host/pet-package.ts` / `packs.ts` | 已是宠物中心视角，改动小：applyPatch 目标从「config 补丁」改「活跃预设补丁」；导入的 apply 步骤从 config 写变指针写 | S |
| `src/host/migrate.ts` + 新迁移 | v1→v2 数据迁移（见第 4 节） | M |
| `src/index.ts` | onSaved 接线删除；迁移调用 | S |
| `src/host/service.ts`（cordis） | 不动（只管动画库） | — |

主仓 client：

| 模块 | 改动 | 量级 |
| --- | --- | --- |
| `src/client/stores/editor-store.ts` | 草稿 = 活跃预设的未保存副本；saveConfig 改写预设切片 API；dirty 门 / adoptPublished / saveChain / importPetPackage 的 revert 记账（:328-345, :949-962, :756-807）全部按新所有权重写——全仓最微妙的并发代码 | **L** |
| `src/client/api.ts` | 新增预设切片 PUT；ConfigPatch 收缩（兼容期保留） | S |
| `src/client/config-hub.ts` | 若 GET /config 视图保留：仅注释级调整；否则需合成 globals+preset | S |
| `src/client/overlay-session.ts` | 拖拽仍写全局 overlay.x/y，不动 | — |
| `src/client/settings/PetweenSettings.tsx` | 宠物区语义与文案（「当前宠物」选择、未命名默认宠物显示、C5 删除落点） | S |
| `src/client/overlay/extension-surface.ts` / `session-surface.ts` | 快照字段不变，scale 来源透明切换 | — |

测试与文档：host routes/config/pets/validation/pet-package 五组测试重写、editor-store 测试重写、迁移测试新增——**L**；docs（motion-format.md §11 applyPatch 目标、deferred-backlog C5、AGENTS.md 计数）——S。

physics 仓：**零改动**（只经 cordis 服务与 HTTP 消费，不触碰 config/preset 内部）。

### 4. 迁移方案与回滚

迁移 seam 现成：`loadConfig` 是唯一迁移入口，注释已预留「future v1 → v2 migration chains in ahead of the repair pass」（`src/host/config.ts:1-8`）。

- **数据迁移（v1 → v2，boot 前一次性，沿用 `migrate.ts:12-28` 的纪律：同步、幂等、绝不删旧数据）**：
  1. 读 v1 config.json。切片字段原样**推入 activePetId 指向的预设**（严格校验后原子写）。按现行契约 config 本来就是权威、预设只是它的镜像，故对活跃预设这是**无损**操作；非活跃预设不被触碰（它们本就自我权威）。
  2. 活跃指针悬空（validation 容忍的现状）或 null：按形态拍板处理——(i) 用切片建默认宠物并指向它；(ii) 切片留在全局文档的草稿区。
  3. config.json 重写为 v2 全局文档前，先复制 `config.v1.backup.json`；迁移失败（预设写不进等）→ 保留 v1 原样、warn、继续以旧格式启动。
- **陈旧镜像自愈**：镜像失败被吞的历史意味着活跃预设可能落后于 config；迁移以 config 为准推入，顺带治愈。
- **回滚**：v1 备份 + 旧构建即可完整回退（迁移只增不删：预设文件未被删，v1 config 有备份）。迁移代码保留到翻转后至少一个版本。
- **进行中编辑**：迁移在 host boot、尚无 client 写入时执行，无并发窗口（同 `src/index.ts:43` 改名迁移的「先于一切 store」纪律）。

### 5. 风险清单（按严重度）

1. **【高】editor-store 草稿语义重写的回归面。** dirty 门、adoptPublished 的 dirty 守卫、saveChain 串行、importPetPackage 的显式 revert 记账（`editor-store.ts:328-345, 949-962, 1040-1107, 756-807`）是全仓事故密度最高的并发代码；2026-08-29 事故证明这类「指针与数据错位」bug 代价是真实用户数据。缓解：阶段 2 保持 API 形状不变让 client 无感，阶段 3 才动 store；每步红绿对照。
2. **【高】翻转窗口期的旧客户端 bundle。** 浏览器开着的旧 client.js 仍按 v1 语义 PUT 全量 config。若 host 直接拒绝未知字段，旧客户端**响亮**报 400（可接受）；若静默接受则产生双写（不可接受）。缓解：PUT /config 兼容 shim 把切片字段路由到活跃预设 + `/meta` features 标记。
3. **【中】首跑/存量 null-activePetId 用户的 UX 回退。** 形态 (i) 的自动建宠若命名/提示不当，用户会感觉「被强加了一只宠物」。缓解：迁移与首跑共用同一默认宠物，文案「未命名宠物（可改名）」。
4. **【中】revision/B3 语义拆分。** 现状 revision 覆盖整个 config 文档（`config.ts:88-104`）；拆分后 overlay 写（全局）与切片写（预设）各自动各自的计数，`GET /config` 视图的 revision 需要合成定义（如 max 或双值）。客户端 expectedRevision 语义须保持向后兼容。
5. **【中】双写过渡期的一致性。** 阶段 2 的 shim 期间「写预设」与「写全局」是两份文档，B10 单锁仍保证进程内串行，但跨文档原子性不复存在（今天 update+镜像也不是原子的，契约本就 best-effort——风险不增）。
6. **【低】宠物包导入回滚顺序。** apply 变指针翻转后，回滚需先清指针再删宠物（现状顺序 :727-750 是「删宠物 → 回滚动画/资产」，指针在 config 里无需清）。
7. **【低】扩展面透明性。** StageSnapshot.scale 来源切换对附属无感（视图保留前提下无风险），physics 无改动。

### 6. 分阶段落地建议

每阶段独立验收；数据格式在阶段 4 前保持 v1/v2 双可读，回滚 = 代码回退（+ 备份）。

- **阶段 0（拍板）**：第 7 节 6 个开放问题全部拍板；规格先行写入 motion-format.md / development-spec 相关节。
- **阶段 1（host 只读面，S）【已落地 2026-08-31】**：`GET /config` 改物化视图（全局文档 + 活跃预设切片拼装），**写路径一律不动**。验收：新测试锁「对任意状态，视图 ≡ 旧 config」；950 用例基线零改动全绿。
- **阶段 2（host 写路径重定向，L）【已落地 2026-08-31】**：PUT /config 切片字段 shim 路由到活跃预设；onSaved 镜像删除；apply/裸切/包导入改指针翻转；revision 合成。验收：client 测试零改动通过 + host 测试重写组全绿 + 真机走查（含裸切往返回归——2026-08-29 事故场景）。
- **阶段 3（client 语义收敛，M）【已落地 2026-08-31】**：editor-store 草稿模型对齐新所有权；C5 落点；UI 文案。
- **阶段 4（清理，S）**：`applyPatchFor`/`expandPetSwitchPatch`/兼容 shim 退役；文档与 AGENTS.md 同步。

### 7. 开放问题（待拍板）【2026-08-31 已拍板：用户授权主代理代定，结合 pet-lifecycle-ux-design.md 综合】

1. 目标形态：(i) 纯预设权威（推荐）vs (ii) 预设 + 草稿切片。**→ 定 (i) 纯预设权威**：「数据只有一个家」是消除现状认知负担与镜像类 bug 的根；UX 文档的心智模型（§1）与此同向。
2. 未命名工作区惯例：自动建默认宠物（推荐，随 (i)）vs 保留 null 草稿区（随 (ii)）。**→ 定自动建默认宠物**：首跑/迁移时无预设即建「未命名宠物（可改名）」，activePetId 恒非空。
3. `GET /config` 物化视图是否作为**长期**兼容层保留。**→ 定长期保留**：视图只是一次 join，成本极低；config-hub/overlay/第三方客户端零改动，符合 additive 纪律。
4. 全局字段清单确认：overlay/enabled/advanced/interactions/global.transition 等维持全局（推荐维持现状边界）。**→ 定维持现状边界**（即 `pets.ts:4-9` 早已声明的划分），scale 留在切片内。
5. revision 合成语义：max 合成 vs 双值 `{globalsRevision, petRevision}`。**→ 定 max 合成**：`x-petween-expected-revision` 契约保持单值不变；任一侧变更都 bump 同一单调值。代价是全局写与切片写不能分别检冲突（会偶发假 409，重读重试即自愈，与今日语义一致）。
6. C5（删除当前生效宠物的落点）是否随本工程一并拍板落地（指向剩余最近预设 vs 回默认宠物）。**→ 定随工程落地，采 UX 文档方案 C**：删除生效宠物 → 回落到最近 updatedAt 的剩余宠物；无剩余 → 自动建默认宠物（与第 2 条同一机制）。届时解除 409 禁令；翻转落地前维持 409 + 非生效入口（UX 方案 A）。

---

## 评估二：宠物包携带附属插件配置

**用户问题**：分享宠物包（§12 zip）时能否同时携带 petween-physics 这类附属插件的配置（重力/反弹参数），让接收方获得完整的「宠物性格」？

### 1. 现状核实

- **包格式**：manifest.json 固定字段 `format/version/name/pet/assets/motionPack/attribution`（`src/host/pet-package.ts:77-86`；`docs/motion-format.md:341-383`）。顶层**未知字段不被拒绝**——校验只读取已知键（`pet-package.ts:282-334`），故新增字段对旧导入端是「静默忽略」级的单向兼容；`version > 1` 才走明确拒绝 seam（:286-295）。zip 条目白名单仅 `manifest.json` + `assets/<16hex>.<ext>`，杂项条目是**硬违规**（:47-48, :124, :142-145, :172-181）——附属数据只能进 manifest，不能加文件。
- **附属配置的存储与边界**：physics 配置在 `$DSH_HOME/petween-physics/config.json`（`petween-physics/src/host/config.ts:29-31`），唯一 API 是 GET/PUT `/api/petween-physics/config`（`src/host/routes.ts:21`），严格校验、未知字段 400（`src/host/config.ts:185,195-197`）、body 上限 16KiB（`src/host/routes.ts:23`）、写路径有跨源围栏（:110-126）。petween host 没有任何读写该目录的机制——各插件独占自己的 `$DSH_HOME/<name>/`（两仓各自 migrate 自己的根：主仓 `src/index.ts:43`，physics `src/index.ts:47`）。
- **cordis 服务表面**：host 侧 `petween` 只有 `registerAnimation/hasAnimation`（`src/host/service.ts:30-51`）；client 侧 `petween/client` 是舞台/动画/pose 面，**没有任何配置通道**（`src/client/extension-service.ts:58-148`）。physics 消费方：`inject ['petween','webServer']`（physics `src/index.ts:28`）+ `inject ['petween/client','slots']`（physics `src/client/index.ts:22`）。反向通道（petween → 附属）不存在，且编辑器 store 是纯 TS、无 cordis（`editor-store.ts:1-16`）——**「编辑器 import 后直接调用附属」在当前结构下没有通路，应用编排只能是附属侧拉取（pull）**。
- **physics 配置的「性格」含量**：`physics`（重力/反弹/摩擦/甩出…）、`bounceAnimation`、`flashPose`、`slideAnimationId`、`slideInterrupt` 等（physics `src/client/config.ts:75-99`）。其中 `slideAnimationId`/`bounceAnimation.id` 引用**主插件动画库 id**——宠物包导入的改号只重写 pet.states 里的引用（`rewritePetSliceAnimations`，`pet-package.ts:542-568`），即使人肉抄配置过去，动画 id 也会对不上。

### 2. 方案枚举与对比

| | (a) 包内 opaque `pluginConfigs`，client 侧附属拉取自行应用 | (b) petween host 暂存为宠物数据扩展字段，附属经服务/HTTP 读取应用 | (c) 不做（包只含主插件数据） |
| --- | --- | --- | --- |
| 数据流 | manifest 携带 blob → 导入响应带回 → 附属拉取 → 自己的 PUT 应用 | manifest ↔ 宠物记录 `pluginConfigs` 字段双向；附属随时可读活跃宠物的 blob | 现状不变 |
| 跨插件边界 | 遵守：petween 永不写 `$DSH_HOME/petween-physics/` | 遵守：blob 落在 petween 自己的 pets/ 目录，petween 永不解释内容 | — |
| 附属缺席时 | **blob 丢失**（需重新导入 zip；重导入会产生重复宠物） | blob 留在宠物记录上，后装附属可随时拉取 | — |
| 动画 id 改号 | 导入响应已带 `entries` 改号表（`routes.ts:796-800`），附属自行重写 | 改号表需随 blob 持久化到宠物记录，供延迟应用时重写 | **硬伤**：即便人肉抄配置，`slideAnimationId` 等 id 引用必然悬空 |
| 用户确认点 | 导入后附属 UI 弹确认（各自实现） | 同左，触发时机更多（导入后/启动时/切换宠物时） | — |
| 版本兼容 | 旧 petween 静默忽略新字段（单向兼容）；附属自己校验 blob | 同左 + 宠物记录字段只增不减 | — |
| 改动面 | 主仓 S + 附属 M | 主仓 M + 附属 M | 0 |
| 与「能力不做策略」 | 符合 | 符合（petween 只搬运+存盘，不解释、不应用） | — |

补充 (a) 的结构性弱点：导入响应一次性携带意味着「应用窗口」只有导入当下；而纯响应分发没有反向通道（§1 现状最后一条），落地 (a) 也得先建「附属向 petween/client 拉取待应用 blob」的 additive 表面——拉取模型一旦存在，(a) 与 (b) 的差距只剩「是否持久化到宠物记录」。

### 3. 推荐方案与理由

**推荐 (b) 存储 + (a) 式应用编排，记为方案 B。**

- **存储 (b)**：`PetPreset` 增加 opaque `pluginConfigs` 字段（见第 4 节），宠物包导出带入、导入存到新建宠物记录上。存储是**能力**：解决附属缺席时的留存、未来「随宠物切换的性格」等演进，且落点在 petween 自己的数据目录。
- **应用 (a) 式**：应用永远是**附属插件自己的策略**——它用自己的校验、自己的 PUT 路由、自己的确认 UI，把 blob 写进自己的 config.json。petween 全程不解释 blob 内容（对齐 B1 seam「未知字段原样保留永不解释」与「主插件提供能力不做策略」）。
- 两条约束均满足：①「能力不做策略」——petween 只做搬运/存盘/命名空间纪律/大小上限；②「导入不落未经用户确认的配置到第三方插件数据目录」——host 导入流程（`routes.ts:710-801`）对附属目录**零接触**，应用在用户确认后由附属经自己的 API 完成。
- 不选纯 (a)：附属缺席即丢 blob，与「接收方获得完整性格」的目标直接冲突，且拉取通道反正要建。不选 (c)：动画 id 引用断裂是硬伤，「性格」核心诉求未满足。
- UX 范式现成：§11 挂载应用的 pendingMounts 横幅「并入草稿 / 忽略」（`motion-format.md:337-339`；`editor-store.ts:633-653`）就是「包带建议、用户确认、不落默认」的同款交互，附属确认对话框可复刻。

### 4. §12 格式增量（方案 B 下）

**manifest 增量**（`version` 保持 1——纯增量字段，旧导入端静默忽略，新版读取，与 API_FEATURES「只增不减」同规，`routes.ts:78-84`）：

```json
"pluginConfigs": {
  "petween-physics": {
    "config": { "……opaque：附属自己的完整或部分配置……" },
    "animationIdRemap": { "user:motion-run-wall-bounce": "user:motion-run-wall-bounce-2" }
  }
}
```

校验规则（host `validatePetPackage` 逐字段错误，同款风格）：

- 顶层可选对象；键 = 附属插件 cordis 名，charset `^[a-z0-9][a-z0-9-]*$`、≤64 字符（如 `petween-physics`，physics `src/index.ts:21`）；条目数 ≤ 8。
- 每条值必须含 `config`（任意 JSON 值，序列化后 ≤16KiB——对齐 physics 自身 PUT 的 16KiB 上限）；`pluginConfigs` 整体 ≤64KiB；manifest.json 单条目仍受既有 12MB/60MB 炸弹上限约束（`pet-package.ts:41-43`）。
- `animationIdRemap` 可选，导入时由 host 从本次改号表（`report.entries`）注入——host **只注入映射、不重写 blob 内容**（不知道哪些字符串是动画 id；重写是附属应用时的事）。
- petween 对 `config` 内容**零校验、零解释**；schema 归附属自己（物理参数范围只有 physics 知道）。

**主仓改动面**：`pet-package.ts`（manifest 校验 + 导出构建 + 导入计划）S；`pets.ts`（`PetPreset` 类型 + `toPreset` 携带新字段——**现状 `toPreset` 只挑已知键，未知字段会被读取时静默丢弃，:301-312，必须显式加字段**；`presetShapeProblem` 容忍）S；`routes.ts`（导入把 blob 写进 `createPet` 记录、响应/report 附带 namespaces 列表）S；`docs/motion-format.md` §12 S；测试 M。**关键安全属性**：`saveSlice` 镜像写回用 `{...preset, ...normalized}` 展开（`pets.ts:469`），`pluginConfigs` 这类切片外字段在镜像下**天然存活**——在「配置权威」与「预设权威」两种架构下都成立。

**应用编排**（附属侧拉取，无需新增 host 路由）：

1. 导入完成 → 宠物记录已带 blob；petween 编辑器 notice 追加「附带 N 个附属插件配置」摘要（不复用 confirm，宠物导入本就即导即用）。
2. 附属（如 physics）拉取触发：client 入口启动时一次 + 活跃宠物变化时。现状 StageSnapshot 无宠物标识（`session-surface.ts:17-55`），需 `petween/client` **additive** 扩一项（如 StageSnapshot 加 `activePetId`，版本仍 1）。
3. 附属经既有 `GET /api/petween/pets/<id>`（B10 单读，`routes.ts:865-870`，GET 无跨源围栏）读取自己命名空间的 blob + remap。
4. 附属自行：重写 blob 内的动画 id → 用 remap；校验自己的 schema；**弹自己的确认 UI**（「包内附带 Petween Physics 配置（重力 xxxx…），应用？」）；确认后 PUT `/api/petween-physics/config`（同源、过围栏）；按内容哈希记账防重复提示。
5. 附属缺席：blob 静卧宠物记录，未来安装后第 2 步自然触发。

**导出侧取数（子决策）**：

- E1（持续同步）：附属每次保存配置后把 blob 推给 petween（需新写入路由）。宠物记录永远新鲜，但 petween 多了一个写给附属用的端点。
- E2（导出时收集，推荐）：导出是 client 发起的——编辑器导出前经 `petween/client` 新能力（如 `collectSharedPluginConfigs()`，附属可选注册 provider）向在场的附属收集当前 blob，随导出请求交给 host 打包；附属缺席/未注册则落回宠物记录里已存的快照。无持续同步管道，无新写路由。

### 5. 与预设权威化的相互依赖

**互不阻塞，建议宠物包配置先行。**

- pluginConfigs 是**切片外**的宠物记录字段（与 name/attribution 同层）。镜像只重写切片三键（`saveSlice`，`pets.ts:457-473），切片外字段在镜像下存活；预设权威化后宠物记录更是天然的家。`toPreset` 白名单问题（`pets.ts:301-312` 需显式加字段）在两种架构下是同一处改动。
- 若评估一先行，方案 B 的存储语义更干净（宠物记录已是唯一权威）；若方案 B 先行，也无返工——该字段不依赖 config 的任何字段。
- 唯一交汇点：宠物包导入的 apply 步骤（评估一阶段 2 会改其实现），两个工程若并行推进，此函数是**冲突热点**，建议排期错开或同一批落地。

### 6. 分阶段落地路径

- **P1（主仓，格式 + 承载）【已落地 2026-08-31】**：§12 文档增量 → manifest 校验 → `PetPreset.pluginConfigs` + `toPreset` → 导入存记录/响应/report 携带 namespaces → 导出从记录携带。验收：含 blob 的 zip 导出→导入→记录逐字段一致；旧构建导入新包静默忽略（兼容用例）。
- **P2（physics 仓 + 主仓 additive  widening）【已落地 2026-08-31】**：StageSnapshot 加 `activePetId`（additive，version 1 不动）；physics client 拉取 → remap → 确认卡片 → 自有 PUT 应用；真机走查「分享含 physics 配置的女仆包 → 接收方确认 → 重力生效」。验收：physics 侧新用例 + 真机。
- **P3（可选，主仓）**：导出时收集 `collectSharedPluginConfigs()` 能力 + 编辑器导出流程接线；缺席时落回记录快照。

### 7. 开放问题（待拍板）【2026-08-31 已拍板：用户授权主代理代定，全按推荐】

1. 导出侧取数：E2 导出时收集（推荐）vs E1 持续同步。**→ 定 E2**：不做持续同步管道与新写路由；附属缺席时落回宠物记录里已存的快照。
2. 应用确认 UX 归属：附属自己的卡片（推荐）vs petween 编辑器统一横幅 + 附属注册回调。**→ 定附属自己的卡片**：策略归附属，petween 不替第三方做决定。
3. blob 是否随**宠物切换**提示应用（per-pet 性格）还是 v1 仅「导入后 + 启动时」拉取（推荐后者，随切换是策略、留给附属自行用 subscribeStage 实现）。**→ 定后者**：v1 只在导入后与启动时拉取；per-pet 性格留给附属自行演进。
4. 分享卫生约定：附属 provider 只放可公开的可调参数（physics 现状全部满足），是否写进 §12 作为约定条款（推荐写）。**→ 定写入 §12**：秘密/个人数据不得进包，作为 provider 约定条款。

（评估一的 6 个开放问题**维持冻结**，待 `docs/pet-lifecycle-ux-design.md` 产出后综合拍板。）
