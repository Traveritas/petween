# 05 · Agent 信号

> 状态：已定（2026-10-19）

## 1. 链路

```
Agent CLI（Claude Code / Codex / …）
   │ hook：petween.exe --hook <connectorId> e=<kind>（读 stdin，POST 127.0.0.1:<port>/hook/<connectorId>?e=<kind>）
   ▼
宿主（Rust）：不解析，原样转发 { connectorId, query, headers 子集, body, receivedAt }
   ▼
connector 插件（运行时）：解析 → 归一化
   ▼
AgentEvent（事件总线主题 agent.event）
   ▼
会话表（内核）→ 绑定规则 → 每只宠物的大脑
```

### 1.1 hook 命令：程序自己当转发器

所有内置 connector 写进 agent 配置的 hook 命令都是 **Petween 自己的可执行文件**：`petween.exe --hook <connectorId> e=<kind>`（`host.hookCommand()` 给出当前路径）。它读完 stdin、从 `<app data>/hook-port` 读端口、POST 给宿主、不打印任何东西、总是 0 退出、最多 2.5 秒。

为什么不用 v0 的 curl / node：curl.exe 在 Codex 的 Windows hook 运行器里「读 stdin + 联网」会失败；node 不一定装了；PowerShell 下 `@file` 会被当成 splatting（docs/08）。自己的 exe 三个问题都没有，还省掉了每次启动重写端口的 cfg 文件。转发器不解析内容，仍然满足「宿主不懂 agent 格式」。

connector 启动时检查已安装的 hook 是否指向当前 exe，不是就自动重写（程序搬家或升级后不会失联）。

## 2. 归一化事件

```ts
interface AgentEvent {
  agent: string              // 'claude-code' | 'codex' | 插件自定义
  sessionId: string          // connector 负责保证同一会话稳定
  at: number                 // epoch ms；源没有就用到达时间
  type:
    | 'session-start' | 'session-end'
    | 'turn-start'                       // 用户提交了输入
    | 'thinking'
    | 'tool-start' | 'tool-end'
    | 'waiting'                          // 等用户：权限请求、提问
    | 'turn-end'
  tool?: {
    name: string             // 原始工具名：Bash / Edit / apply_patch / …
    kind: 'edit' | 'command' | 'read' | 'search' | 'web' | 'other'
    ok?: boolean             // tool-end 时
  }
  outcome?: 'success' | 'error' | 'interrupted'   // turn-end 时
  /** connector 附带的原始信息（工作目录、transcript 路径、改动行数……），插件可读 */
  extra?: Record<string, unknown>
}
```

- `tool.name` **保留原名**，`tool.kind` 供粗粒度使用。不同 agent 的同类工具（Bash / shell / exec_command）由 connector 映射到相同的 `kind`，名字不改。
- v0 的 connector 曾伪造工具名（`'bash'` / `'edit'`），新设计禁止。

### 2.1 `extra` 的约定字段（内置 connector 都会填，第三方 connector 尽量照做）

| 字段 | 类型 | 何时有 | 用途 |
|---|---|---|---|
| `turnId` | string | 源提供时（CC `prompt_id`、Codex `turn_id`） | 统计按回合归并 |
| `toolInput` | unknown | tool-start / tool-end | 原样的工具参数（统计改动行数等） |
| `transcriptPath` | string | 源提供时 | 读对话记录（回复摘要） |
| `cwd` | string | 源提供时 | 工作目录 |
| `hookEvent` | string | 总是 | 源事件的原名（`PreToolUse`…），调试用 |
| `synthetic` | `watchdog` | 内核会话表合成的事件 | 见 §3.1 |

## 3. connector 插件的职责

| 职责 | 说明 |
|---|---|
| 安装 / 卸载 hook | 改写对应 agent 的配置文件（需 fs 权限）；必须可逆，卸载时只删自己加的条目 |
| 解析 | 原始请求 → `AgentEvent[]`（一个请求可产生 0 到多个事件） |
| 会话卫生 | 声明超时策略：多久没事件算会话结束、`waiting` 多久没回应视为失效 |
| 状态面板 | 向设置页报告：是否已安装、最近一次事件时间、活跃会话数 |

超时与 watchdog 的通用逻辑（v0 `hook-connector.ts` 的 idle 衰减、滞留权限、闲置清理）放在内核的会话表里，connector 只提供参数。

### 3.1 会话表的 watchdog（内核）

connector 用 `session` 字段声明参数（缺省值来自 v0）：

| 参数 | 缺省 | 到点后内核做什么 |
|---|---|---|
| `waitingTimeoutMs` | 600000 | `waiting` 后一直没有新事件 → 合成 `turn-end`（outcome `interrupted`） |
| `disposeAfterMs` | 1800000 | 会话完全没有事件 → 合成 `session-end` |

合成事件带 `extra.synthetic = watchdog`，和真实事件走同一条路（会话表 → 绑定 → 大脑，也广播给插件）。

## 4. 默认大脑

输入：绑定到该宠物的所有会话的 `AgentEvent`。输出：一个状态键（作为 `state` 通道优先级 0 的意图）。

### 4.1 稳定化规则（从 v0 `pet-state-resolver.ts` 移植，连同测试）

- **合并窗口**：60ms 尾沿合并，最长 200ms 强制提交，一串密集事件只产生一次变化。
- **相同状态去重**：同一状态键不重复输出。
- **终态保持**：`success` / `error` 保持 N 秒（可配）或保持到用户点击；保持期间丢弃杂散的 idle。
- **终态后的杂散 idle**：turn-end 之后紧跟的 idle 不打断终态。

### 4.2 状态键派生

| 条件 | 状态键 |
|---|---|
| 无活跃回合 | `idle`；持续超过 `idleLongMs`（默认 5 分钟） → `idle.long` |
| turn-start / thinking | `active.thinking` |
| tool-start，kind=edit | `active.edit` |
| tool-start，kind=command | `active.command.<tool.name>` |
| tool-start，其他 | `active.other` |
| waiting | `waiting` |
| turn-end success | `success` |
| turn-end error | `error` |
| turn-end interrupted | `idle` |

宠物包没配的键按 04 §4 回退，因此只配了 `active` 的宠物包看到的效果和 v0 一样。

### 4.3 多会话合并（一只宠物绑定多个会话时）

取「最需要关注」的会话的状态：`waiting` > `error` > `active.*` > `success` > `idle`。同级取最近有事件的会话。

## 5. 绑定规则

| 规则 | 行为 |
|---|---|
| `single`（默认） | 所有会话 → 用户的主宠物 |
| `perSession` | 每个新会话生成一只宠物（从用户选定的宠物包池里挑），会话结束后宠物走开/消失（动画由插件或宠物包决定） |

绑定规则也是注册表（`bindingRules`），插件可以加「按 agent 分」「按工作目录分」等。

v0 的「跟随模式」（只让用户最近操作过的会话驱动宠物）改为**默认大脑的合并策略** `followFocus`：只看最近有 `session-start` / `turn-start` 的那个会话（§4.3 的另一种合并法），不在绑定层过滤事件。

## 6. 其他插件怎么用信号

- 订阅原始事件：`ctx.agent.on('event', e => …)`，例如统计 HUD 数改动行数。
- 订阅某只宠物的派生结果：`pet.on('stateKey', key => …)`。
- 读会话表：`ctx.agent.sessions()`。
