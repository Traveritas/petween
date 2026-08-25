# Implementation Notes

> 本文档按里程碑持续追加，记录「规格假设 ↔ 当前 DSH 实际 API」的核实结果与差异。

## M0 — DSH API Spike（2026-08-19）

### 0. 环境基线（已实测）

| 项 | 值 |
| --- | --- |
| DSH 版本 | `@deepseek-ai/dsh@0.1.0-rc.7`（`dsh --version` 实测） |
| 安装位置 | 全局 npm：`D:\Nodejs\node_global\node_modules\@deepseek-ai\dsh` |
| 官方包源码 | `D:\Nodejs\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`（下文 `<official>`） |
| `$DSH_HOME` | 未设环境变量，走默认 `C:\Users\Traveritas\.dsh`（`dsh-home-paths`：`configured > $DSH_HOME > ~/.dsh`） |
| web profile | `%USERPROFILE%\.dsh\profiles\web\`（package.json + cordis.patch.yml + pnpm-lock.yaml） |
| 默认监听 | `127.0.0.1:3080`（`dsh-web-app/cordis.patch.yml`，`port: !!js ctx.webStartup.port ?? 3080`） |
| 参照插件 | `@linxin666/dsh-pet@0.2.0`、`dsh-better-sidebar@0.13.0`（均已在本机 web profile 实际运行，npm 包含完整 TS `src/`） |

核实方法：读官方包编译产物 + `.d.ts` 类型定义，与两个可运行社区插件的实际实现交叉验证。**未做真机 install/boot 冒烟**（见 §7 未决项）。

### 1. 插件包形态与安装（host 半加载机制）

- 插件 = npm 包。`dsh plugin --profile web add <pkg>` 本质是在 profile 目录转发 `pnpm add`，随后 `reconcilePlugins` 扫描依赖，凡 package.json 声明了 `dsh.bundle.patch` 的包自动追加进 `dsh.profile.bundles`（`dsh/lib/plugin-9h8shc4d.js:46-127`）。
- 插件包最小声明：

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime"] }
  }
}
```

- `cordis.patch.yml` 内容即一行 insert（dsh-pet / dsh-better-sidebar 完全一致）：

```yaml
- insert:
    - id: motion-pet
      name: 'dsh-motion-pet'
      # config: {}  # 可选，原样传给 apply 第二参
```

- Entry 字段（`cordis-plugin-loader/src/config/entry.ts:9-22`）：`id`（树内稳定锚）、`name`（模块 specifier）、`config?`、`group?`、`disabled?`、`inject?`。`config`/`disabled` 支持 `!!js` 表达式（作用域含 `ctx`、`dshHomePath`）。
- Patch 层叠顺序：profile 根 `cordis.yml`（空）← 各 bundle 的 `dsh.bundle.patch` ← profile `cordis.patch.yml` ← `$DSH_HOME/cordis.patch.yml` ← `--patch`。**patch 的 `config:` 是逐 key 整体替换，不是深合并** → 可变性放 `$DSH_HOME/motion-pet/config.json`，不要靠 entry config。
- profile / home 两层 patch 文件被 watch，改动热重放，不必重启；但 `dsh plugin add` 改的是 bundles 列表，需下次 boot 生效。
- 模块解析 baseUrl = profile 目录；裸包名还可经 `$DSH_HOME/profiles/node_modules` 平铺 symlink 兜底解析（官方安装闭包每包都有 symlink，已实测含 `dsh-home-paths`/`dsh-atomic-write` 等）→ **运行时 import 官方包可行， devDependencies 装类型即可**（dsh-pet 即此模式）。
- `./invariant` export：monorepo 开发期诊断机制，rc.7 发布组合无任何 patch 挂载它 → **V1 不做**。
- 社区惯例 `mountOnce`（`Symbol.for` 全局注册表防 bundle+独立安装双挂）：实现成本低，建议照做（dsh-pet `src/mount-once.ts:37-48`）。

### 2. Host 半 API（cordis v4 + webserver）

- Cordis 插件三形态（`cordis/lib/types/registry.d.ts:48`）：函数 / 构造器 / 对象 `{ apply(ctx, config) }`；静态元数据 `name` / `Config`（Standard Schema，可选）/ `inject` / `provide`。
- `inject` 声明的服务全部就位前插件纤维停在 PENDING（`cordis/lib/types/fiber.d.ts:60-74`）。
- **`apply` 的返回值即 disposer**（Effect：单个 / Promise / iterable 均可），纤维卸载时逆序执行；细粒度用 `ctx.effect(execute, label?)`。
- `ctx.on(name, listener)` 返回 disposer，随纤维自动清理。
- Service 基类：`class X extends Service`，`constructor(ctx, name)` 即注册为 `ctx.<name>`。
- **WebServer 服务**（`dsh-host-webserver/lib/types/index.d.ts`）：

```ts
type WebRouteKind = 'exact' | 'prefix'   // prefix p 匹配 p 与 p/<anything>
interface WebRoute { kind; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }
ctx.webServer.register(route): () => void        // 重复 (kind,path) 抛错
ctx.webServer.registerUpgrade(route): () => void // WebSocket 升级（状态推送备选通道）
ctx.webServer.registerFallback(handler)          // 唯一席位，已被 frontend-static 占用，不可用
ctx.webServer.tapIndex(transform)                // index.html 变换
```

  - 匹配顺序：**exact 全表 → 最长 prefix → fallback**。**没有 method 便捷方法 / 中间件 / body 解析**，全部自理（dsh-pet `src/routes.ts` 是模板：`getRoute`/`postRoute` 包装 :90-123，64KB 上限 `readJsonBody` :61-87，资产 prefix route + 白名单解析 + MIME 表 :141-278）。
  - **无 TLS / auth / origin policy**（README 明示）。`/api` prefix 被 connection gateway 占用，但 exact 优先 → `/api/motion-pet/*` 用逐条 exact 注册安全；`/motion-pet-assets/*` 用一条 prefix。
- 持久化官方包（healed fallback 可解析）：
  - `@deepseek-ai/dsh-home-paths`：`dshHomePath(...segments)`、`resolveDshHome()`。
  - `@deepseek-ai/dsh-atomic-write`：`writeFileAtomic(file, content, {mode})`（wx 临时文件 + rename；**不含 fsync**，规格要求 temp+fsync+rename → 需自补 fsync）、`withFileLock(file, op)`。
- 官方设置面板集成（`dsh-settings` + schemastery schema → `$DSH_HOME/settings.yaml` 热重载）：**V1 不接**，按规格走自有 `/api/motion-pet/config`；V1.x 如需再补 `installSettingsSection`。

### 3. Client 半 API

- **入口约定**：浏览器执行的是预构建 `lib/client.js`，模块导出整体作为 cordis object plugin 应用：

```ts
export const inject = ['slots', 'locale', 'sessions'] // 服务名（非包名），就位后才执行 apply
export function apply(ctx: Context): void | (() => void) { ... }
```

- **模块格式**（`dsh-client-modules/lib/types/client/manifest.d.ts:100-110`）：bundle 必须是

```js
window.__ModuleLoader__.load({ id: '<包名>', factory: (require) => { /* CJS 风格 body，return module.exports */ } })
```

  host 以 `/plugins/<id>/client.js?rev=<hash>` 伺服 `exports["./client"]` 指向的文件，entry graph 经 `window.__DSH_BOOT__` 注入。`require(...)` 只能命中 shell 静态模块表：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`dsh-client-ui-slots`、`dsh-client-web-react`、`dsh-client-ui-primitives`、`dsh-client-ui-attachment`、`dsh-client-schema-form`（`dsh-client-web/lib/index.js:165-176`）。**React 18.2，全插件共享 shell 实例** → peerDependencies `react ^18.2.0`，绝不打包 react。
- **`dsh.client.inject`（包名列表）在 rc.7 是信息性元数据**（preflight 展示 / HMR diffing），真正激活排序靠模块导出的服务级 `inject`（manifest.d.ts:41-56）。两者都写。
- **Slot 系统**（`dsh-client-ui-slots/lib/types/index.d.ts`）：

```ts
ctx.slots.register(options, component): () => void
// options = { name, children?, store?, locale?, registrant? } + 按 kind：
//   single → { priority? }
//   list   → { id, order?, label?, priority? }
//   keyed  → { key, priority? }
//   chain  → { select, priority? }
ctx.slots.inject(name, cb)  // 等 slot 被声明后再注册（slot 是运行时 "declaring is claiming"，必须用这个模式）
```

- **规格 §5.2 验证结果：`shell.overlay` 存在且无人占用**。`dsh-client-ui-layout/lib/types/client/index.d.ts:77`：`{ kind: 'list'; scope: 'root' }`，官方文档原文 "Frame-wide floating layer… click-through — entries opt back into pointer events… additive seat for a frame-wide surface of your own"。AppFrame 无条件渲染（`dsh-client-ui-layout/lib/client.js:234-238`，容器 `position:absolute;inset:0;z-index:20;pointer-events:none`）。**用 `ctx.slots.inject('shell.overlay', …)` + `register({ name:'shell.overlay', id, order, label }, Component)`，组件根节点自开 `pointer-events:auto`。** 不照抄 dsh-pet 的 createRoot（其注释自述是 rc.6 时代 workaround，rc.7 已过时）；走 slot 还能获得错误边界与纤维生命周期清理。
- **设置挂点：`settings.section`**（list/root）确认存在，组件收 owner props `{ close() }`；dsh-pet 设置卡片即此模式（`src/client/index.ts:119-132`）。
- Slot 组件框架注入 props：root scope 拿 `useSessions`/`useWorkspaces`；session scope 另拿 `useSession`/`sessionId`/`useProjection`（`dsh-client-runtime/.../client/index.d.ts:70-90`）。
- Client 可 inject 的官方服务：`slots`、`sessions`、`workspaces`、`locale`、`settingsScope`、`remote`、`connection`、`theme`、`layout`、`modules`。
- Store：`defineStore({ init, actions })`（`@deepseek-ai/dsh-client-runtime/client`，immer draft）→ slot 注册 `store:` 座位（按 scope 建实例）或 apply 内手动 `.create()` 单例（dsh-pet 模式，host-global 状态适用）。组件用 `useSyncExternalStore` 读。
- **CSS Modules 零配置**：官方 tsdown client 构建把 `.module.css` 编译为哈希类名映射 + 物化时注入 `<style data-plugin-css>`，HMR 卸载自动清理。写法即 `import styles from './x.module.css'`。

