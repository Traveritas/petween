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

## 编辑器 UI 文案与信息架构收口（2026-08-25）

只动 UI 层（标签 / 分组 / 提示文案 / 字段归属），配置 schema、HTTP API、动画引擎、CSS 类与布局体系零变化。两处用户点名 + 一轮四维度系统审查（同一概念同一词 / 字段归属 / 高低频分层 / 术语自解释）：

- **终态停留三件套归位**：原「成功/失败停留」模式选择在 AdvancedCard「高级」列，而 successHoldMs/errorHoldMs 两个时长字段远在 GlobalCard（全局设置）——同一概念被拆在两张卡片。现合并为 AdvancedCard 内新的「成功/失败」分组（cardColumn + groupTitle，第三个分组列）：停留方式下拉 + 成功停留 + 失败停留 + until-interaction 时的「停留时长不适用」提示 + 新增一行分组说明（任务成功/失败后宠物保持该姿势的方式与时长）；disabled 联动（非 timed 模式时长禁用）随迁。GlobalCard 回归纯全局高频项。
- **「环境动态」→「循环动画」全量改名**：AmbientEditor 标题/aria-label/「自定义环境」→「自定义循环动画」/提示（内置通道→内置循环）；AnimationLibrary 的 KIND_LABELS（环境→循环动画）与 KIND_OPTIONS；库空态提示「过渡、环境动态与点击互动」→「过渡动画、循环动画与点击互动」；editor 页副标题；editor-store 删除保护引用标签「状态环境动态」→「状态循环动画」；docs/motion-format.md 两处描述性文字（kind 表格与 events 约束，格式定义本身不动）。config 字段名与 kind 值 `'ambient'` 为契约，一律未动。
- **审查修复**：TransitionEditor 行标签「Preset」→「预设」（含回落提示文案）；PoseEditor「Anchor X/Y」→「锚点 X/Y」（提示改为「锚点（Anchor）…」保留英文对照）；LivePreview「Anchor 十字」→「锚点十字」、提示去掉 spec 引用与 Overlay 术语（「预览与真实 Overlay 使用同一套渲染与状态机（§16.2）」→「预览与主界面宠物使用同一套渲染与状态机」）。
- **测试同步**：motion-pet-settings（环境动态→循环动画 ×2、Anchor 十字→锚点十字、成功/失败停留→停留方式）、animation-library（Preset→预设 ×2、自定义环境→自定义循环动画 ×2）、editor-entry / motion-pet-card / editor-store 的环境动态断言。45 文件 / **741 用例**全绿，双工程 typecheck 零错误，四产物 build 通过。

**发现但未改（待用户拍板）**：① 「活跃内切换动画」措辞略歧义（可读成"切换动画"而非"换图用的动画"），候选「活跃内换图方式」，涉及既有心智未动；② 动画库/TimelineEditor 面向 Motion Pack 作者，保留 pose-swap、transition.scaleY 等格式原文（与 motion-format.md 一致），普通用户路径（状态面板）不接触这些词；③ 独立 preview 页（src/preview/index.tsx）为开发者工具，全英文标签，刻意未纳入本轮中文化；④ development-spec.md 为规格存档，仍用规格术语「环境动态」，未追改。

## 界面跟进五项：命名歧义 / 中文注释 / preview 中文化 / 规格措辞 / 死 CSS（2026-08-25）

用户拍板的五项跟进，上一节「发现但未改」①~④ 全部落地。仍然只动 UI 文案、展示层映射与文档；配置字段名、动画 id、kind 值、HTTP API、引擎逻辑、JSON 视图零变化。

- **「活跃内切换动画」→「活跃内换图方式」**：MotionPetSettings 高级区 SelectRow 标签（旧名可误读为"切换动画"，实为换图所用的方式）；下方提示本已是「按上方所选方式换图」无需再动。motion-pet-settings 测试三处断言同步。
- **格式原文加中文注释（展示名映射表）**：新增 `src/client/timeline/display-labels.ts`——motion property 白名单（13 项）与事件类型的 Record 映射 + `motionPropertyDisplayName` / `eventTypeDisplayName`（未知值原样透传）。接入四处：TimelineEditor 添加轨道下拉 option 文本与「＋ 添加 pose-swap（换图）」按钮、TrackLane 可见轨道标签（title 提示保留裸 property 作规范标识）、KeyframeInspector 标题「关键帧：transition.scaleY（纵向挤压） @ 0.45」、EventTrack 的 `eventLabel`「pose-swap（换图）事件 @ …」及检视器提示；AnimationLibrary 类型切换提示同步。值全部不变（option value / aria-label 查询钩子 / JSON 视图原样）。
- **preview 独立页中文化**：评估为单文件纯控件文案（无结构改动），全量落地——状态按钮改用 state-labels.ts 的 STATE_LABELS、过渡/循环动画/减少动态/预设下拉与滑杆标签对齐编辑器用语（Bounce 弹跳 / Sway 摇摆 / Breathing 呼吸 / 跟随系统…）、按钮「▶ 重播进入动画」「校验 → 注册 → 播放」、自定义定义反馈消息中文化、stage 提示与 index.html `<title>` 同步。未入 backlog。
- **规格措辞同步**：development-spec.md 仅存一处中文功能名「环境动态」→「循环动画」（核心理念行），并在文档头部新增一行术语对照（「循环动画」即 ambient/环境动画，AmbientEngine / `states.*.ambient` / `bounce.*` 等标识符保留原名）；README 三处残留的「环境动态/环境动画」一并同步。交接包历史副本未动。
- **删除 `.hintFull`**：grep 确认全仓仅 settings.module.css 定义自身一处引用（迁移后失引用），删除该类块。

