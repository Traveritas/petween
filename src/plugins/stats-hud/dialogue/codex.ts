// Codex reply source. Codex persists each session as a rollout JSONL at
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<sessionId>.jsonl; hook payloads carry the path.
// Lines are {timestamp, ordinal, type, payload}. `event_msg` with payload.type === 'task_complete'
// carries both `turn_id` and `last_agent_message`, so no chain walking is needed.

import { isPathUnder } from './paths';
import { isSafeSessionId, MAX_LINE_CHARS, type LastReply } from './text';

/** True when `path` lies inside `<codexDir>/sessions` (the only place rollouts may be read from). */
export function isCodexRolloutPath(codexDir: string, path: string): boolean {
  return isPathUnder(`${codexDir.replace(/[\\/]+$/, '')}/sessions`, path);
}

/** Rollout file names end with the session uuid. */
export function isRolloutFileFor(fileName: string, sessionId: string): boolean {
  return isSafeSessionId(sessionId) && fileName.endsWith(`-${sessionId}.jsonl`);
}

/** Last task_complete with a non-empty message and no error. With `turnId`, only that turn counts. */
export function lastReply(lines: string[], turnId?: string): LastReply | null {
  let best: LastReply | null = null;
  for (const raw of lines) {
    if (raw.length > MAX_LINE_CHARS || !raw.includes('"task_complete"')) continue;
    let line: { type?: unknown; payload?: unknown } | null;
    try {
      line = JSON.parse(raw.trim()) as { type?: unknown; payload?: unknown } | null;
    } catch {
      continue; // mid-append
    }
    if (line === null || typeof line !== 'object' || line.type !== 'event_msg') continue;
    const payload = line.payload;
    if (typeof payload !== 'object' || payload === null) continue;
    const record = payload as { type?: unknown; turn_id?: unknown; last_agent_message?: unknown; error?: unknown };
    if (record.type !== 'task_complete') continue;
    if (typeof record.last_agent_message !== 'string' || record.last_agent_message.trim() === '') continue;
    if (record.error !== null && record.error !== undefined) continue;
    const id = typeof record.turn_id === 'string' ? record.turn_id : null;
    if (turnId !== undefined && id !== turnId) continue;
    best = { turnId: id, text: record.last_agent_message.trim() };
  }
  return best;
}