### 4. 状态源（agent 活动 → 宠物状态）

**规格 §13.2 假设的六个事件名全部真实存在**：`session/event` ✓、`agent/status` ✓、`assistant/chunk` ✓、`tool/call` ✓、`approval/asked` ✓、`turn/end` ✓。注意前两者是 host 侧 cordis 事件名；浏览器线帧对应名是 `host/session-status`、`approval/requested`（integration 层命名按订阅侧区分）。

- **Host 半订阅**（任意插件可用，dsh-pet 已验证）：
  - `ctx.on('session/event', (session: Session, event: SessionEvent) => …)`（`dsh-session/lib/types/index.d.ts:66`）。事件词汇表 42 型（`dsh-session/lib/types/known-event-types.js`），关键的：`turn/start`、`turn/end { reason.kind: completed|aborted|blocked|error|max-tokens|interrupted }`、`step/start|end`、`assistant/chunk { chunk: StreamChunk }`（`reasoning-delta`/`text-delta`/`tool-call-delta`/…，`dsh-llm` types）、`assistant/message`、`tool/call { name, arguments }`、`tool/result`、`approval/asked|decided`（merge，`dsh-user-approval`）、`command/run|done`（merge，`dsh-commands`）、`llm/retry`（merge）。
  - `ctx.on('agent/status', ({ agent, status: 'idle'|'running' }) => …)`（`dsh-agent/lib/types/runtime-types.d.ts:169`）；`agent/error`（:316）。
  - 事件天然带 `session.id` 归属；host 不知道「用户正在看哪个会话」。
- **Client 半**：两条下行 WebSocket（`/api/events.mux`、`/api/events.host`）**被 client runtime 独占，插件不能直接消费**。官方姿态是快照订阅：
  - `ctx.sessions.list: ObservableSnapshot<SessionListState>` — `current`（当前查看会话）、每会话 `running`、`pendingInteraction?: 'approval'|'plan-review'|'question'`。
  - 每会话 `ConversationSnapshot`（`dsh-client-runtime/.../client/sessions/conversation.d.ts:367-417`）：`running`、`partial: PartialAssistant|null`（生成中）、`runningCalls: RunningToolCall[]`（工具名）、`pending: PendingInteraction[]`（kind: approval/question）、`lastAgentError`。
- **dsh-pet 模式**：host 半 `session/event` 全量订阅 + 每会话状态机投影（`src/event-projection.ts:71-163`，纯函数：`reasoning-delta`→thinking、`text-delta`→review、`tool/call`→tool、`turn/end` 按 reason 分派），聚合成快照，client 每 2s 轮询 `GET /api/pet/state`（hidden 停轮询、latest-wins seq 防乱序）。
- **对本项目的路线选择**（规格数据流 `DSH → DshStateAdapter → NormalizedAgentEvent → …` 不变，变的只是 adapter 驻留侧）：
  - **路线 A（host adapter）**：host 订阅 `session/event`+`agent/status` → 归一化 → 经自建通道给 client。通道候选：短间隔轮询（dsh-pet 已验证，2s 对动画太慢，需 300~500ms）、`webServer.registerUpgrade` WebSocket 推送、`connection.rpc`。保真度最高（有 `reasoning-delta` 粒度）。
  - **路线 B（纯 client snapshot）**：inject `sessions`，订阅 `ConversationSnapshot`。零 host 代码、全官方、实时推送；但拿不到 reasoning/text 的 chunk 级区分，`partial` 只表示「生成中」。
  - **暂倾向 A**（规格的 `NormalizedAgentEvent` 含 `thinking`，需要 reasoning 粒度；且所有 DSH 事件知识天然收拢在 host 侧 adapter，client 只面对自有协议）。M4 开工前先查 `PartialAssistant` 是否暴露 reasoning block 信息，若暴露则 B 也值得重新评估。通道选择（poll vs WS vs RPC）M4 定。
- 工具名 → ActivityMode 归类表需 M4 实测（`tool/call.name`；`ask_user_question` 工具 = 提问 → waiting）。

### 5. 构建与工具链（社区已验证组合）

| 项 | 值（dsh-pet 实测组合） |
| --- | --- |
| 构建 | `tsc -b && tsdown`（`tsdown ^0.22.2`，rolldown 系） |
| 语言 | `typescript ^6.0.3` |
| 测试 | `vitest ^4.1.8` + `jsdom`（@testing-library/react 可选） |
| CSS | CSS Modules + `lightningcss`（tsdown 自动处理注入） |
| React | peerDep `^18.2.0`（external，共享 shell 实例） |
| 类型依赖 | devDeps 装 `@deepseek-ai/cordis ^4.0.1`、`@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-client-runtime`、`@deepseek-ai/dsh-client-ui-slots` 等同版本官方包 |

### 6. 与规格的偏差 / 修正清单

1. `shell.overlay` 确认存在（规格 §5.2 的待验证项**通过**）；rc.7 起应优先于社区 createRoot 模式。
2. `ctx.slots.register(options, Component)` 签名确认；**必须配 `ctx.slots.inject(name, cb)` 使用**（slot 运行时声明，加载顺序不保证）。
3. 事件名核对全部通过；但 browser wire 帧名不同（`approval/requested`、`host/session-status`），integration 层按订阅侧命名。
4. **client 半没有逐条事件订阅 API**（WS 被 runtime 独占）——规格 §13.2「优先检查 client runtime 事件」的结论：官方路径是 snapshot；逐条事件只能 host 半 `ctx.on('session/event')`。→ 路线选择见 §4。
5. `dsh.client.inject` 在 rc.7 是信息性元数据，服务依赖以模块导出 `inject`（服务名）为准。
6. webServer 是裸 node http：method 判断、JSON body（带大小上限）、MIME 表、防 `..` 全部自己实现（照 dsh-pet `routes.ts` 模板）。
7. `writeFileAtomic` 不含 fsync → `host/storage.ts` 在原子写外自补 fsync 以满足规格 §20。
8. `/api` prefix 被 gateway 占用 → `/api/motion-pet/*` 必须逐条 exact 注册。
9. `./invariant` export、schemastery 设置面板：V1 均不做（前者 rc.7 无人消费，后者与规格自有 config API 重复）。

### 7. 未决项（转入后续里程碑）

- [x] **tsdown client 产物格式配置**（已于 M0 补核）：官方 preset 在 monorepo `packages/client/tsdown.client.ts`（master 分支已取得），社区等价物 `zhu1090093659/dsh-web-ui` 的 `shared/tsdown.client.ts`。核心做法：client bundle 用 `format:'cjs'` + `platform:'browser'`，`outputOptions.banner/footer/intro` 包出 `__ModuleLoader__.load({id, factory})` 外壳；externals = `PLATFORM_MODULES`（react、react-dom、@deepseek-ai/cordis、dsh-client-ui-slots、dsh-client-web-react、dsh-client-ui-primitives、dsh-client-schema-form 等）+ `@deepseek-ai/dsh-client-runtime/client` 豁免项，其余一律 `noExternal` 内联；`define` 三个 NODE_ENV/env 键；CSS Modules 用 lightningcss 插件编译 + 运行时注入 `<style data-plugin-css>`。本仓库 M1 脚手架将内联一份简化版（单包，无需 monorepo 的 face/phase 机制）。M1 仍需真机构建 + 加载验证。
- [ ] `PartialAssistant` 是否暴露 reasoning block（决定路线 A/B，M4）。
- [ ] 状态推送通道：poll / WS（`registerUpgrade`）/ RPC 三选一（M4）。
- [x] 真机冒烟（2026-08-19 已完成）：`dsh plugin --profile web add link:D:/Documents/JustAnotherPetPlugin/dsh-motion-pet` 成功（reconcile 自动把 `dsh-motion-pet` 追加进 profile bundles）。`dsh web` 启动无插件错误；`GET /api/motion-pet/config` 返回 smoke JSON（host 半加载 ✓、webServer exact route ✓）；`/plugins/dsh-motion-pet/client.js?rev=…` 正确伺服 `__ModuleLoader__.load` 包装产物（client 半加载 ✓）；index.html 的 `__DSH_BOOT__` 含本插件行 ✓。shell.overlay / settings.section 两个 Surface 的注册代码已随 bundle 送达，浏览器端渲染待用户目视确认。
- [ ] 工具名 → ActivityMode 归类实测表（M4）。

## M1 — Core + Timeline Engine（2026-08-19）

### 落地内容

- 仓库脚手架：`tsc -b && tsdown` 构建（lib 宿主 ESM / lib/client.js 浏览器工厂包 / preview/preview.js 自包含 IIFE）、`vitest run` 测试、`tsconfig.json` + `tsconfig.test.json` 双工程。tsdown 0.22 已迁移到 `deps.neverBundle/alwaysBundle` 新 API（官方 preset 的 `external/noExternal` 写法在 0.22 已弃用）。
- `src/core/`：types / defaults / pose-resolver / state-machine / pet-state-resolver（§15 稳定器：60ms coalescing、同状态去重、active 内 activity 只刷 ambient、success/error transient）/ transition-presets（8 个内置 transition 全部为 AnimationDefinition 数据）/ ambient-presets（bounce/sway/breathe 模板 + config 映射）。
- `src/motion/`：motion-properties（§8.2 白名单，WAAPI 映射定案为 CSS individual transform properties：scale/translate/rotate/opacity 分层合成）/ animation-definition（手写校验器）/ animation-registry（builtin:* 保护）/ timeline-compiler（事件点预切 segments、切点 easing 感知插值、段内 offset 重归一化、reduced-motion 坍缩编译）/ timeline-scheduler（段间 `await finished` 触发事件、取消走 AbortError 路径、loop/alternate 无事件时单条 Infinity WAAPI、random-interval delay-first + 可暂停 timer）/ timeline-engine / animation-handle / transition-engine（generation 守卫：被中断不得换 pose、不得报完成）/ ambient-engine（按 channel diff 重启）/ motion-director（§24 接口 + `play(definitionId)` 零分支验收口）/ motion-stage（与 renderer 的契约）。
- `src/client/`：pet-stage.ts（PetStage：§3.4 八层 DOM、anchor 对齐数学 `computeAnchorLayout`、preload、user-scale、视口 clamp）/ PetRenderer.tsx（薄 React 封装）/ manual-state-source.ts（Preview 控制器，走真实 PetStateResolver）/ preview-session.ts（胶水层）。
- 独立 Preview：`preview/index.html`（file:// 双击可开，IIFE 自包含）。六状态按钮全链路、transition/ambient 实时调参、replay、anchor 标记、reduced-motion 开关、自定义 AnimationDefinition 贴入即 `register + play`。
- `docs/motion-format.md`：AnimationDefinition 用户格式文档。