**验证**：timeline-editor / animation-library 测试断言同步（关键帧标题、pose-swap 事件标签、heal 按钮精确匹配、`^="pose-swap"` 前缀查询改为不空洞的形式），新增一处下拉展示名断言（option 文本 = `transition.rotation（旋转）`，value 不变）。45 文件 / **742 用例**全绿（数量与基线一致），双工程 typecheck 零错误，四产物 build 通过。

## Petween 全局改名（2026-08-26）

motion-pet 体系整体更名 **Petween**（v1.1.0 → **v1.2.0**），同步仓 `dsh-motion-pet-physics` 更名 `petween-physics`（v0.1.0 → v0.2.0）。目录名不动（迁移由主线负责），本仓代码/配置/文档全量改名，历史小节与规格存档（development-spec.md、handoff/v1.1 计划文档）按惯例不追改。

**契约摘要**（新旧对照，全部落地）：

| 项 | 旧 | 新 |
| --- | --- | --- |
| 包名 | dsh-motion-pet | petween |
| cordis 插件 name / 服务名（host provide + 附属 inject） | motion-pet | petween |
| client 服务名（provide + 附属 inject） | motion-pet/client | petween/client |
| 主 HTTP 路由前缀 | /api/motion-pet/ | /api/petween/ |
| 静态资产路由 | /motion-pet-assets | /petween-assets |
| 编辑器页 | /motion-pet-editor | /petween-editor |
| 数据目录 | $DSH_HOME/motion-pet | $DSH_HOME/petween |
| mount-once Symbol | Symbol.for('dsh-motion-pet/host') | Symbol.for('petween/host') |
| client bundle id（tsdown banner） | "dsh-motion-pet" | "petween" |
| CSS 类前缀 / cssModulesInline pluginId | dsh-motion-pet-* | petween-* |
| UI 显示名 | Motion Pet | Petween |

TypeScript 标识符随体系同步（MotionPetConfig → PetweenConfig、createDefaultMotionPetConfig → createDefaultPetweenConfig、MotionPetCard/MotionPetSettings 组件及其文件名、petweenClientService 等）；`data-motion-pet-renderer` 钩子属性 → `data-petween-renderer`；package.json repository/homepage 改指 https://github.com/Traveritas/petween；SSE 心跳注释行 `: petween`。

**数据迁移（用户有真实数据，最关键项）**：新增 `src/host/migrate.ts` 的 `migrateLegacyHome(legacyDir, targetDir)`——目标目录已存在 → 跳过（幂等）；仅旧目录存在 → `fs.renameSync` 原子改名（同盘一次成功，无双维护窗口）；rename 失败（EXDEV 跨盘 / EBUSY·EPERM 占用）→ `cpSync(recursive, force:false, errorOnExist, preserveTimestamps)` 复制并**保留旧目录**作保底；复制也失败 → console.warn + 清掉半成品目标目录（下次启动可重试），不删旧数据、不阻断启动。`src/index.ts` 在构造任何 store 之前调用（store 先建会以默认值落地新目录并和迁移竞态）。测试：tests/host/migrate.test.ts 五例（改名后内容逐字节一致且旧目录消失、目标已存在两树皆不动、新旧皆不存在零副作用、rename 失败走复制双树并存、双失败 warn+清理+旧树完好）+ plugin-entry 一例（真实 apply() 在隔离的 $DSH_HOME tmpdir 下完成迁移）。

**测试隔离**：apply() 现在会真实触碰 $DSH_HOME，tests/host/plugin-entry.test.ts 顶层把 `process.env.DSH_HOME` 指向一次性 tmpdir（afterAll 还原），确保测试永不迁动真实用户数据。

**验证**：46 文件 / **748 用例**全绿（742 基线 + 6 迁移用例），双工程 typecheck 零错误，四产物 build 通过（lib/client.js 首行 `id: "petween"`、CSS 前缀 `petween-*`、banner/cssModulesInline pluginId 均为新名；产物中残留的 `dsh-motion-pet` 字样仅为构建机仓库绝对路径，属目录名范畴）。

### 改名落地备注(Windows 环境坑)

