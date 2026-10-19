import { describe, expect, it } from 'vitest';
import { isCodexRolloutPath, isRolloutFileFor, lastReply } from './codex';

const SESSION = '01a0a8d1-7933-7963-97b6-8e5e1e3047bc';

const metaLine = (): string =>
  JSON.stringify({ timestamp: '2026-09-20T10:00:00Z', ordinal: 0, type: 'session_meta', payload: { id: SESSION } });

const responseLine = (role: string, ordinal: number): string =>
  JSON.stringify({ type: 'response_item', ordinal, payload: { type: 'message', role, content: [{ type: 'input_text', text: 'x'.repeat(5000) }] } });

const taskCompleteLine = (turnId: string, message: string, ordinal: number, error?: unknown): string =>
  JSON.stringify({
    timestamp: '2026-09-20T10:00:02Z',
    ordinal,
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turnId, last_agent_message: message, error: error ?? null, duration_ms: 5000 },
  });

describe('codex lastReply', () => {
  it('picks the LAST task_complete with a non-empty message and its turn_id', () => {
    const reply = lastReply([
      metaLine(),
      responseLine('user', 1),
      taskCompleteLine('turn_1', '第一轮回复。', 2),
      responseLine('user', 3),
      taskCompleteLine('turn_2', '第二轮回复，带 **加粗**。', 4),
    ]);
    expect(reply).toEqual({ turnId: 'turn_2', text: '第二轮回复，带 **加粗**。' });
  });

  it('skips errored task_completes and empty messages; tolerates junk lines', () => {
    const reply = lastReply([
      taskCompleteLine('turn_bad', '出错了', 1, 'rate_limited'),
      taskCompleteLine('turn_empty', '', 2),
      '{ broken',
      'null',
      taskCompleteLine('turn_ok', '好的回复', 3),
    ]);
    expect(reply).toEqual({ turnId: 'turn_ok', text: '好的回复' });
  });

  it('returns null with no usable task_complete', () => {
    expect(lastReply([metaLine(), responseLine('assistant', 1)])).toBeNull();
  });

  it('works when the tail starts mid-turn (no session_meta, leading response items)', () => {
    expect(lastReply([responseLine('assistant', 7), taskCompleteLine('turn_7', '尾部回复', 8)])).toEqual({
      turnId: 'turn_7',
      text: '尾部回复',
    });
  });

  it('skips an oversized line', () => {
    const huge = taskCompleteLine('turn_big', 'y'.repeat(5 * 1024 * 1024), 9);
    expect(lastReply([taskCompleteLine('turn_1', 'ok', 1), huge])).toEqual({ turnId: 'turn_1', text: 'ok' });
  });

  it('prefers the requested turn and returns null when it is absent', () => {
    const lines = [taskCompleteLine('turn_1', 'first', 1), taskCompleteLine('turn_2', 'second', 2)];
    expect(lastReply(lines, 'turn_1')).toEqual({ turnId: 'turn_1', text: 'first' });
    expect(lastReply(lines, 'turn_9')).toBeNull();
  });
});

describe('codex path helpers', () => {
  const codexDir = 'C:\\Users\\me\\.codex';
  const file = `${codexDir}\\sessions\\2026\\09\\20\\rollout-2026-09-20T10-00-00-${SESSION}.jsonl`;

  it('accepts only rollout paths under <codexDir>/sessions', () => {
    expect(isCodexRolloutPath(codexDir, file)).toBe(true);
    expect(isCodexRolloutPath(codexDir, file.toLowerCase())).toBe(true);
    expect(isCodexRolloutPath(codexDir, 'C:/Windows/system32/config.json')).toBe(false);
    expect(isCodexRolloutPath(codexDir, file.replace('sessions', 'elsewhere'))).toBe(false);
    expect(isCodexRolloutPath(codexDir, file.replace('sessions', 'sessions-evil'))).toBe(false);
    expect(isCodexRolloutPath(codexDir, `${file}\\..\\..\\..\\..\\..\\Windows\\win.ini`)).toBe(false);
    expect(isCodexRolloutPath(codexDir, '\\server\\share\\sessions\\x.jsonl')).toBe(false);
  });

  it('matches rollout file names by session suffix', () => {
    expect(isRolloutFileFor(`rollout-2026-09-20T10-00-00-${SESSION}.jsonl`, SESSION)).toBe(true);
    expect(isRolloutFileFor('rollout-x-other.jsonl', SESSION)).toBe(false);
    expect(isRolloutFileFor('rollout-x-..jsonl', '../')).toBe(false);
  });
});