### 验证

- `pnpm vitest run`：14 文件 / **123 用例全绿**（§29.0/§29.1 全项 + §29.3 renderer 级 + §29.4 集成流程）。
- `pnpm run typecheck` 零错误；`pnpm run build` 三产物通过；preview 产物经 jsdom + 假 WAAPI 冒烟。
- 规格 §36 硬性判据成立（测试锁定）：`registry.register(customDefinition)` → `motionDirector.play(id)` 无需任何专用分支。

### 实现期偏差记录（规格未给数值，已在代码注释标注）

1. working bounce duration 取 360ms（§11.2 未给）；success/error ambient 具体化为 breathe 0.1/3000ms 与 sway 0.6deg/5200ms + breathe 0.12/3200ms（§11.5 只有定性描述）。
2. jump 380ms（§9.5 未给）；snap 160ms（§9.6 区间内）；celebrate/deflate keyframe 表为自行设计（§9 无表）。
3. §29.1「generation cancellation」用例放在 tests/motion/motion-director.test.ts（generation 是 TransitionEngine 概念，core 无此物）。
4. events + alternate 组合按「正向重跑 pass」处理（规格只定义了无事件 alternate 与有事件 loop）。
5. 主代理抽查后加固一处：scheduler 段循环改为先查 cancel 再触发事件（原先顺序在极端时序下可能多触发一次边界事件；引擎层 generation 守卫本就兜底，此为纵深防御）。

### 转入后续里程碑的遗留

- MotionDirector 暂无 pause/resume（§23 hidden 处理用 stop+refreshAmbient 组合，ambient 相位会重置）——M3 如需保相位暂停再加 API。
- PetStage position 层 viewport-fixed 的假设，M3 接 shell.overlay 拖拽时复查。
- M0 遗留仍有效：PartialAssistant reasoning 检查、状态推送通道三选一、工具名归类表（均 M4）。

## M2 — Editor + 图片导入（2026-08-19）

### 落地内容

- **host 半**（`src/host/`）：config.ts（loadConfig 为唯一 migration 入口 + ConfigStore）、storage.ts（temp+fsync+rename 原子写，`withFileLock` 串行化）、validation.ts（repair/validate 双模式 walker，PUT 以当前 config 为 base 合并）、assets.ts（手写 PNG/WebP(VP8/VP8L/VP8X)/JPEG(SOF 扫描) 头解析；sha256 前 16 hex 为 asset id，天然去重；磁盘名 host 生成；10MB/60MB/4096² 上限；清单 assets.json 白名单解析）、routes.ts（裸 node http 上的手写 JSON/multipart 解析与错误协议）。
- **HTTP API**（真机逐项验证）：GET/PUT `/api/motion-pet/config`（exact）、POST/DELETE `/api/motion-pet/assets[/<id>]`（一条 prefix 内部分发）、GET `/motion-pet-assets/<id>`（prefix，白名单 + 正确 Content-Type + nosniff）。409 `ASSET_IN_USE`、415 非法类型、413 超限、404 未知/穿越。
- **client 半**：api.ts（类型化 fetch）、stores/editor-store.ts（纯 TS 订阅模式；updateConfig 立即改 draft + 300ms debounce PUT、在飞合并 latest-wins、saving/saved/error 状态机；换图走 §19.4 顺序：上传→persistNow→删旧，409 视为正常保留）、settings/ 六面板 + GlobalBar（三栏布局 ≤920px 转纵向，CSS Modules + prefers-color-scheme——**注：该布局后续历经两轮重构：M5 换 token 主题、2026-08-20 重排为「全局卡 + 三栏 + 高级与互动卡」并迁入独立编辑器页，见文末迭代记录**）、LivePreview 复用 PetRenderer/PreviewSession/ManualStateSource（PreviewSession 新增 updateConfig 热更新与空态补 boot）。`src/client/index.ts` 移除 M0 overlay 冒烟 div，注册真实设置页（settings.section，label 'Motion Pet'）。
- 测试：22 文件 / **200 用例**全绿（§29.2 全项经真实 http server + node fetch 覆盖）。

### 真机集成验证（dsh web 实际运行）

默认 config GET ✓ / 上传 PNG（id、宽高解析正确）✓ / 资产字节级一致 ✓ / PUT 引用资产 ✓ / 引用中删除 409 ✓ / 解除引用后删除 200 → 静态 404 ✓ / SVG 415 ✓ / 路径穿越 404 ✓ / 落盘 `$DSH_HOME/motion-pet/{config.json,assets.json,assets/}` ✓ / **重启 dsh web 后配置保留** ✓。设置页 UI 渲染待用户目视。

### 环境事故记录（与本插件无关，但值得知晓）

- M2 首次 boot 失败：社区插件 skin-center 的 `ui-skin-maid-atelier` 符号链接（→ `dsh-skins/skins/maid-atelier`）失效。根因：`dsh plugin add` 会在 profile 目录重跑 pnpm install，**不在 package.json 依赖闭包里的手动安装内容会被 prune**（该 skin 是 skin-center 按需装入 node_modules 的）。下次 boot 时 skin-center 的 legacy bridge 把托管行从 cordis.patch.yml 全部剥离（文件变为 `[]`），第三次 boot 即恢复。**教训：profile 的 node_modules 是 pnpm 全权管理的，任何插件私自往里放东西都不可靠。**
- 测试基础设施坑：Git Bash 里 `curl -F "file=@/tmp/x.png"` 的 `@/tmp` 不经 MSYS 路径转换（Windows curl 读不到），需 `$(cygpath -m …)`。

### 实现期偏差记录

1. PUT 合并语义：缺失字段以当前 config 补齐；但 pose 对象一旦出现即对该 pose 有权威性（缺席的 assetId 视为清除，否则 409 流程无法解除引用）。`poses.<key>` 整个 key 缺席仍保留 base。
2. 规格未给的内部 sanity 边界（zoom 0.2..5、period/interval 200..60000 等）为自行选择，已在 `src/host/validation.ts` 注释标注；client 滑块范围已逐字段对齐。
3. 已知小瑕疵（不阻塞 M2 验收，列入 M5 考量）：导入新图后需再点一次状态按钮才切换（fallback 解析槽位的小滞后）；transition 在飞途中改 anchor/zoom 可能瞬时回旧值；设置页对 PetStage 的 fixed 定位用了 `!important` override（M3 给 stage 加面板内嵌模式可移除）。

## M3 — Overlay（2026-08-19）

### 落地内容

- **shell.overlay 真实挂载**：`src/client/overlay/PetOverlay.tsx` 经 `ctx.slots.inject('shell.overlay', …)` 注册（id `motion-pet`）；无图 / `enabled=false` / 未加载完成一律不渲染（E2E「未导入图片时 Overlay 不占位」）。
- **拖拽**：`drag-controller.ts`（纯 TS；pointerdown/capture/move/up，<4px=click、≥4px=drag、pointercancel 兜底）；默认 `right/bottom:24px`，拖后绝对定位并 300ms debounce 持久化 `overlay.x/y`；拖动与 resize 都 clamp 进视口（≥32px 可见）。click 触发 `builtin:click-pop`（新增 kind:'interaction' 的 AnimationDefinition 数据，140ms 轻微 pop，无 pose-swap event）——经 `motionDirector.play` 零分支执行。
- **config-hub.ts**：editor 与 overlay 共享同一 config 的中枢——单次 GET 记忆化、保存成功即时 publish、3s 轮询兜底（hidden 停 / visible 即拉 / 差异才广播）；editor dirty 时忽略 poll（防回滚）。
- **overlay-session.ts**：overlay 控制器（registry/director 生命周期、config 跟随、reducedMotion 三档 + matchMedia 监听、visibilitychange 暂停恢复）。M4 将在此注入 DSH 状态源。
- **MotionDirector 追加 `pause()/resume()`**（纯追加）：委托 ambient pause/resume，保住循环 ambient 相位（M1 遗留项关闭）；已知空隙：在飞 transition（≤650ms）不暂停，完成时 ambient 重启被 paused 标记压制，不违反 §23。
- **PetStage `embedded` 模式**：设置页预览改用 absolute 居中内嵌，移除了 M2 的 `!important` CSS hack；fixed 模式行为不变（overlay 用）。
- 测试：26 文件 / **238 用例**全绿（新增 38：drag 手势、hub 发布/订阅/dirty 保护、overlay-session 渲染规则与可见性、MotionDirector pause/resume、click-pop 数据）。

### 真机验证

重启 `dsh web` 后：served `client.js` 含 shell.overlay 注册与 click-pop 数据 ✓；两张占位 pose（蓝/橙圆）经 API 上传并写入 config（idle/thinking）✓。overlay 拖拽/click-pop/设置页内嵌预览的**视觉效果待用户目视**。

### 实现期偏差记录

1. 位置持久化用全量 PUT（api.putConfig 类型为全量；host partial merge 对全量 body 语义等价），并发由 hub 广播 + dirty 保护兜底，极端 last-wins 由 poll 自愈。
2. `builtin:click-pop` 不进 `BUILTIN_TRANSITION_DEFINITIONS`（它不是转场），由 OverlaySession 构造时注册。
3. `embedded` 实现为「absolute 居中定尺寸方块」而非拉伸 position 层（保持 anchor/contain-fit 数学不变）。

### 遗留（M4/M5）

