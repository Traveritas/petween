// zcode reply source. zcode persists every model call as a JSONL line in
// `<zcode cli dir>/rollout/model-io-<sessionId>.jsonl` (AI-SDK shape:
// {type:'model_io', turnId, response:{finishReason, text, toolCalls, usage}}).
// The hook's temp transcript copy is deleted right after the hook returns, so the rollout is the durable source.
// One model_io line embeds the whole request context (>1 MB on long sessions); a tail may hold
// few or no stop lines, in which case the caller simply gets null.

import { isSafeSessionId, MAX_LINE_CHARS, type LastReply } from './text';

/** Rollout file name for a session, or null when the id could escape the rollout dir. */
export function rolloutFileName(sessionId: string): string | null {
  return isSafeSessionId(sessionId) ? `model-io-${sessionId}.jsonl` : null;
}

/**
 * Last completed reply (finishReason 'stop', non-empty text, no tool calls) in the tail lines.
 * With `turnId`, only that turn's replies count. Unparseable lines are skipped (the writer may be mid-append).
 */
export function lastReply(lines: string[], turnId?: string): LastReply | null {
  let best: LastReply | null = null;
  for (const line of lines) {
    // Cheap pre-filter: giant non-stop lines never pay a JSON.parse.
    if (line.length > MAX_LINE_CHARS || !line.includes('"stop"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as { type?: unknown; turnId?: unknown; response?: unknown };
    if (record.type !== 'model_io') continue;
    const response = record.response;
    if (typeof response !== 'object' || response === null) continue;
    const { finishReason, text, toolCalls } = response as { finishReason?: unknown; text?: unknown; toolCalls?: unknown };
    if (finishReason !== 'stop') continue;
    if (typeof text !== 'string' || text.trim() === '') continue;
    // A reply followed by tool calls is mid-turn reasoning, not the answer.
    if (Array.isArray(toolCalls) && toolCalls.length > 0) continue;
    const id = typeof record.turnId === 'string' ? record.turnId : null;
    if (turnId !== undefined && id !== turnId) continue;
    best = { turnId: id, text: text.trim() };
  }
  return best;
}
