/**
 * event-normalizer tests (spec §13.1/§13.3): the full session-event →
 * NormalizedAgentEvent mapping table, the tool-name classification (official
 * rc.7 tool names), turn/end reason dispatch, agent status/error events, and
 * the ignored-event surface.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyTool,
  normalizeAgentError,
  normalizeAgentStatus,
  normalizeSessionEvent,
  type RawSessionEvent,
} from '../../src/integration/dsh/event-normalizer'

const SID = 'session-1'
const TS = 1_700_000_000_000

const ev = (type: string, data: unknown): RawSessionEvent => ({ type, time: TS, data })

describe('normalizeSessionEvent (§13.3)', () => {
  it('maps turn/start → turn-start', () => {
    expect(normalizeSessionEvent(SID, ev('turn/start', { turn: 1 }))).toEqual({ type: 'turn-start', sessionId: SID, ts: TS })
  })

  it('maps assistant/chunk reasoning-delta → thinking', () => {
    const event = ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } })
    expect(normalizeSessionEvent(SID, event)).toEqual({ type: 'thinking', sessionId: SID, ts: TS })
  })

  it('ignores text-delta chunks (no working-signal flapping, see module doc)', () => {
    const event = ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } })
    expect(normalizeSessionEvent(SID, event)).toBeNull()
  })

  it.each(['tool-call-delta', 'block-start', 'block-end', 'usage', 'finish'])('ignores assistant/chunk %s', (chunkType) => {
    const event = ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: chunkType, index: 0 } })
    expect(normalizeSessionEvent(SID, event)).toBeNull()
  })

  it('maps tool/call → tool-start with the classified toolKind', () => {
    expect(normalizeSessionEvent(SID, ev('tool/call', { name: 'edit', arguments: '{}' }))).toEqual({
      type: 'tool-start',
      toolKind: 'edit',
      sessionId: SID,
      ts: TS,
    })
    expect(normalizeSessionEvent(SID, ev('tool/call', { name: 'bash', arguments: '{}' }))).toEqual({
      type: 'tool-start',
      toolKind: 'command',
      sessionId: SID,
      ts: TS,
    })
    expect(normalizeSessionEvent(SID, ev('tool/call', { name: 'web_search', arguments: '{}' }))).toEqual({
      type: 'tool-start',
      toolKind: 'other',
      sessionId: SID,
      ts: TS,
    })
  })

  it('maps the ask_user_question tool → waiting (question class)', () => {
    expect(normalizeSessionEvent(SID, ev('tool/call', { name: 'ask_user_question', arguments: '{}' }))).toEqual({
      type: 'waiting',
      sessionId: SID,
      ts: TS,
    })
  })

  it('maps tool/result → tool-end', () => {
    expect(normalizeSessionEvent(SID, ev('tool/result', { message: {} }))).toEqual({ type: 'tool-end', sessionId: SID, ts: TS })
  })

  it('maps approval/asked → waiting and approval/decided → thinking (turn resumes)', () => {
    expect(normalizeSessionEvent(SID, ev('approval/asked', { id: 'a1', toolName: 'bash' }))).toEqual({
      type: 'waiting',
      sessionId: SID,
      ts: TS,
    })
    expect(normalizeSessionEvent(SID, ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }))).toEqual({
      type: 'thinking',
      sessionId: SID,
      ts: TS,
    })
  })

  it.each([
    ['completed', 'success'],
    ['error', 'error'],
    ['max-tokens', 'error'],
    ['aborted', 'idle'],
    ['interrupted', 'idle'],
    ['blocked', 'waiting'],
  ] as const)('maps turn/end reason %s → %s', (kind, expected) => {
    const reason = kind === 'aborted' ? { kind, reason: { kind: 'user' } } : kind === 'error' ? { kind, error: { message: 'x' } } : { kind }
    expect(normalizeSessionEvent(SID, ev('turn/end', { turn: 1, reason }))).toEqual({ type: expected, sessionId: SID, ts: TS })
  })

  it('ignores an unknown (merge-extended) turn/end reason kind', () => {
    expect(normalizeSessionEvent(SID, ev('turn/end', { turn: 1, reason: { kind: 'some-future-kind' } }))).toBeNull()
  })

  it.each([
    'step/start',
    'step/end',
    'user/message',
    'assistant/message',
    'todo/write',
    'request/header',
    'session/title',
    'llm/retry',
    'command/run',
    'command/done',
    'session/end-seed',
  ])('ignores %s', (type) => {
    expect(normalizeSessionEvent(SID, ev(type, {}))).toBeNull()
  })

  it('tolerates missing data payloads', () => {
    expect(normalizeSessionEvent(SID, ev('assistant/chunk', undefined))).toBeNull()
    expect(normalizeSessionEvent(SID, ev('turn/end', undefined))).toBeNull()
  })
})

describe('classifyTool (official rc.7 tool names)', () => {
  it.each(['edit', 'write', 'str_replace_editor'])('file-mutating %s → edit', (name) => {
    expect(classifyTool(name)).toBe('edit')
  })

  it.each(['bash', 'pwsh'])('shell %s → command', (name) => {
    expect(classifyTool(name)).toBe('command')
  })

  it.each(['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'todo_write', 'skill', 'subagent', 'list_agents'])(
    '%s → other',
    (name) => {
      expect(classifyTool(name)).toBe('other')
    },
  )
})

describe('agent events (dsh-agent cordis events)', () => {
  it('maps agent/status idle → idle, ignores running', () => {
    expect(normalizeAgentStatus(SID, 'idle')).toEqual({ type: 'idle', sessionId: SID, ts: expect.any(Number) })
    expect(normalizeAgentStatus(SID, 'running')).toBeNull()
  })

  it('maps agent/error → error', () => {
    expect(normalizeAgentError(SID)).toEqual({ type: 'error', sessionId: SID, ts: expect.any(Number) })
  })
})