- PreviewSession 可切到 director.pause/resume（其 :197 注释已过时，行为无 bug）。
- M4 待办不变：状态源路线 A/B（PartialAssistant reasoning 检查）、推送通道三选一、工具名归类表、overlay-session 接 DshStateSource。

## M4 — DSH Agent State（2026-08-19）

### 技术路线（M0「路线 A」定案落地）

`DSH → host event-normalizer → NormalizedAgentEvent（§13.1 逐字）→ SSE 推送 → client state-adapter → PetStateResolver → MotionDirector → Renderer`。host 保持哑管道；状态机/稳定器全部复用 client 侧 core。

- **host**：`ctx.on('session/event'/'agent/status'/'agent/error')` → `src/integration/dsh/event-normalizer.ts`（纯函数）→ `src/host/state-channel.ts`：`GET /api/motion-pet/events[?session=]`（SSE：连接即发 snapshot 帧 → 事件帧 → 25s 注释心跳；close 清理）+ `GET /api/motion-pet/state[?session=]`（JSON 快照，轮询降级用）。每会话 lastNormalized 内存 map（session/disposed 清理）。
- **client**：`src/integration/dsh/state-adapter.ts`（EventSource + 帧解码 + §14.5 聚合 + 2s 降级轮询仅在 SSE 持续 error 时）、`dsh-state-source.ts`（拥有真 resolver，目标直喂 director）、`installCurrentSessionSource` 桥（`ctx.sessions.list` 的 `current` 变化 → 重连；client entry inject 加 `'sessions'`）。`overlay-session.ts` 经 `createStateSource` seam 接入（无 EventSource 环境回退 M3 静态 idle）。
- `src/integration/dsh/state-protocol.ts` 为 host/client 共用的零依赖线协议（防 client bundle 内联 host 代码）。

### 事件映射要点（全表见 src/integration/dsh/event-normalizer.ts 注释与 M4 测试）

- turn/start→turn-start；reasoning-delta→thinking；tool/call→tool-start（**edit**＝edit/write/str_replace_editor，**command**＝bash/pwsh，其余 other——按 rc.7 安装闭包逐包 grep 核实）；ask_user_question→waiting；approval/asked→waiting；approval/decided→thinking；tool/result→回 thinking；turn/end：completed→success、error/max-tokens→error、aborted/interrupted→idle、blocked→waiting；agent/status idle→idle（running 刻意不映射，turn/start 拥有 active 面）；agent/error→error。
- **刻意偏差**：text-delta 不映射 working——§13.1 无诚实载体，且 reasoning/text 混合流会在每个 coalesce 窗口翻转 activity 造成 ambient flap（§15 防的正是这种）；整个 model step 保持 thinking 面。
- §14.5 优先级聚合（WAITING>ERROR>ACTIVE>SUCCESS>IDLE，平手取 ts 新）放 client adapter；host 只做 `?session=` 过滤。

### 验证

- 测试：32 文件 / **334 用例**全绿（新增 96；含 tests/integration/dsh-flow.test.ts 端到端主线：真 normalizer→线格式→真 adapter→真 resolver→真 director，断言与 §29.4 一致——thinking↔command 零 pose 转场、waiting 往返各一次、success celebrate 一次）。
- 真机：重启 dsh web 后 SSE 端点 snapshot 帧 ✓、/state ✓、旧路由不受影响 ✓。设置页排版修复（两栏+预览全宽）已固化进 bundle 并经 headless Chrome 截图复核。
- **真实 agent 驱动的视觉验收留给用户**（跑一个任务看 IDLE→ACTIVE→SUCCESS；触发一次批准看 WAITING）。

### 坑位记录

- `@deepseek-ai/dsh-session` 根入口会把 host 侧 `sessions: SessionStore` 增强进 cordis Context，与 client runtime 的 `sessions: ISessions` 在单一 tsc 程序里冲突——type-only import 必须走 `/types` 子路径。
- host 重启丢 lastNormalized 内存快照：client 重连收空快照回 idle，下个 live 事件自愈（可接受降级）。
- 降级轮询目前不随页面 hidden 暂停（罕见路径，M5 可补）。

### M5 待办积累

Anchor 精修、PreviewSession 切 director.pause/resume、降级轮询 hidden 联动、E2E Checklist 全量手测、主题 token 对齐 DSH 皮肤系统（当前 prefers-color-scheme 近似）。

## M5 — Polish（2026-08-19）

### 代码收尾

- **主题对齐**：settings 样式全量迁移到 shell design tokens（`--dsw-alias-*`，已在 `dsh-client-ui-theme/lib/styles/design-platform.css` 核实明暗双套定义），全部带原色值兜底（独立 Preview 无 shell 环境不退化）；删除 `prefers-color-scheme` 近似方案。notice 底色用 `color-mix` 双声明（不支持的引擎落兜底实色）。
- **§23 审计**：零 rAF、零每帧 layout 读写、零每帧 src；sway/breathe 单条 Infinity WAAPI；bounce 低频 timer + 一次性 WAAPI；dispose 链路全闭环（含 SSE heartbeat）。修补两处：state-adapter 降级轮询 hidden 暂停（M4 遗留）、PreviewSession.setHidden 切 director.pause/resume 保相位（M3 遗留）。
- **编辑器瑕疵修复**：fallback 重解析滞后（director 追加 `currentTarget` 只读 getter，按请求槽位而非 stage 解析槽位重解析；overlay-session 同步镜像）、transition 在飞改 anchor/zoom 被旧姿势覆盖（M5 用 ManualStateSource onTransition 回调实现，**Release Hardening 已重构为 director 级 `whenSettled()` 统一机制**，见下节）。
- **Anchor**：computeAnchorLayout 数学复核无误，补 2:1 非方形 + 自定义 anchor + zoom≠1 组合测试（world anchor 位移为零）。
- 测试：32 文件 / **343 用例**全绿。

### E2E Checklist（§30 全 22 项，2026-08-19 执行）

执行方式：headless Chrome + CDP（自研零依赖驱动：Runtime.evaluate / Input.dispatchMouseEvent / Emulation.setEmulatedMedia / Page.captureScreenshot），共享真机 `dsh web` 实例。

| 项 | 结果与证据 |
| --- | --- |
| plugin add / 启动无错 / Settings 出现 Motion Pet | ✓（M0 起多次；boot log 干净） |
| 未导入图片 Overlay 不占位 | ✓ 单测锁定（live 空配置会干扰用户，跳过） |
| 导入 Idle/Thinking 后 Overlay 出现 | ✓ 真机（用户实际导入全套 6 张） |
| 手动 Idle→Thinking Comic Pop | ✓ CDP：img 切 thinking 资产，transition 分段执行后清理干净 |
| Anchor 不跳 | ✓ 单测（含非方形组合，位移为零） |
| Thinking Bounce+Sway | ✓ CDP 实测：sway Infinity 2700ms running；bounce 360ms 单次 random-interval 触发 |
| Working 不高频弹 / Waiting / Success / Error | ✓ 用户目视验收（2026-08-19）+ e2e 测试锁定 |
| 快速连续状态不卡 squash | ✓ CDP 六连击：0 running 动画、scale/translate 归 identity |
| 拖动 + 位置持久化 | ✓ 用户实操（config 落盘 1751,857） |
| Resize clamp | ✓ CDP 1200×800 → pet clamp 至恰好 32px 可见（§27 下限语义确认） |
| Scale | ✓ scale=2 作用于 user-scale 层 |
| 刷新/重启配置保留 | ✓ reload 后位置+scale 一致；重启保留（M2 API 级） |
| prefers-reduced-motion | ✓ CDP 模拟：ambient 全停/恢复；reduce 下 transition 48+72ms（0.4/0.6 × 120ms 分段精确） |
| 深浅主题 Editor 可读 | ✓ 截图（暗色皮肤 + 浅色主题均正常，token 自动跟随） |
| 卸载后 DSH 正常 | ✓ remove → boot 干净、路由 404、manifest 无引用；重装恢复 |

**CDP 测试设施坑**：`Emulation.setEmulatedMedia` 等 override 在最后一个设置它的 CDP 会话断开时被 Chrome 自动清除——模拟与探针必须在同一会话内完成（Chrome 151）。

### 结论

M0~M5 全部完成。V1 的 DoD（§32）逐条均已满足或有测试锁定。剩余：M6（打包发布：README、npm 包、CI、干净环境验收）。

## V1 Release Hardening（2026-08-19，外部代码审查驱动的发布前收口）

外部审查（桌面端 GPT，Linux 静态审查 ZIP 导出）提出 7 项 + 3 顺手修，经主代理逐条对照源码核实**全部属实**，已分两批修复。测试：33 文件 / **373 用例**全绿。

### 竞态修复（第一批）

1. **Overlay 中途改 Pose/Anchor 被旧 transition 覆盖**：统一为 director 级 tracking——`MotionDirector` 内部跟踪 transition promise，新增 `transitionInFlight` / `whenSettled()`（中断也正确 settle）；OverlaySession 与 PreviewSession 共用同一机制，M5 的 `ManualStateSource.onTransition` 回调机制已移除（消除两套 tracking 漂移）。竞态复现测试已实证「还原旧行为则失败」。
2. **配置写 lost update**：host `ConfigStore.update(patch)` 以 promise 链串行化「读→validateConfigPatch 合并→原子写」；routes PUT 改调它；client 新增 `api.patchConfig(partial)`；overlay 拖拽持久化只提交 `{overlay:{x,y}}`。并发 PUT 测试锁定。跨进程 CAS/revision 留作后续项。
3. **aggregate 陈旧终态压住其他 session**（违反 §14.5 TTL 明文）：adapter 的 per-session 条目带 `receivedAt`，success/error 按 TTL（默认 1600/1800ms，从 config.global 的 holdMs 接线）过期后视为缺席。reviewer 场景复现测试锁定。
4. **setSession 迟到快照**：`connectionGeneration` 守卫，SSE 回调与 poll 回调发起时捕获、应用前检查。
5. **ConfigHub poll 无 generation**：publish 递增 generation，poll 落地前检查。
6. **mount-once flag 前置**：flag 移到 `ctx.effect` 内注册成功之后置位，中途抛错回滚路由并清 flag（已核实 cordis effect 同步执行语义，防双挂不变）。host 入口测试 3 例。
7. **preload 失败仍标记**：仅成功路径标记 preloaded，失败 URL 会重试。