目录改名(`dsh-motion-pet/` → `petween/`)后,dsh web 首次启动报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-home-paths`:pnpm 在 Windows 上用**绝对路径 junction** 布置 node_modules,父目录改名后所有 junction 目标仍指向旧路径,全部断裂。修复:在改名后的目录里 `CI=true pnpm install` 清空重装(junction 重建;lockfile 未变,产物无需重构建)。**任何移动/改名含 pnpm node_modules 的目录后,必须重新 `pnpm install`。**

## 附属插件方向评估 + 扩展服务 v1 增宽（2026-08-27）

**背景**：以附属作者视角定义了六个方向（情绪气泡 / 装扮配件 / 自主行为 AI / 小跟班 / 外部事件集成 / 养成小游戏），六个子智能体逐方向对照源码评估 v1 服务完备度。结论：physics 型「驱动主宠物」类附属覆盖良好；「渲染自有实体」「感知宠物输入」「事件级联动」三类存在结构性缺口（pose 流 / 指针事件 / 动画事件缺失、externalInstances 共享中断池、motion 引擎不可作用于外部元素等），逐项记录在案。用户拍板：**pose 通道开放（不再固定 6 槽）提级为高优先级**；无需拍板的简单增量先行落地，即本轮。

**本轮落地（全部纯增量，服务 version 保持 1 —— physics 以 `version !== 1` 拒载，增宽字段/方法对既有消费者结构性兼容）**：

- `StageSnapshot` 增补五字段：`viewport`（物理插件曾被迫自补 getViewport）、`dragging`（手势进行中标志）、`reducedMotion`（§22 有效值，附属遵守用户无障碍偏好）、`poseKey`（当前 target 的 pose 槽，快照组装点丢弃多年）、`bodyRect`（pose `<img>` 盒的视口真值 = 位置 + 用户缩放 + §12.3 anchor 数学，运动层变换不计；命中检测不再用 `stageSize*scale` 方块近似——典型素材下误触面积 30-60%）。`PetStage` 新增 `poseLayout` getter（layoutPose 结果落字段）与 `anchor` getter（防御性拷贝）。
- `PositionDriver.onUserDrag` 回调签名从 `() => void` 增宽为 `(phase: 'start' | 'end') => void`：v1 契约写明「挂起直至手势结束」却从不通知 end，长租约附属只能靠再次 apply 试探。零参监听器（physics 现状）仍兼容。拖拽 start/end 现在同时推送快照（dragging 是快照状态）；媒体查询变化（reduced-motion 翻转）也推送。
- 新增三方法：`isPlaying(): { enter, external } | null`（backlog D3 落地，只读探测取代 interrupt:false null 试探，enter/external 分账）、`listAnimations(): AnimationSummary[] | null`（registry 侧可播真值：builtin + 已同步 user，含 name/kind/durationMs/namespace；E5 第 3 条落地，选 client 侧而非 host 侧因为 session registry 才是「现在可播」）、`resyncAnimations(): Promise<void>`（强制一次 hub poll 并等 updateConfig 应用完——register→play 的 3s 轮询盲区/hidden 无上界窗口按需关闭，E5 第 5 条的中期方案）。实现附注：hub 订阅从 `void this.updateConfig(next)` 改为落 `pendingUpdate` 字段（catch 后 console.error，不再产生 unhandled rejection），resync 在 poll 的同步 emit 之后 await 它，时序安全。

**验证**：46 文件 / **787 用例**全绿（+18：快照增宽 4、driver 两相 1、isPlaying 3、listAnimations 2、resync 2、pet-stage poseLayout/anchor 3，及既有用例适配），双工程 typecheck 零错误，四产物 build 通过。physics 仓无需改动（其镜像类型只声明已知字段，结构化兼容）。

**待拍板（记录于本轮评估，未动）**：pose 通道开放的数据模型与命名空间（建议保留 6 内置状态槽 + 开放 `user:` 任意 pose 键，状态机只认内置槽，新键仅供 flashPose / 动画 pose-swap 调用；附属 pose 图资产走附属自带还是主插件 registerAsset 需定）；`playAnimation` 返回 `{ok, reason}`（破坏性，随 v2）；host `registerAnimation` 调用方隔离；事件流 API（pose 显示事件 / 动画起止 / 用户指针点击悬停）；中断池 per-caller 分池与 `preempt:'external-only'`；外部播放的 reduced-motion 约束（现仅 gate ambient）；挂载层 API（attachStageOverlay，气泡/配件/HUD 继承式跟随）；`playAnimationOn(layers)` 外部元素动画通道（化解「Animation Middleware 只作用于主舞台」的定位冲突）。

## Pose 通道开放 + 三条事件流（2026-08-27 第二批）

**背景与拍板**：六方向附属评估后用户逐项拍板——pose 通道按建议方案落地（保留 6 内置状态槽 + 开放 `user:` 扩展 pose 键；附属自带图资产，主插件只认 URL；外部动画 pose-swap 复用 flash 记账）；事件流 API 本轮做；`playAnimation {ok,reason}` 攒 v2；`playAnimationOn(layers)` 排队；中断池由主插件侧出方案；attachStageOverlay 评估后定。

### Pose 通道（开放扩展 pose，不再固定 6 槽）

- **数据模型**：`ResolvedPose.poseKey` 从 `PoseKey` 放宽为 `string`（内置 resolver 仍只产六槽）；`createPoseResolver` 返回值同步放宽（非内置键 → null，一处修复所有 seam 消费点）。状态机/`MotionTarget`/config 的 `poses` 六槽**不动**——扩展 pose 不参与状态解析与 fallback。
- **schema**（motion/animation-definition.ts + motion-format.md §6）：`pose-swap` 事件新增可选 `pose` 目标字段（charset 校验：内置槽名或 `<ns>:<name>`）。规则改为——transition 恰 1 个 pose-swap 且**不得**带 `pose`（进场 pose 归状态机）；**interaction 允许 pose-swap 但必须带 `pose`**（原 V1 禁令解除）；ambient 仍禁事件。编译器 `...event` 展开自动透传新字段。
- **client 服务**：`registerPoses(ExternalPoseDefinition[]): boolean`（all-or-nothing 校验：`user:` id charset、anchor 0..1、zoom 0.2..8 与 host 校验同界；幂等覆盖；注册即 `stage.preload`；**session 内存态**——session 重建即丢，附属在快照流 null→非 null 时重注册，契约写入接口注释）；`unregisterPoses(ids)`；`flashAsset({url,anchor?,zoom?,width?,height?}, holdMs)`（一次性、不注册、不预载，首次可能加载闪白，文档注明）；`flashPose` 签名放宽 `PoseKey → string`（内置槽 fallback / 扩展表，physics 现有调用不变）。
- **统一解析 seam**：session 私有 `resolvePoseAny(key)`（内置 resolver / externalPoses 表），director 构造 seam 从 `this.resolvePose` 换到它（MotionDirectorOptions.resolvePose 同步放宽为 string）；preview-session 的 seam 以 `(POSE_KEYS as string[]).includes` 收窄（preview 无扩展 pose）。
- **外部播放的 pose-swap 执行**：`playExternal` 注入 onEvent——事件带 `pose` 即播放时解析（miss 静默跳过，同悬空 animationId 纪律），命中则走 `flashResolvedPose(pose, 0)`（挂 flashHold ∞）；实例 settle（finished **或** cancelled）时 `restoreFlashPose()` 对齐状态机 pose。loop 动画反复 swap 幂等、取消即恢复——打盹循环动画停下的那一刻回到状态姿势。state 优先级不变：pose-changing target 照旧清 hold。
- **flash 记账复用**：`flashPose`/`flashAsset`/外部 pose-swap 三入口共用私有 `flashResolvedPose` 核心，与 click 交互/状态机的既有互斥（M1/M2/M3）原样继承。

### 三条事件流（全部 v1 增宽，version 仍为 1）

- **`subscribePose`**：显示中 pose 流（真相而非状态机 want）。落点 `PetStage.subscribePoseSwap`——`swapPose` 是唯一图片写入口，state 机/flash/外部 swap 全部经它，session 桥接到服务层；订阅即推当前值（null = 无 pose/无会话），session 拆卸推 null；listener 异常隔离。
- **`subscribeUserPointer`**：`{kind:'click',x,y,detail}`（DragController `onClick` 改为携带坐标；detail 为自维护双击计数——400ms+25px 窗口内递增，键盘 Enter/Space 不属 pointer 流不推）+ hover enter/move/leave（img 上 mouseenter/mousemove/mouseleave；**move 经 rAF 合帧**，一帧一推末坐标，无 rAF 环境同步降级；§23 纪律）。纯观察流，不影响宠物自身拖拽/点击。
- **`subscribeAnimation`**：director 新增 `onPlayback` 观察钩子——`{phase:'start'|'settle', source:'enter'|'interaction'|'external', definitionId, status?}`，enter（runEnter 起止）、interaction（playInteraction 经 `play(id,{},'interaction')` 归因）、external（playExternal）三源全覆盖，cancelled 也 settle（start 必有配对）。

### host 侧 pack 隔离（E5-2 首步）

`registerAnimation(definition, meta?: {pack?})`：带 pack 时强制 `user:<pack>-` 前缀（pack charset 同 user: 名段），使 pack 注册**结构性**碰不到用户手做动画与他人 id；无 pack 保持旧语义（兼容 physics）。E5-2 的完整解（调用方身份贯穿 client 侧）见下节方案。

### 验证

46 文件 / **800 用例**全绿（+13：pose 通道 5、subscribePose 2、subscribeUserPointer 3、subscribeAnimation 2、host pack 1；另改写 animation-definition 事件基数用例适配新规则），双工程 typecheck 零错误，四产物 build 通过。physics 仓零改动（flashPose 字面量调用与新签名结构兼容）。

### 中断池 per-caller 方案（已定稿待实现，E5-2/D3 后续）

设计：服务加 `forCaller(callerId): PetweenCallerHandle | null`（callerId 校验 `user:<pack>-` 前缀，与 host pack 约定同一命名空间）；句柄版 `playAnimation(id, {interrupt:'none'|'caller'|'all'})` **默认 'caller'**——`externalInstances` 从共享 Set 改 `Map<caller, Set>`，'caller' 只掐自己池、且**不掐状态机进场动画**（preempt external-only，解「律动掐掉 DSH 状态表达」）；'all' 保持今天的全局语义（physics 兼容路径）；flash 保持 last-wins 单槽（settle/pose 事件已可归因，tag 随 v2 再议）。实现落点：overlay-session 池改造 + 句柄门控，中等成本，**排下一轮**，与「外部播放遵守 reduced-motion（默认 respect，行为变更）」同轮落地。

### attachStageOverlay 评估结论

核心实现不难（PetStage stageLayer 提供受控插入点，挂 userScale 层内即继承位置/缩放/全部身体变换），但「正确」成本在契约：session 重建节点销毁的 重挂约定、pointer-events 禁止、z 序规则、dispose 传播。评估为**可做但不宜与本轮（13 文件）同叠**——排下一轮第二个，与中断池同轮收口。

## Backlog 近期项核实收口 + 发布拍板（2026-08-27 晚）

外部核实 deferred-backlog 两个【近期】项与 physics 镜像项：**两项半已在既有提交落地或前提不成立**，本轮补一枚端到端锁定用例并修正 backlog 记载。

### E1（clamp 尺寸一致性）——已于 f84bc50 落地，backlog 记载滞后

「driver.apply 用未缩放 `stageSize` 预夹」在当前代码不成立：f84bc50 已把 `PetStage.visibleSize`（`max(size × userScale, MIN_VISIBLE_PX)`）确立为 §27 唯一 clamp 基准，driver.apply / DragController 的 stageSize 回调 / resize 回写 / `setPosition` 四处同源；`tests/client/overlay-session.test.ts` 有专项用例（scale=0.5 拖墙，DOM left / 内存 this.position / 快照 x / 持久化 patch 四方一致 −48px）。原 A7「拖拽手势内 clamp 未按 scale 收紧」同项闭合。

### C4（physics 快照镜像升级）——已于 physics 418a6e0 落地

镜像补 viewport/dragging/reducedMotion/poseKey/bodyRect 五个可选字段（消费方按 optional 处理，旧 provider 不炸）；飞行边界优先消费 bodyRect insets（可见身体贴墙而非方块透明边），`deps.getViewport` 保留为旧 provider 兜底。与 E1 的跨仓对齐即 backlog 建议的「同一窗口落地」，实际已在前两个提交内先后完成。

### F1（外部播放 reduced-motion）——前提不成立，测试锁定关闭

「经 `playAnimation` 播的外部动画完全不看 reduced-motion」与代码不符：`TimelineEngine.createInstance` **自 v1.0.0 起**就把 `stage.reducedMotion` 传入 `compileTimeline`，而 `playExternal → director.play → engine.play` 与一切播放共用该编译路径——§22 坍缩（轨道坍缩为终值常值帧、时长封顶 `REDUCED_MOTION_MAX_DURATION_MS=120`、事件按比例落点保留）天然覆盖外部播放；粒子另有 emit 前强制不发射。`ambient-engine.ts` 的显式 gate 只是「干脆不启动实例」的额外一层，并非唯一 gate（评审主张据此误判）。

backlog 原「PlayOptions 一行 gate 直接拒播」建议**否决**：拒播会连 pose-swap 换图语义一并吞掉（换图不是动效），坍缩编译恰好做到「动效消失、语义保留」，与 §22「Transition: None 或极轻 ≤120ms」的规格措辞一致；physics 碰壁动画在 reduce 下的「抑制」实际早已生效（squash 坍缩为不可见，pose 语义不受损）。

锁定用例（extension-service，+1）：reduce=always 下 `playAnimation` 产常值帧（rotate '12deg'→'12deg'）、duration ≤ 120ms、pose-swap 事件照常落图且 settle 回正；发布翻转为 never 后同一动画恢复 320ms 全保真——证明 flag 是**播放时**读取（engine.createInstance 时点），非构造期快照。

### 发布拍板（记入 backlog §1）

**暂不 npm publish**：GitHub 仓库公开 + `dsh plugin add link:` 安装供有兴趣者体验。因零存量用户，旧客户端/旧 provider 兼容议题整体作废——B2/B3 的「发布前先行」紧迫性解除（仍保留为 Motion Pack 前置组成员）；B9、E4 维持原判。

### 验证

主仓 47 文件 / **826 用例**全绿（+1），双工程 typecheck 通过；physics 零改动（120 用例维持全绿）。

## A2 / A5 / E3 三项拍板落地（2026-08-27 晚，第二批）

三个原【待拍板】项同晚全部拍板并实现；连同上一批（F1 锁定 / E1、C4 核实归档 / 发布拍板），backlog 的速览表只剩 Motion Pack 前置组与排队项。

### A2「另存为新宠物」— 拍板方案 A：草稿 → 新宠物，主版本不动

- **host**（routes.ts POST /pets）：新增第三种 `from:'draft'`——请求携带 `pet` slice（`{scale, poses, states}`），经 `validateConfigPatch` 以**默认 base**（非活跃配置，保证缺省键的校验语义与 `normalizePetSlice` 的修复语义一致）严格校验，动画引用用 `listAnimations()` 现场建 kind 表做存在性/kind 检查（未知/错 kind → 400 INVALID_CONFIG，与 PUT config 同一错误面）；随后 `createPet(name, slice)` 落盘，**不 apply、不动 activePetId**，响应仅 `{pet}`。`from:'current'|'blank'` 行为原样。
- **client**：api.ts `createPetFromDraft(name, pet)`；`EditorStore.saveDraftAsNewPet(name)`——读**当前 draft**（dirty 可用，这正是功能目的），先 `await saveChain` 再发请求，成功仅刷新 pets 列表（不改 config/saveState/dirty），失败走 error notice；不隐式保存、不切换宠物。UI：宠物卡新按钮「另存草稿为新宠物」（prompt 命名，默认 `<当前名> 变体`），提示文案说明无损分支用途。
- **测试**：host 路由 3 例（draft 落盘且活跃宠物/配置原样、未知动画 400、缺 pet 400）；store 2 例（草稿值入请求且本地状态原样不隐式保存；失败 notice + 不刷新）；UI 1 例（按钮走通、请求体是三键 slice、不切换不保存、列表见新宠物）。
- 方案 B（放宽 clone 的 dirty 拒绝 + 克隆旧版/草稿转正编排）经论证与 A 不冲突、可后补，未实现。

### A5 waiting 无限压制 error — 拍板 (a)：error 短暂穿透 + 严格更新守卫

`recompute()`（state-adapter.ts）：winner 为 waiting 时，查找 **TTL 内且 `ts` 严格大于 waiting.ts** 的最新 error，命中则以该 error 为 winner。要点：

- **自恢复零新机制**：error 自身 1.8s TTL 过期触发的既有 `scheduleTerminalExpiry` recompute 自动回到 waiting——效果是「闪约 1.8s 报错脸再回到等待脸」，不新增任何定时器语义。
- **严格更新守卫**（`error.ts > waiting.ts`）：waiting 后到（比 error 新）仍**立即**压过 error，与 §14.5 稳态 rank 及既有测试语义完全一致；穿透只发生在原死角场景——陈旧 waiting（如无人应答的 approval）+ 之后其它会话的失败。
- 原候选 (b) waiting 30s TTL 被否：聚合以事件自身 ts 判新鲜（防 ghost 终态的既有设计），轮询重放的 waiting 带原始 ts，真实等待中的 approval 会在 30s 后错误地「掉出等待」。
- **测试**：新增 2 例（held waiting + 1s 前的 error → 穿透 → TTL 后自动回 waiting；error 先到 + waiting 后到 → 立即压过且过期后无翻转）；1 例既有用例的 waiting ts 从 40 改为当下时刻以匹配守卫语义。

### E3 physics 卡片关闭丢编辑 — unmount flush

核实：卡片（PhysicsCard.tsx）**早已是每改动 300ms 防抖自动保存**，backlog 的「保存修改按钮/关闭丢弃全部未保存修改/不可拦截前提」是对旧手动保存设计的失效记载。真实缺口仅剩：unmount effect 只 `clearTimeout` 不 flush——关闭发生在最后一次改动后的 300ms 窗口内则丢该次编辑。修复：`pendingDraft` ref 记录排队草稿，unmount 时 timer 挂着则立即 `hub.update(queued)`（fire-and-forget，错误走 hub 既有面）；`resetDefaults` 同步清队。测试 +1（窗口内卸载恰好发一次携带最新值的 PUT）。

### 验证

主仓 47 文件 / **834 用例**全绿（较上一批 +8：A2 6 = 路由 3 / store 2 / UI 1；A5 新增 2，另有 1 例既有用例适配改写不计入），双工程 typecheck 通过；physics 8 文件 / **121 用例**全绿（+1），typecheck 通过。

## Motion Pack 地基包：B2/B10/B3/B1/B6 + C1-A 与工具链（2026-08-28）

用户拍板「开始动工」后的第一个地基批次；两仓推送后实施，主仓三个提交（f99828b 收口批 → bfb3a05 地基包 → 795d233 C1-A+工具链；795d233 是 amend 后的最终哈希，早前笔记误引了被 amend 掉的悬空对象号，2026-08-28 评审发现后订正）。

### 共享写锁（B10 的骨架，host/storage.ts）

`createWriteLock(): WriteLock`——极简 promise 链串行器。四个 store（ConfigStore/AssetStore/AnimationsStore/PetsStore）的 enqueue 全部改走 `options.lock ?? createWriteLock()`：默认私有链（行为与旧的私有 queue 完全一致），`src/index.ts` 与 routes 测试夹具传入**同一把锁**后，跨 store 变更（config 保存 vs 资产删除的引用探测、pet 镜像回写 vs 动画删除）不再交错。**死锁教训（已修）**：pet 镜像 onSaved 原本在 ConfigStore.update 的锁段内调用 `petsStore.saveSlice`（同一把锁排队等自己）——首轮全量测试 182s 超时定位后，把镜像移到锁段释放之后执行；镜像各自携带 slice 载荷、仍排队同锁，乱序完成最终收敛（镜像契约本就是 best-effort、config 权威）。

### B10：引用校验对称 + 单读端点 + 锁内新鲜探测

- poseField 的 assetId 加形状校验（16 hex，与 host 生成规则一致）：strict 记 issue（400 INVALID_CONFIG），repair 降级为无图（fallback 链接管）。
- `GET /api/petween/pets/<id>`：`readPet` 早已有、路由补上（pack 导出单读）。
- asset/animation DELETE 的 `referencedBy` 签名从同步改为 **`Promise<boolean>`**，routes 的探测闭包在 store 串行删除段内**现场读取**最新 config+pets，不再持有请求开始时的过期快照；配合共享锁，探测期间不会有并发写段（读不到半写/撕裂状态）。但注意 pet 镜像刻意滞后于锁释放——镜像落地前探测可能读到过期的 pet 引用，产生**假阳性 409**（安全方向，重试即愈）；这与提交说明「mirror is best-effort」的口径一致。共享锁保证的是探测不读到撕裂状态，不阻止「删除完成后才新增引用」的悬空（后者是 assetId 缺存在性校验的 B11 邻接缺口，运行时 fallback 兜底）。

### B3：config 单调 revision（乐观并发，opt-in）

- 计数持久化在旁车 `config.revision.json`（紧邻 config.json；缺省/损坏 → 0），`ConfigStore.update` 每次成功写后 +1；`revision()` 惰性读缓存。
- `GET /config` 响应加 `revision`；`PUT /config` 接受可选头 `x-petween-expected-revision`：缺省/空 = last-writer-wins 完全不变；携带且过期 → `RevisionMismatchError` → 409 REVISION_MISMATCH（details.currentRevision 供重放）；畸形头 400。PUT 响应也带写后 revision（注意顺序：先 await update 再读 revision，否则并发读到旧值）。
- client：`GetConfigResponse/PutConfigResponse` 增可选 `revision`；`patchConfig(patch, {expectedRevision})` 通管道，现有调用方未启用（行为零变化）。

### B2：`GET /api/petween/meta`

`{apiVersion: 1, configVersion, revision, features}`；features 只增不减清单（config/config.revision/assets/animations/pets/pets.draft/events.sse/meta），client `getMeta()`。

### B1：版本 seam + 未知字段政策

`ANIMATION_DEFINITION_VERSION = 1` 出口；validator 对**更高版本**给出专门错误（"written by a newer petween (this build reads version 1); upgrade the plugin or re-export…"）——PUT 400、loadAll 跳过并带同文案警告，绝不静默误读。未知字段政策定稿：**原样保留、永不解释**（v1 读取器往返新版本动画包不破坏其中新增字段），motion-format.md 顶层结构表下新增政策段。

### B6：命名空间端到端放宽

可存自定义动画 id：`user:` → **任意非 builtin 小写命名空间**（`[a-z][a-z0-9-]*`）。落点：`animation-definition.ts` 导出 `isCustomAnimationId()`（单一语法源）；AnimationsStore（存/读/exists/kindOf/文件名双射保持）；host validation 的挂载 id 校验；client `syncCustomAnimations` 与 overlay-session `syncCustoms` 的过滤改为「非 builtin 即自定义领地」。**伴生插件服务自身**新增显式 user: 限制（store 放宽后 `pack:x` 会漏过服务旧约束）——服务契约不变，companion 仍走 user:/user:<pack>-。编辑器手作动画默认仍是 user:。

### C1-A + 工程配套（C1 的第一段）

- `client/overlay/session-surface.ts`：全部共享契约类型搬家 + 结构化 `PetSessionSurface` 接口（服务不再 import OverlaySession 类——静态环消）+ `fanOutSafely` 单一实现（原先 session/service 各持一份私有拷贝）。extension-service re-export 类型保持公共导入点不变。
- `pnpm test:coverage`（@vitest/coverage-v8，report-only；基线 **90.5% statements / 85.4% branches / 88.6% functions / 94.0% lines**，coverage/ 已入 .gitignore）与 `pnpm run lint`（oxlint 脚手架；存量 10 警告 0 错误，未清）。
- **C1 剩余（B/C 段）显式留待下一轮**：ExtensionSurface 类抽取（playExternal/flash*/driver/五组订阅/探针 + 外部实例/外部 pose/flash 台账/点击 hover 记账；注意 director⇄surface 构造环用 bind 解）与 overlay/preview 双会话 ~100-120 行重复体并入 session-core。拆分主体完成前不开 Motion Pack 本体。

### 验证

主仓 47 文件 / **843 用例**全绿（较上批 +9：meta 1 / revision 3 / pose 形状 1 / GET pet 1 / B1 2 / B6 2），双工程 typecheck 通过；physics 零改动（121 维持全绿）。

## 地基包外部评审跟进批（2026-08-28 第二批）

用户转来对 bfb3a05/795d233/fc3b8fd 三提交的外部评审（结论通过，3 条动工前建议 + 4 条小瑕疵），逐条核实后全部认领并落地：

1. **共享锁并发交错回归测试（评审建议 1，最重要）**：`tests/host/assets.test.ts` 新增 shared WriteLock describe——asset delete 的探测闭包在锁段内被测试侧 gate 挂起，并发的 config.update（引用该资产）**必须等探测放行后才能完成**（断言 `updateFinished === false` 在真实时钟 25ms 后仍成立；退回每 store 私有链或探测移出锁段即红）。注释里写明两个陷阱：①gate 必须测试侧控制——探测等「另一个写完成」会经共享锁自等死锁（与 pet 镜像同构）；②探测闭包内做一次 `config.load()` 锁无关读，若将来读也拿锁，删除段会超时暴露（「读永不拿锁」不变量的回归防护）。
2. **revision 写序翻转为 fail-closed（评审建议 2）**：`ConfigStore.update` 现在**先写 revision 旁车、再写 config.json**——两写之间崩溃只会产生多余的假 409（重试即愈），不再可能出现「计数落后一格 → 过期的 expectedRevision 恰好通过校验」这一 B3 要防的窗口；旁车写失败时 config 也不再出现「已落盘但客户端 500」的分裂。零行为变化（现有调用方无人发期望值），重启持久化测试无需改动。
3. **`AnimationSummary.namespace` 放宽（评审建议 3）**：类型从 `'builtin' | 'user'` 放宽为 `string`（文档化取值 = 'builtin' 或 id 的 ns 段），`listAnimations()` 填真实 ns 段——`motion:*` 不再伪装成 'user'。纯增量兼容（两个历史取值逐字节不变）；核实 physics 零波及（其服务镜像停在旧形状无 listAnimations，设置卡走 HTTP /animations）。extension-service 测试补 `motion:wall-bounce → namespace 'motion'` 断言。
4. **小瑕疵四连**：笔记过时提交号订正（64c5cba → 795d233，并注明订正原因）；`x-petween-expected-revision` 解析收紧为 `/^\d+$/`（'0x10'/'1e2'/'-1' 均补进 400 用例）；`ConfigStore.save()` 补文档注释声明「不 bump revision、不经镜像，业务写必须走 update()」（保持 public——config.test.ts 直调）；B10 段「探测时刻磁盘必然静止」措辞按评审修正为「探测期间无并发写段（不撕裂）+ 镜像滞后可致假阳性 409（安全方向）」。

### 验证

主仓 47 文件 / **844 用例**全绿（+1：共享锁交错；namespace 断言并入既有用例、'0x10' 等为既有用例扩展），双工程 typecheck 通过；physics 零改动。

## C1-B/C 会话拆分主体（2026-08-28 第三批）

评审跟进批之后的 C1 收口；用户拍板「做完提交后开 Motion Pack 本体」。

### C1-B：ExtensionSurface 抽取

- 新 `client/overlay/extension-surface.ts`（764 行）：扩展面全部状态与行为自 OverlaySession 迁入——五组订阅集、externalInstances 播放池、externalPoses 表、flash 台账（flashTimer/flashHold）、activeDriver 租约、点击 detail 与 hover 合帧记账、lastSeenTarget、快照组装（getStageSnapshot）、subscribe*/notify*、flashPose/flashAsset/flashResolvedPose、registerPoses/unregisterPoses、resolvePoseAny、createPositionDriver、playExternal、isPlaying/listAnimations/resyncAnimations、stage pose-swap 桥与 hover 监听的挂/摘。
- `ExtensionSurfaceHost` 结构化接口（stage/registry/hub/director/drag + isDisposed/isStarted/resolveBuiltinPose/positionPx/currentScale/applyExternalPosition/cancelPendingPositionSave/persistPositionNow/awaitPendingUpdate）；OverlaySession 实现之（stage/hub 由 private 放宽为 public readonly，注明「host seam 专用，非消费方 API」）。
- **构造顺序解法**：surface 先建（只做 stage 侧接线，无 director 依赖）→ director 构造（resolvePose/getExternalPoseHold/onPlayback 三个 seam 指向 surface）→ `surface.attachDirector(director)` 二段挂接目标流。surface 对 director 的读取全部惰性（host 字段），构造窗口内无人调用播放面。
- OverlaySession 保留逐字委托（petween/client 窗口形状冻结），dispose 顺序保持 L2 契约：drag.dispose()（'end' 相位经 surface 广播时订阅集仍活）→ surface.dispose() → 会话其余拆卸。
- **保真判据**：844 用例零改动全绿 + typecheck 干净。

### C1-C：session-core 去重

- 新 `client/session-core.ts`（97 行）纯函数集：`adoptConfigFields`（§16.2 七字段就地拷贝）、`collectBootPoses`（§16.3 预载收集去重）、`sameRestingPose`（静止相等）、`effectiveReducedMotion`（§22）、`refreshTargetPose`（编辑后 pose 刷新全流程：等在途 transition 落定 → 按 director target 重解析 → 静止比较 → 预载换图；seq 守卫经 isSuperseded 注入）。
- `custom-animations.ts` 增 `reconcileCustomAnimations`（sync + 变更检测一体，非 builtin 全命名空间）；overlay.syncCustoms 与 preview.updateCustoms 共用——**顺手修掉 preview updateCustoms 残留的 B6 前 `user:` 过滤**（pack 命名空间 customs 的变更检测此前会漏报 refreshAmbient）。
- 行数：overlay-session 1160→624、preview-session 380→360；新增 extension-surface 764 + session-surface 192 + session-core 97。

### 验证

844 用例零改动全绿；typecheck 干净；lint 维持基线 10 警告（拆分自身零新增）；coverage 90.61% statements / 85.41% branches（不低于 90.47/85.39 基线）。
