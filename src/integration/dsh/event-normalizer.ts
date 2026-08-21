/**
 * integration/dsh/event-normalizer.ts — raw DSH session/agent events →
 * NormalizedAgentEvent (spec §13.1 contract, §13.3 mapping, M0 §4 verified
 * vocabulary). Pure functions; with host/state-channel.ts this is the only
 * place that knows the DSH event names (spec §3.2: core/motion/client never
 * see raw DSH concepts).
 *
 * Verified against @deepseek-ai/dsh@0.1.0-rc.7:
 * - SessionEvent envelope is `{ type, seq, time, data }` (dsh-session
 *   types.d.ts); `time` is unix epoch ms.
 * - `turn/end` reason kinds: completed / aborted / blocked / error /
 *   max-tokens / interrupted (dsh-session TurnEndReasonMap).
 * - `assistant/chunk` carries a dsh-llm StreamChunk (`reasoning-delta` /
 *   `text-delta` / `tool-call-delta` / block markers / usage / finish).
 * - `tool/call { name, arguments }` / `tool/result` (dsh-session).
 * - `approval/asked` / `approval/decided` are dsh-user-approval's
 *   SessionEventMap merge; `agent/status { agent, status }` / `agent/error`
 *   are dsh-agent cordis events. None of those packages is a devDependency,
 *   so the input below is a structural envelope instead of the base
 *   SessionEvent union (which would not even name the merged types here).
 */
// The `/types` subpath (not the package root) on purpose: the root index.d.ts
// augments cordis `Context` with the HOST-side `sessions: SessionStore`, which
// would collide with the client runtime's `sessions: ISessions` merge inside
// this repo's single combined tsc program.
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import type { NormalizedAgentEvent } from './state-protocol'

export type { NormalizedAgentEvent } from './state-protocol'

/**
 * Minimal structural session-event envelope. Wider than the devDep's base
 * `SessionEvent` union on purpose: production merges (approval/*, command/*)
 * are absent from the local types but present at runtime.
 */
export interface RawSessionEvent {
  type: string
  time: number
  data: unknown
}

/**
 * Tool name → toolKind. Names are the registered `name:` literals in the
 * installed rc.7 tool packages (grep `name: "` in each package's lib/index.js):
 * - edit:    `edit`, `write` (dsh-tool-fs), `str_replace_editor`
 *            (dsh-tool-str-replace-editor) — file-mutating tools (§13.3 coding)
 * - command: `bash` (dsh-tool-bash / dsh-tool-bash-persistent), `pwsh`
 *            (dsh-tool-pwsh) — shell execution (§13.3 command)
 * - other:   everything else — `read`/`read_image` (dsh-tool-fs),
 *            `glob`/`grep` (dsh-tool-fs-search), `web_search`/`web_fetch`
 *            (dsh-tool-web), `todo_write`, `skill`, `job_*`, `*_goal`,
 *            `subagent` (configurable, dsh-tool-subagent), … (§13.3 working)
 */
const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'str_replace_editor'])
const COMMAND_TOOLS: ReadonlySet<string> = new Set(['bash', 'pwsh'])

/** dsh-tool-ask-user: the model asking the human a question → WAITING. */
const ASK_USER_QUESTION_TOOL = 'ask_user_question'

export function classifyTool(name: string): 'edit' | 'command' | 'other' {
  if (EDIT_TOOLS.has(name)) return 'edit'
  if (COMMAND_TOOLS.has(name)) return 'command'
  return 'other'
}

/**
 * One session event → one normalized event, or null when the event carries
 * no visual meaning (step markers, messages, chunk book-keeping, …).
 *
 * Deliberate mapping choices (beyond the §13.3 table):
 * - `text-delta` chunks are IGNORED, not mapped to a working signal: during
 *   mixed reasoning/text streaming that would flap the activity every
 *   coalescing window (ambient restart per flip), which §15 exists to prevent.
 *   The thinking face persists through the whole model step.
 * - `tool-end` → `thinking` happens adapter-side (NormalizedAgentEvent keeps
 *   the explicit tool boundary); after a tool the agent returns to reasoning.
 * - `approval/decided` → `thinking`: the user answered, the turn resumes.
 * - `max-tokens` → `error`: the turn ended abnormally (§13.3 has no row; the
 *   task table fixes completed/error/aborted/interrupted/blocked only).
 *   Merge-extended unknown reason kinds are ignored (null).
 */
export function normalizeSessionEvent(sessionId: string, event: RawSessionEvent): NormalizedAgentEvent | null {
  const ts = event.time
  switch (event.type) {
    case 'turn/start':
      return { type: 'turn-start', sessionId, ts }
    case 'assistant/chunk': {
      const chunk = (event.data as { chunk?: { type?: string } } | undefined)?.chunk
      return chunk?.type === 'reasoning-delta' ? { type: 'thinking', sessionId, ts } : null
    }
    case 'tool/call': {
      const name = (event.data as { name?: string } | undefined)?.name ?? ''
      if (name === ASK_USER_QUESTION_TOOL) return { type: 'waiting', sessionId, ts }
      return { type: 'tool-start', toolKind: classifyTool(name), sessionId, ts }
    }
    case 'tool/result':
      return { type: 'tool-end', sessionId, ts }
    case 'approval/asked':
      return { type: 'waiting', sessionId, ts }
    case 'approval/decided':
      return { type: 'thinking', sessionId, ts }
    case 'turn/end': {
      const reason = (event.data as { reason: TurnEndReason } | undefined)?.reason
      switch (reason?.kind) {
        case 'completed':
          return { type: 'success', sessionId, ts }
        case 'error':
        case 'max-tokens':
          return { type: 'error', sessionId, ts }
        case 'aborted':
        case 'interrupted':
          return { type: 'idle', sessionId, ts }
        case 'blocked':
          return { type: 'waiting', sessionId, ts }
        default:
          return null
      }
    }
    default:
      return null
  }
}

/**
 * `agent/status` cordis event (dsh-agent): only the `idle` transition maps —
 * `running` covers pre-step processing and is followed by `turn/start`, which
 * owns the active face. `sessionId` is `agent.id` (the shared identity).
 */
export function normalizeAgentStatus(sessionId: string, status: string): NormalizedAgentEvent | null {
  return status === 'idle' ? { type: 'idle', sessionId, ts: Date.now() } : null
}

/** `agent/error` cordis event (dsh-agent): a surfaced turn failure → error. */
export function normalizeAgentError(sessionId: string): NormalizedAgentEvent {
  return { type: 'error', sessionId, ts: Date.now() }
}