### 格式与打包收口（第二批）

8. **AnimationDefinition v1 校验收紧**（`validateAnimationDefinition` 四条新规则）：禁止同 property 重复 track；`transition` 恰好 1 个 pose-swap、`ambient`/`interaction` 禁止 events；eventful `alternate` 拒绝（runtime 本就跑成正向 loop，格式不承诺做不到的事）；**同层 track 每区间 easing 必须一致**（compiler 合并同层 track 为单条 WAAPI keyframe 只能取一个 easing；复用 compiler 提取出的 `easingAt`/`unionTrackTimes`/`resolveEasingCss` 精确判定，alias 与 cubic-bezier 等价归一）。**全部 12 个内置 definition 零修改通过**（数据本就一致），compiled 输出不变由既有测试锁定；仅文档示例 user:slam-land 的 JSON 做了等价规整。`docs/motion-format.md` 已写入全部 v1 限制（含 V1.1 可能放宽的说明）。
9. **打包卫生**：tsconfig 开 `emitDeclarationOnly`、去 `declarationMap`、tsbuildinfo 钉在白名单外；`files` 收紧为五项白名单。`npm pack --dry-run`：**153 文件 / 1.0MB → 54 文件 / 608.8KB**。`private:true`/README/LICENSE 留待 M6 用户拍板。
10. `attachStateChannel` 部分失败回滚（逐条收集 disposer，失败逆序撤销后 rethrow）。

### 审查局限性说明（reviewer 自述 + 主代理核实）

reviewer 环境（Linux 解压 ZIP，pnpm symlink 被展平）无法独立跑 Vitest，其结论均基于静态审查；主代理在本机逐条源码核实并修复后全量测试通过。「多事件排序路径在 V1 格式下不可达（机制保留供 V1.1）」「同 track 内重复 at 未纳入规则」两点为已知且接受的边界。

### Hardening Follow-up（2026-08-19，外部审查第二轮复核）

第二轮复核确认上一轮 7+3 项真实落地，新发现 1 个 P1 + 2 个 P2，再次逐条源码核实属实并修复。测试：33 文件 / **382 用例**全绿。

1. **P1：配置 lost-update 只修了一半**。host 串行化只能防 partial patch 的 read-modify-write 交错，挡不住「editor dirty 期间拖拽 → editor 后到全量 PUT 带陈旧 overlay」的语义覆盖。修法（所有权分离）：editor 保存只提交 `{enabled, global, poses, states}`（不发 overlay/version），overlay 只提交 `{overlay:{x,y}}`；`savedConfig` 与 hub 广播一律用 host 返回的权威合并结果。回归测试覆盖「draft 带旧 overlay 的 editor 保存 vs overlay patch」两种顺序。
2. **P2：aggregate 终态 TTL 无主动到期结算**（此前实现有意未加定时器，reviewer 指出正确行为应是「恢复到仍 ACTIVE 的会话」而非直接回 idle）。修法：每次 recompute 扫描未过期终态条目、按最早到期点安 one-shot timer 主动 recompute；setSession/dispose 清理。fake-timers 测试锁定「到期无新事件自动浮现次优者」。
3. **P2：holdMs 热更新不同步进 adapter**（构造期 readonly 一次性传入）。修法：`StateAdapter.setTerminalTtls()`（变化即 recompute）+ DshStateSource passthrough + OverlaySession.updateConfig 在 holdMs 变化时同步（可选调用，不破坏既有 fake）。

语义变化导致的既有测试改写：editor-store 13 例的 PUT body 断言改 patch 形状；state-adapter 3 个 TTL 用例的终态序列插入到期结算的 idle。均逐条核实符合新语义。

审查方最终结论（第二轮复核后）：核心 Runtime/Format 合同可以冻结，剩余为 M6 发布工作（README、LICENSE、CI、npm package、干净环境验收）——发布决策项待用户拍板。

## M6 — Packaging / Release 准备（2026-08-19）

发布决策项（npm 账号、公开 registry、GitHub 仓库）待用户拍板；其余已全部备好。

### 落地内容

- `README.md`（中文，规格 §35 全项）：项目截图（`docs/images/` 三张真机截图：overlay、宠物特写、设置编辑器）、安装/升级/卸载、导入图片、调动画、状态说明表、兼容版本、开发/测试命令、Known limitations。
- `LICENSE`：MIT（跟随 DSH 生态主流；发布前可换）。
- `package.json`：version `1.0.0`、摘除 `private`、补 `license`/`keywords`/`packageManager`（pnpm@10.34.5，供 corepack 与 CI）。`repository` 字段留待 GitHub 仓库建立后补。
- CI：`.github/workflows/ci.yml`（node 22/24 矩阵：frozen-lockfile install → typecheck → vitest → build → pack dry-run）。

### 干净环境验收（tarball 安装）

`npm pack`（54 文件白名单产物）→ `dsh plugin remove` → `dsh plugin add <tarball>` → 重启 `dsh web`：boot 无插件错误、config 路由 200、state 通道正常、client bundle 经 `/plugins/dsh-motion-pet/client.js` 伺服、boot manifest 含本插件 ✓。验收后已恢复 `link:` 开发安装。

**坑位记录**：`remove` 一个 `link:` 安装的插件后，profile `node_modules/<pkg>` 的符号链接会残留，导致随后 tarball 安装报 `ERR_PNPM_EPERM`（pnpm 顺着残留链接解析到了开发仓库的 .pnpm）。修法：手动删除残留符号链接后重试。正式发布流程（用户从 registry 安装）不受此影响。

### 剩余（发布动作本身）

- `npm publish`（需要用户 npm 账号与可见性决策）；
- 建 GitHub 仓库后补 `repository` 字段并推送触发 CI；
- 可选：英文 README、GIF 动图。

## 用户反馈迭代（2026-08-19，M6 后）

### 1. 活跃状态内换图开关（用户报告「思考/工作图片不切换」）

根因：规格 §15.2 的刻意默认（active 内只换 ambient 防 flap），`changePoseWithinActive` 未进配置模型。本次落地：
- `MotionPetConfig.advanced.changePoseWithinActive`（默认 false，version 仍为 1，repair 自动补字段）。
- **director 新增静默换图路径**：同 visualState + 不同 poseKey → 不播 enter transition，`transitions.cancel()` 推进 generation（在飞旧 transition 的 pose-swap 守卫失效）、直接 swapPose（同 url 跳过）+ 按新 activity 刷 ambient；不产生 transition instance，不影响 whenSettled/transitionInFlight 语义。
- resolver 改为实时读共享 config 对象的字段（免 setter/重建）；editor owned patch 字段集含 advanced；设置 UI 全局区有开关（带「静默换图不播转场」提示）。
- 测试 392→404 过程中 +10（resolver 热更新、director 三分支、validation、集成 thinking↔command 静默 swap）。
- **已应用户预期在其 live config 开启该开关**（reasoning↔tool 现在会静默换图）。

### 2. 独立全页配置编辑器（用户反馈设置弹窗太挤）

- 官方 preset 的 mobileBundle 模式落地：host prefix 路由 `/motion-pet-editor/` 伺服自包含 IIFE 编辑器页（`lib/editor.js`，React 内联、零 shell 依赖，经 /api 同源通讯）——复用既有 `MotionPetSettings`（解耦为可选 `wide` prop），宽屏恢复规格 §17 三栏布局，暗色经 token 变量名覆盖（prefers-color-scheme 兜底）。
- 设置弹窗改为精简入口卡（状态摘要 + 启用 + 缩放 +「打开完整编辑器」链接）；overlay 宠物双击打开编辑器页（会先触发两次 click-pop，可接受）。
- 编辑器页的 hub.publish 不影响主 UI overlay（跨页面），overlay 经 3s 轮询跟进——README 已知限制已载。
- 测试 +12（host 路由、卡片、编辑器入口冒烟、双击）。构建四产物；pack 61 文件（含 editor.js+map）。
- 真机 CDP 验收：页面/JS/404/405 正确；三栏布局与暗色截图复核；弹窗卡片正常。

当前测试总数：36 文件 / **404 用例**全绿。

### 后续记录（2026-08-19 晚）

- **overlay 双击打开编辑器的入口已移除**（源码 + 测试 + README）：用户计划把点击/手势反馈做成可自定义（V1.1 方案的 `interactions` 配置），双击语义不再占用。打开编辑器：设置弹窗入口卡 / 直接访问 `/motion-pet-editor/`。
- **V1.1 时间轴编辑器初步方案**已落盘：`docs/v1.1-timeline-editor-plan.md`（地基盘点、持久化与 animationId 挂载设计、编辑器 UX、P0/P1/P2 分期、测试策略）。当前测试 403 全绿。

## 终态覆盖修复 + terminalHold 选项（2026-08-20）

背景：用户报告从未见过 success/error 状态；另一审查线程曾声称修复但**未落盘到本仓库**（经全仓内容级核对：其仅触发过文件 mtime 与一次重建，无任何内容变更）。本仓库独立调查并修复。

### Bug 根因（真实时序回归锁已建立）

`turn/end` 完成后 agent 立即发 `agent/status: idle` → 归一化为 idle 事件 → resolver 的 60ms coalescing 窗口内「最新 wins」使 idle 覆盖 pending 的 turn-end(success)（success 甚至来不及 commit）；即便 commit 了，紧随的 idle commit 也会清掉 hold。终态实际只存活几十毫秒。既有测试未抓到是因为 fixture 在 turn/end 与 idle 之间拉开了时间。

### 修复与新增

- **stray-idle 压制**（`pet-state-resolver.handleEvent`）：idle 事件在 (a) coalesce pending 为 turn-end(success/error) 或 (b) 当前持有 success/error 时直接丢弃；终态退场只能由 hold 定时器 / 新 activity / dismiss 产生。
- **新语义事件 `{type:'dismiss'}`**：仅 terminal 时回 idle，否则 no-op。
- **新配置 `advanced.terminalHold: 'timed' | 'until-interaction'`**（默认 timed 保持现状）：until-interaction 下 success/error 不启动 hold 定时器，持续到点击宠物（dismiss）或新 turn 才解除。实时读共享 config，热更新生效于下一次 terminal commit。
- 接线：DshStateSource.dismissTerminal() → resolver；overlay 点击 = dismiss + click-pop。编辑器「高级」区新增停留方式选择（until-interaction 时停留时长输入禁用并提示）。
- 测试 403 → **425 全绿**（36 文件；含真实时序回归锁：turn/end 紧跟 agent idle，success 仍展示满 holdMs）。
- **已应用户需求在其 live config 开启 `terminalHold: 'until-interaction'`**。

## 用户反馈迭代第二波（2026-08-20）

1. **活跃内切换动画**（用户反馈静默换图太生硬）：`advanced.activityTransition: 'subtle'|'none'|'state'`（默认 subtle）。新增 `builtin:activity-swap`（170ms 淡换，pose-swap@0.4），subtle 路径复用 runEnter 全 timeline 路径（零专用分支）。
2. **点击交互可编辑**：`interactions.click: { animation, pose }`——点击动画可选（新增 click-wiggle/click-bounce/click-spin 三个内置 interaction），可选「点击闪现姿势」（解析不到图则不变；换回由 `await finished` 驱动；真实状态目标到达立即抢占，不换回）。实现在 `MotionDirector.playInteraction()`（stage pose 簿记与 generation 归 director 所有）。
3. **参数放宽**（用户拍板的规格偏差，已注释标注）：strength 0..3、duration 60..2000、scale 0.3..4、zoom 0.2..8、sway 0..60°、周期/间隔/停留上限 120s、最小间隔 50ms；compiler 非 transition duration clamp 同步提到 120s。
4. **粒子特效**：`TimelineEvent` 新增 `{type:'particle', effect}`（confetti/star-burst/sparkle）——transition 允许 particle（pose-swap 仍恰好 1 个）、interaction 允许 particle、ambient 禁止事件。粒子层在 img 之上（pointer-events none），单粒子单条 WAAPI（3 帧放射+重力+淡出），上限 24/发、96 全局，零 rAF/timer；`advanced.particles` 开关（默认开）+ reduced-motion 强制不发射。celebrate 默认带 confetti。scheduler 零改动。
5. **新内置 transition `builtin:flip`**（用户新需求：轴向旋转无缝换图）：scaleX 1→0→1、pose-swap@0.5、300ms，2D 翻牌效应。TransitionPreset 联合类型与全部下拉已包含（含 preview 页下拉补齐）。

测试 425 → **473 全绿**（37 文件）。真机 CDP 验收：编辑器页点击「成功」触发 celebrate，粒子层实测 22 个粒子在飞（截图存档）。

### 编辑器页排版重构（2026-08-20，用户反馈「排版挤」）

- 顶部五组 flex-wrap GlobalBar 拆分为：**全局设置卡**（响应式 auto-fit 网格，标签列宽统一 96px，ms 单位后缀定宽对齐）+ **高级与互动全宽卡**（高级列：切换姿势/切换动画/停留方式/粒子特效；互动列：点击动画/闪现姿势；长提示全部降级为整行灰字，不再挤断控件）。
- 主区域三栏保持，预览列宽屏 sticky 跟随滚动；保存指示经 createPortal 挂入页面标题栏（无宿主时回落卡片上方一行）。
- 设置弹窗 MotionPetCard 未动。三档宽度（1600/1100/700，另抽 500 极窄）+ 暗色截图复核，无横向溢出/断裂/错位。
- 测试 473 全绿（全部断言走文本选择器，零测试改写）；浅色模式未目视（headless Chrome 151 的 setEmulatedMedia 对 prefers-color-scheme 无效，工具链怪癖；浅色兜底色值与 M5 验收时一致）。

## V1.1 P0 — 自定义动画端到端（2026-08-20）

按 `docs/v1.1-timeline-editor-plan.md` 分期，P0 完成：自定义动画已端到端可用（持久化 + 挂载 + 交互引用 + 编辑器 JSON 级管理）。

- **host 持久化**：`src/host/animations.ts`——`$DSH_HOME/motion-pet/animations/user_*.json` 每动画一文件；启动/GET 实时扫描（损坏/非法/非 user: 命名空间/重复 id 逐项跳过 + warnings，不阻塞）；save 全量 validateAnimationDefinition + 原子写；delete 引用保护 409 `ANIMATION_IN_USE`（引用判定：states.*.enter.animationId 与 interactions.click.animation）；id 字符集双重护栏（路径穿越结构上不可能）。
- **API**：`GET /api/motion-pet/animations`、`PUT/DELETE /api/motion-pet/animations/<id>`（路径 id 与 body.id 不一致 400 ID_MISMATCH；builtin id PUT 400）。真机逐项 curl 验证通过（上传→列表→引用→409→解除→删除→消失）。
- **animationId 挂载（§8.14 落地）**：`TransitionConfig.animationId?` 优先于 preset；host validation（builtin 须在清单内、user 须存在——经可选注入的 exists 检查；显式 null 清除、缺失保留 base、悬空 repair 删字段）；director resolveEnter 注册表命中优先、否则回落 preset。零专用分支。
- **client**：config-hub 携带 customs（load/poll/publish 全链路）；两会话经共享 `syncCustomAnimations` 对账（新增 register/变更重注册/消失 unregister，只碰 user:*）；editor-store 增删改直接走 API（显式保存语义，无 debounce）；**动画库面板**（仅独立编辑器页）：内置只读列表 + 新建/克隆（Preset→Customize，`user:<uuid>`）/重命名/删除（409 中文提示引用方）+ 名称/类型/时长/repeat 表单 + tracks/events JSON 编辑域 + 实时校验禁存 + 试播（scratch id `user:0draft` 注册播放）；TransitionEditor 下拉分组内置/自定义（animationId 回显/清除）；点击动画下拉纳入 interaction customs。
- 测试：40 文件 / **548 用例**全绿（P0 两半合计 +75）。
- 遗留进 P1：可视化时间轴编辑（轨道/关键帧/easing 控件）、试播 strength 手感滑条。

## V1.1 P1 — 可视化时间轴编辑器（2026-08-20）

- **`src/client/timeline/` 组件套件**（8 文件，纯 React+TS、零 shell 依赖）：`TimelineEditor` 受控组件（`{kind, tracks, events, onChange, onValidationChange}`）+ Ruler/TrackLane/EventTrack/KeyframeInspector + 纯函数层 `timeline-model.ts`（全部编辑操作不可变、每步保持可证明合法）+ pointer 手势（3px click/drag 阈值）。
- **交互核心**：lane 空白单击新建关键帧（值取该处曲线采样 + 继承 governing easing，插入前后动画逐位一致）；拖动改 at（0.01 吸附、clamp、碰撞拒绝回弹）；检查器编辑 at/value（固定值↔强度参数双模式）/easing（命名+别名+自定义 cubic-bezier）/删除；**同层 easing 修改自动同步同层其他轨道**（稀疏轨道自动插帧 + 恢复帧防外泄）；添加轨道按层分组且镜像同层时刻与 easing（添加即合法）；事件轨按 kind 显隐（transition 恰好 1 个 pose-swap 不可删、particle 可增删拖、ambient 无事件轨）+ 自愈按钮。
- **动画库集成**：草稿从 JSON 字符串改为结构化 tracks/events，TimelineEditor 直驱；双通道门控（标量校验 + 时间轴校验）；**JSON 视图**保留（只读同步 + 「编辑 JSON」应用路径，粘贴外部定义仍可用）；克隆内置携带当前草稿；试播条新增**循环试播**（变更后 600ms 自动重播）与**试播强度滑条**（只作用于预览）；previewDefinition/playCustom 打通 strength 覆盖。
- 测试：42 文件 / **588 用例**全绿（timeline-model 19 + timeline-editor 18 + 集成 5 等）。
- 真机 CDP 验收：三轨道 lanes/⚑ 标记/检查器/自愈按钮/JSON 视图截图复核（1600/1100 两档）；真实鼠标拖关键帧生效；试播期间 transition 层 computed scale 连续采样到 24 个变化值（预览确实在播变形动画）。
- 已知从简（代码注释在案）：移动/删除关键帧造成的同层 easing 失配只报不自动修；TimelineEditor 无 readOnly 通道（内置动画的轴上试改只能试播，保存靠克隆）。

## GitHub 仓库建立（2026-08-21）

- 仓库：`https://github.com/Traveritas/dsh-motion-pet`（**PRIVATE**，发布前可改 public）。initial commit 已推送（main 分支，130 文件；node_modules/lib/构建产物经 .gitignore 排除）。
- `package.json` 已补 `repository`/`homepage` 字段。
- **CI 未随首推**：gh token 缺 `workflow` scope，含 `.github/workflows/ci.yml` 的推送被 GitHub 拒绝。ci.yml 保留在工作区未跟踪；用户执行 `gh auth refresh -s workflow` 后补交即可启用 Actions。
- 名称保持 `dsh-motion-pet`（用户决定），npm 发布继续搁置（调优中）。

## V1.1 — 宠物预设（2026-08-21）

- **数据边界**：宠物预设只拥有 `{poses, states, scale}`，全局启用、减少动态、停留策略、互动、overlay 位置和自定义动画继续由全局配置拥有；身份指针为 `config.activePetId`。
- **host**：`PetsStore` 以 `$DSH_HOME/motion-pet/pets/<id>.json` 一宠物一文件持久化，原子写 + 串行队列，损坏文件跳过并返回 warnings。配置保存后把预设切片镜像到 active preset（config 主、preset 镜像从，镜像失败只告警）。新建空白或应用其他宠物前若 `activePetId === null`，自动把当前切片保存为「未命名宠物」。资产删除引用检查扩展到全部预设，非激活预设引用同样返回 409 `ASSET_IN_USE`。

### 2026-08-22 — 编辑器体验与回归修复

- 配置编辑改为显式“保存修改”；关闭页面不再写入草稿，宠物切换遇到未保存修改时提示先保存，也不再自动创建「未命名宠物」。图片上传仍即时用于预览，配置引用与旧资产清理在手动保存后执行。
- 动画库内新增独立试播渲染器与停止按钮；试播不再占用状态预览渲染器，循环/随机间隔动画可立即取消。
- 动画类型切换会按类型规范事件：环境动画清空事件，互动动画移除 `pose-swap`，切回过渡动画自动补充 `pose-swap`。
- 修复自定义环境选择“无”后回弹：客户端用 `null` 明确清除可选动画引用，并在保存请求期间拒绝旧配置广播覆盖本地草稿。
- **API**：`GET/POST /api/motion-pet/pets`、`PUT/DELETE /api/motion-pet/pets/<id>`、`POST /api/motion-pet/pets/<id>/apply`。删除 active preset 只清空指针，当前角色配置保留为「未保存的当前配置」。
- **client**：editor-store 与 config/custom animations 并行加载 pets；新建副本/空白、重命名、删除、应用均为即时 API 动作。身份变更前先冲刷 300ms 防抖窗口内的编辑；create/apply 采用 host 返回的完整 config 替换 draft 并 publish，delete-active 从刷新结果同步 null 指针。独立编辑器顶部新增「宠物」卡，空配置状态下仍可管理预设。
- **验证**：43 文件 / **636 用例**全绿，typecheck 零错误，四产物 build 通过。重启真实 `dsh web` 后完成新建当前/空白、列表、应用、重命名、删除与跨预设资产 409 矩阵；临时数据清理后 live config 对比恢复一致。编辑器 1280×720 暗色真机目视：宠物卡位于全局设置上方，无横向溢出，原三栏与预览正常。

## V1.1 — 自定义环境动画状态挂载（2026-08-21）

- **配置与编辑器**：`states.*.ambient.customAnimationId` 可为六个状态分别选择一个 `kind: ambient` 的用户动画；环境编辑区只列出 ambient 类型，并回显悬空引用。
- **运行时**：自定义环境动画与 Bounce / Sway / Breathing 并行播放，统一走 Timeline Engine；切换状态、修改动画定义、清除引用与 reduced-motion 都会正确启停，悬空或类型不匹配的 id 安静忽略。
- **保护**：Host 校验用户命名空间和动画存在性；删除动画会检查当前配置及全部宠物预设中的进入动画和环境动画引用，引用中返回 `409 ANIMATION_IN_USE`。应用宠物时会显式清除目标预设没有保存的可选动画 id。
- **验证**：43 文件 / **649 用例**全绿，typecheck 零错误，四产物 build 通过。重启真实 `dsh web` 后，现有自定义环境动画「奶蛋-工作」在待机/思考/工作/等待/成功/错误六个状态的下拉中均可见；通过 UI 挂载后 Host 配置保存了对应 id，验收结束已恢复原配置，active pet 预设也无残留引用。

## 外部审查修复 — UX 护栏 + 安全/契约收口（2026-08-23）

独立代码审查（用户体验 + 接口可扩展性两个维度）后的两批落地。

### 编辑器与运行时 UX（审查 UX-1..UX-4 及小项）

- 手动保存模型补齐丢失保护：独立编辑器页在 dirty/saving/error 态注册 `beforeunload`；`SaveIndicator` 新增「撤回修改」控件（confirm 后 `EditorStore.revertConfig()` 重新 GET 磁盘态替换草稿、清空待删资产队列，保留 selectedState/customs/pets）。动画库草稿切换/新建/克隆/删除前有未保存修改时弹确认并在列表标记 ●。
- 图片上传进行中 `importing` 状态：导入按钮 disabled + 「上传中…」，防重复上传产生孤儿资产。
- 舞台命中区收窄到宠物本体：`pointer-events` 移到 pose `<img>`（尺寸由 layoutPose 驱动，随 anchor/zoom/scale 自动跟随，退化布局回退整格），透明区域不再吞掉底层 UI 点击；`<img>` 兼任 a11y 操作体（role=button / tabindex / Enter+Space 互动）。
- 运行时修复：终态 TTL 改用事件自带 `ts`（SSE 重连不再重放陈旧 success/error）；页面 hidden 期间 enter 过渡实例随 director pause/resume（§23 补齐，经 `EnterReportingEngine` 侧通道上报实例）；`<img>` 加载失败 console.warn + 虚线占位；拖动 grabbing 光标；位置夹紧按 userScale 折算；coalescing 增加 200ms 最大窗口防饿死。
- 其余小项：全局过渡下拉补 flip、缩放范围两处对齐 0.3–4、NumberField 改 blur/Enter 提交（输入中间值不再被逐键 clamp）、TransitionEditor 预览按钮播放所选状态的进入动画、删除动画确认、错误通知 role=alert、编辑器页头 sticky、STATE_LABELS 收敛到 state-labels.ts。
- 暂缓项清单见 `docs/deferred-backlog.md`。

### enter 挂载点 kind 契约（审查 EXT-1）

- 问题：`states.*.enter.animationId` 只做存在性校验，`kind: ambient/interaction` 的自定义动画可经 `PUT /config` 挂上 enter；该定义没有 `pose-swap` 事件，enter 播完后 `stagePoseUrl` 仍被无条件写为新 pose 的 URL，违反「完成的 enter 必然换过图」不变量（首屏可致永久空白，后续静默换图被 URL 相等短路）。
- 修复：`MotionDirector.resolveEnter` 仅接受 `kind === 'transition'` 的 override（错误 kind 与悬空 id 同样回落 preset）；Host 校验注入从存在性检查升级为 kind 查询（`AnimationsStore.kindOf()`，校验选项改名 `animationLookup`），enter 要求 transition、`ambient.customAnimationId` 要求 ambient，wrong-kind 在 strict 模式 400 / repair 模式丢弃回落。`interactions.click.animation` 维持 shape-only（运行时 `playInteraction` 已有 kind 防御，注释保持该决策）。
- 测试：validation 错误 kind 的正反用例、repair 回落；director「ambient 挂 enter 回落 preset 且正常换图」。

### 跨源写防护（审查 EXT-2）

- 问题：三个 POST 写端点（assets 上传 multipart、pets 创建/apply 可接受 text/plain body）属于 CORS「简单请求」，恶意网页无需 preflight 即可触发副作用；Host 层此前无任何 Origin/Sec-Fetch 校验。DSH 网关对插件 exact/prefix 路由的鉴权行为未在官方源码中确认，按纵深防御处理。
- 修复：`registerRoutes` 的统一 wrap 层对非 GET/HEAD/OPTIONS 请求校验 `Sec-Fetch-Site: cross-site` 拒绝（403 `CROSS_ORIGIN`）；无 Sec-Fetch-Site 时回落 Origin 与 Host 比对（`null` 与外域拒绝）。无浏览器元数据的请求（curl / 未来 CLI）放行。SSE 状态流是只读 GET，不在防护范围。
- 测试：cross-site 上传 403 且无落盘、外域 Origin 的 text/plain POST /pets 403、同源 Origin 与无元数据客户端放行、GET 不受影响。
- **验证**：43 文件 / **699 用例**全绿，typecheck 零错误。

### 复查修复（同日第二轮）

提交前独立复查两轮改动，发现并修复 editor-store 两个并发路径问题及两处小项：

- **高**：`importImage` 的 superseded 分支只发 notice、丢弃 assets/configRevision/saveState patch，但 draft mutation 已无条件执行——被取代的上传会留下"snapshot 落后于 draft 且无 revision bump 自愈"的不一致（并发导入可自然触发）。修复：被取代的导入照常落地数据 patch，仅 `importing` 标志归最新序列。
- **中**：`writeLoop` 尾部无条件 emit `'saved'`，会覆盖 `cleanupReplacedAssets` await 窗口内新编辑的 `'dirty'`（UI 显示已保存、保存按钮禁用、beforeunload 不注册）。修复：尾部按 `this.dirty` 决定终态。
- 小项：`removeImage` 在保存进行中保持 `'saving'`；宠物 rename/delete 非 active 目标同时跳过 dirty 与 failed-save 两道门（原实现只放宽 dirty 门）；revertConfig 注明"GET 窗口内的纯编辑按设计丢弃"。
- 新增测试：并发导入（被取代导入数据仍落地）、清理窗口 dirty 保持、in-flight 保存中 removeImage 被 latest-wins 收编、failed-save 不阻塞非 active 重命名。

## 附属插件扩展服务 — L1 + L2（2026-08-25）

插件化评估的落地：主插件通过 cordis 服务向其他 DSH 插件开放三个能力窗口，附属插件 `inject` 对应服务名即可选装（服务出现自动加载、主插件卸载自动失效）。机制核实：rc.7 的宿主侧与浏览器侧（dsh-client-runtime 本身是完整 cordis Context 上的插件）都支持 `ctx.provide` + 静态 `inject`，跨插件协作走服务正是 client bundle purity gate 注释声明的官方预期路径。设计原则（用户拍板）：**主插件只提供能力、不做策略**——打断选项随每次点播请求携带、位置是否持久化由调用方决定、性能红线不对外强制；唯一硬规则是用户拖拽手势永远优先于程序驱动。

### L1 宿主侧：`motion-pet`（src/host/service.ts）

- `registerAnimation(definition)` 直接委托 `AnimationsStore.save`——同一套 schema 校验、`user:` 命名空间强制与原子写；附属插件约定用 `user:<pack>-<name>`（如 `user:motion-run-wall-bounce`）避免与编辑器自制动画及彼此冲突。
- 幂等语义：同名重注册覆盖原文件（安装/升级幂等）；附属卸载后其动画**留在库中**由用户在编辑器管理——动画库以主插件为唯一权威。
- 提供时机在全部路由注册成功之后（mount-once 旗标语义不变：中途失败不 advertise 服务）；入口同时声明 `export const provide = ['motion-pet']` 供 loader 排序。

### L2 浏览器侧：`motion-pet/client`（src/client/extension-service.ts）

cordis-free 单例 + 模块级「活跃会话桥」（PetOverlay 创建/销毁 OverlaySession 时注册/注销，`clearActivePetSession` 带陈旧守卫；照 `installCurrentSessionSource` 的容忍缺席模式——overlay 随 enabled/图片可用性卸载重建，「无会话」是每个 API 都要优雅降级的正常窗口）。`client/index.ts` 是唯一碰 ctx 的文件。三窗口：

- **快照**：`getStageSnapshot()` / `subscribeStage(cb)`（订阅即推当前值；位置/缩放/状态/会话生命周期变化同步推送）。§27 默认角折算成具体 px，x/y 永不 null。通知触发点：drag onMove、driver apply、updateConfig 两条退出路径、director target 变化（新 `subscribeTarget`）、start 完成、resize re-clamp。
- **位置出借**：`requestPositionControl()` 独占租约（同一时刻最多一个驱动方）。`apply` 先 `clampStagePosition` 再落位（与拖拽同款数学，`this.position` 永不持有越界值）；`commit` 清 pending debounce 后走既有 `persistPosition`（overlay 切片 patch + hub 广播，不另写持久化路径）；`release` 归还。借出期间 `updateConfig` 的远端坐标守卫追加 `activeDriver === null`——方向盘借出后远端（编辑器/他 tab）不再拽宠物。
- **点播**：`playAnimation(id, { interrupt?, strength? })`。registry（builtin: 与同步来的 user:）未命中返回 null。`interrupt: true`（默认）= `director.interruptEnterTransition()`（§10.2 generation 作废：被打断的 timeline 不得换 pose、不得重启 ambient）+ dispose 本服务之前点播的全部实例；`false` = 「有东西在播就放弃」（transitionInFlight 或本服务活跃实例，settle 未清扫的微任务间隙不算在播）。实例跟踪照 PreviewSession.playCustom。

### 拖拽仲裁与 motion 层增量

- DragController 新增可选 `onDragStart`（仅在跨越 4px 阈值时触发一次，click 不触发）：手势开始即挂起驱动方（`onUserDrag` 监听触发、`apply` 返回 false），手势结束自动恢复——「人的手永远赢」是唯一不开放的策略。
- MotionDirector 新增 `subscribeTarget`（`current` 唯一赋值点后同步通知）与 `interruptEnterTransition()`（无在播 transition 时 no-op，防误杀在途 §10.2 守卫如 click flash 恢复）。原 `stop()`/`swapPoseSilently()` 的内联取消收编为 `invalidateEnterTransition()`；`swapPoseSilently` 的 `enterInstance` 清理由 settle 回调异步提前到同步，语义等价（唯一差异窗口内仅可能对已取消实例 pause/resume）。playInteraction 的 generation 逻辑实为**守卫**而非作废，故提炼为 `captureEnterGuard()` 供其专用，行为逐位不变。
- 安全边界不变：附属只能注册受 schema 约束的 AnimationDefinition、点播注册表内既有的 id，不能注册新 motion property 或任意 JS（白名单哲学不破口）。

### 验证

新增 `tests/host/host-service.test.ts`（5）与 `tests/client/extension-service.test.ts`（16），drag-controller 增 onDragStart describe（1），plugin-entry 补服务生命周期断言。45 文件 / **724 用例**全绿，双工程 typecheck 零错误，四产物 build 通过。

## 服务扩展 + 第一个附属插件：抛掷物理（2026-08-25）

上一节服务的首次真实消费催生了四个增量 API（commit `515232a`，均有测试锁定）：

- `StageSnapshot.stageSize`：舞台方块基准 px——碰壁/边缘计算需要包围盒（`stageSize × scale`）。
- `subscribeUserDrag(phase)`（服务级，无需租约）：'start' 过拖拽阈值 / 'end' 真位移结束；抛掷类附属在手势期间用 `subscribeStage` 采样测速、'end' 时才申请租约。**租约持有期间主插件忽略远端 overlay 坐标**，所以"只在飞行期间持有"是附属侧的纪律。
- `flashPose(poseKey, holdMs)`：换图 + holdMs 后恢复状态机当前 pose（动画内 pose-swap 事件表达不了"然后恢复"）；直接 `stage.swapPose` 循 `refreshCurrentPose` 先例（§16.3 全量预载，swapPose 按 src 幂等，与真实 transition 竞争安全）；二次 flash 替换未决恢复，dispose 取消。
- Host 服务 `hasAnimation(id)`：附属首装守卫——只在缺失时注册默认动画，用户改过就不覆盖。

**`dsh-motion-pet-physics` v0.1.0**（平级独立仓库，首个附属插件）：拖拽甩出 → 重力/碰壁反弹（半隐式欧拉纯函数引擎）→ 碰壁可选播放动画（默认 `user:physics-bounce-pop`，interaction kind——schema 强制 transition 恰好一个 pose-swap，纯变形只有 interaction 合法）与 flashPose（默认关）；落定 commit+release；人手抓取/页面隐藏/会话消失各有干净退出路径；同壁 150ms 效果去抖、20s 飞行兜底。3 文件 / 52 用例独立全绿，client bundle 纯净。**真机端到端**：link 安装成功，host 半经真实 `motion-pet` 服务完成首装注册（`~/.dsh/motion-pet/animations/user_physics-bounce-pop.json` 落盘核对无误）；浏览器侧视觉验证待用户重启 `dsh web`（验证时被无关第三方插件的进程锁挡住）。

配置承载调查结论（对后续附属插件同样适用）：rc.7 **没有**外部插件的 schema 配置表单路径——Plugins 设置页只渲染插件自注册的卡片命名空间（dsh-client-ui-settings-plugins README："A served namespace no card claims renders nothing"），shell 冻结模块表无 schema-form，浏览器侧插件 entry 经 `loader.create({ name })` 创建不携带 config。附属的可调项当前以源码常量 + README 承载；要 UI 就得像主插件那样自带 settings 卡片。

## flashPose 统一记账 + 附属物理地面滑动（2026-08-25，评审第二轮）

主插件（commit `f23f7c4`）：附属 flashPose 上线后的真机反馈评审,核心结论是**pose 的多写入方（状态机 / 点击恢复 / 附属 flash / 配置热刷新）缺一本账**。统一方案:OverlaySession 持有"活跃 flash 保持"（pose + 截止时刻;holdMs≤0 为 Infinity,直到下个状态变化）,MotionDirector 持有 `stagePoseUrl` 台账并开放 `noteExternalPose(url)` 记账钩子;全部先红后绿修复:

- **M1（保持期被广播截断）**：`updateConfig` 末尾无条件 `refreshCurrentPose`,看到舞台显示 flash pose ≠ 状态机 pose 就换回（B 落定 commit 的 hub.publish 是最常见触发者;网络往返时序导致"有时没那么快"）。修复:`refreshCurrentPose` 在保持期内跳过 pose 强制,保持结束由 flash 自己的恢复对齐（恢复时按**新配置**重新解析,期间错过的热编辑不丢失）。
- **M2（stagePoseUrl 漂移卡死）**：flashPose 直写舞台绕过了 director 台账;holdMs=0 + activityTransition='none' + 新旧 poseKey 经 fallback 解析到同一 URL 时,`swapPoseSilently` 的跳过守卫误判"该 URL 已在台上"而漏换,宠物卡在闪换图。修复:所有带外 pose 写入（flash、恢复、两会话的 refreshCurrentPose）一律 `noteExternalPose` 记账——与 playInteraction 早已保持台账同步的做法对称;守卫本身（`swapPoseSilently` / playInteraction 两处）不改语义,只让输入变真。
- **M3（点击顶保持,用户实测不复现）**：代码层证实假设——默认 `interactions.click.pose === null`,`playInteraction` 在 `flashPose === null` 时提前返回、完全不碰 pose,故默认配置下点击不可能顶掉保持（已加锁定测试固化该解释）。可达变体（用户配置了点击闪图）确实会截断:点击恢复现在经可选 `getExternalPoseHold` 接缝查询未决保持,活跃则恢复到**保持中的 pose**（非状态机 pose）,由保持自己的恢复/下个状态变化收尾;保持已过期则照常恢复。接缝可选,PreviewSession 与既有 director 语义零变化。
- 保持的终止条件统一为:截止时刻**或** director target 变化（先到者）——目标变化即状态机收回 pose 所有权,enter/silent-swap 自己决定下一张图,避免恢复与在途 transition 打架。
- **L1**：页面 hidden 时立即完成未决的定时恢复（纯换图无动画,不违反 §23;浏览器后台限流 timer 不会把闪图拖过截止）;**L2**：`DragController.dispose` 中断真实拖拽手势时补发 `onDragEnd`（与 pointercancel 同契约）,`OverlaySession.dispose` 相应先结束手势再落最终位置写——卸载瞬间的拖拽位置不再丢失。
- 不修记账入 backlog:M4（commit 往返期间租约未还、快速再掷被吞——用户拍板"不好修就没必要修"）、L3（commit 与在途防抖 PUT 交错,极窄窗口）,以及"未来在服务上暴露 isPlaying 查询供附属节流"的想法,见 `docs/deferred-backlog.md`。
- 验证：新增 9 测试（extension-service 4:广播不截断/同 URL 静默换图收回/默认点击不碰保持/配置点击闪图恢复到保持 pose;overlay-session 2:hidden 立即恢复/卸载中手势持久化;motion-director 3:记账后守卫为真/恢复到保持 pose/保持过期恢复常态,其中 drag-controller 原"dispose 静默"锁更新为新契约）。45 文件 / **741 用例**全绿,双工程 typecheck 零错误,四产物 build 通过。

附属 `dsh-motion-pet-physics`（commit `b1a8f43`,99 用例,较 82 增 17）:落地**地面滑动**状态——弹跳后期预测反弹高度（vy²/2g,restitution 后）低于 `minBounceHeightPx`（默认 12px）即不再反弹、不触发碰壁效果,贴地滑动（vy=0、侧壁只夹不弹、`groundFriction` 默认 2/s 衰减）,低于 `settleSpeed` 照常落定;阈值调 0 恢复旧的连弹行为（用户注:"反复触发可能是一些人要的效果"）。新增配置 `physics.minBounceHeightPx` / `physics.groundFriction` / `slideAnimationId`（滑动开始播一次,默认 null）,卡片加"落地滑动"组,README 配置表同步。测试缺口补齐:M5a（settle 的 commit→release 顺序断言 + commit 失败仍 release 只告警）、M5b（路由 same-origin Origin 放行 / 'null' Origin 拒绝变体）、L4（config-hub 的 getConfig 未加载/加载失败路径返回 DEFAULT_CONFIG 克隆而非共享引用）。
