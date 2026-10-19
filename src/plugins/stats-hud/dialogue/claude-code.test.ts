import { describe, expect, it } from 'vitest';
import { isCcTranscriptPath, lastReply, transcriptFileName } from './claude-code';

const SESSION = '7fb28543-52c9-4880-a328-dd2dff79d447';

const userLine = (promptId: string, uuid: string, text = 'hi'): string =>
  JSON.stringify({ type: 'user', uuid, parentUuid: null, isSidechain: false, promptId, message: { role: 'user', content: text } });

const assistantLine = (uuid: string, parentUuid: string, blocks: Array<{ type: string; text?: string }>): string =>
  JSON.stringify({ type: 'assistant', uuid, parentUuid, isSidechain: false, message: { role: 'assistant', content: blocks } });

describe('claude-code lastReply', () => {
  it('recovers the promptId via the parentUuid chain from the last text-bearing assistant', () => {
    const reply = lastReply([
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId: SESSION }), // noise line
      userLine('prompt_1', 'u1'),
      assistantLine('a1', 'u1', [{ type: 'thinking' }]),
      assistantLine('a2', 'a1', [{ type: 'tool_use' }]),
      assistantLine('a3', 'a2', [{ type: 'text', text: '修好了。' }]),
    ]);
    expect(reply).toEqual({ turnId: 'prompt_1', text: '修好了。' });
  });

  it('picks the LAST assistant with text (mid-turn commentary is not the reply)', () => {
    const reply = lastReply([
      userLine('prompt_1', 'u1'),
      assistantLine('a1', 'u1', [{ type: 'text', text: '我先看看文件。' }]),
      assistantLine('a2', 'a1', [{ type: 'tool_use' }]),
      assistantLine('a3', 'a2', [{ type: 'text', text: '完成：已修复 A。' }]),
    ]);
    expect(reply?.text).toBe('完成：已修复 A。');
  });

  it('joins multiple text blocks and follows the chain across hops', () => {
    const reply = lastReply([
      userLine('prompt_9', 'u9'),
      assistantLine('a1', 'u9', [{ type: 'tool_use' }]),
      assistantLine('a2', 'a1', [{ type: 'text', text: '第一段。' }, { type: 'text', text: '第二段。' }]),
    ]);
    expect(reply).toEqual({ turnId: 'prompt_9', text: '第一段。\n第二段。' });
  });

  it('excludes sidechain (subagent) assistants and API-error entries', () => {
    const reply = lastReply([
      userLine('prompt_1', 'u1'),
      JSON.stringify({ type: 'assistant', uuid: 's1', parentUuid: 'u1', isSidechain: true, message: { content: [{ type: 'text', text: '子代理私货' }] } }),
      JSON.stringify({ type: 'assistant', uuid: 'e1', parentUuid: 'u1', isSidechain: false, isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API error' }] } }),
      assistantLine('a1', 'u1', [{ type: 'text', text: '正主回复' }]),
    ]);
    expect(reply?.text).toBe('正主回复');
  });

  it('returns null without any text-bearing assistant; skips malformed/oversized lines', () => {
    expect(lastReply([userLine('p', 'u1'), assistantLine('a1', 'u1', [{ type: 'tool_use' }])])).toBeNull();
    expect(lastReply(['{ broken', '', 'null', 'x'.repeat(5 * 1024 * 1024)])).toBeNull();
  });

  it('turnId is null when the chain never reaches a promptId user line', () => {
    expect(lastReply([assistantLine('a1', 'orphan', [{ type: 'text', text: '无主回复' }])])).toEqual({
      turnId: null,
      text: '无主回复',
    });
  });

  it('tail starting mid-turn: reply kept with null turnId, later turn still resolves', () => {
    // The user line of turn 1 was cut off by the tail window.
    const midTurn = [
      assistantLine('a2', 'a1-cut', [{ type: 'text', text: '尾部回复' }]),
    ];
    expect(lastReply(midTurn)).toEqual({ turnId: null, text: '尾部回复' });
    const twoTurns = [...midTurn, userLine('prompt_2', 'u2'), assistantLine('a3', 'u2', [{ type: 'text', text: '新一轮' }])];
    expect(lastReply(twoTurns)).toEqual({ turnId: 'prompt_2', text: '新一轮' });
  });

  it('survives a cyclic parent chain', () => {
    const a = JSON.stringify({ type: 'assistant', uuid: 'c1', parentUuid: 'c2', message: { content: [{ type: 'text', text: '环' }] } });
    const b = JSON.stringify({ type: 'assistant', uuid: 'c2', parentUuid: 'c1', message: { content: [{ type: 'tool_use' }] } });
    expect(lastReply([a, b])).toEqual({ turnId: null, text: '环' });
  });

  it('prefers the requested turn (earlier reply) and returns null when absent from the tail', () => {
    const lines = [
      userLine('prompt_1', 'u1'),
      assistantLine('a1', 'u1', [{ type: 'text', text: '第一轮' }]),
      userLine('prompt_2', 'u2'),
      assistantLine('a2', 'u2', [{ type: 'text', text: '第二轮' }]),
    ];
    expect(lastReply(lines, 'prompt_1')).toEqual({ turnId: 'prompt_1', text: '第一轮' });
    expect(lastReply(lines, 'prompt_2')?.text).toBe('第二轮');
    expect(lastReply(lines, 'prompt_3')).toBeNull();
  });
});

describe('claude-code path helpers', () => {
  const claudeDir = 'C:\\Users\\me\\.claude';
  const file = `${claudeDir}\\projects\\D--proj\\${SESSION}.jsonl`;

  it('accepts only transcript paths under <claudeDir>/projects', () => {
    expect(isCcTranscriptPath(claudeDir, file)).toBe(true);
    expect(isCcTranscriptPath(claudeDir, file.replace(/^C/, 'c'))).toBe(true);
    expect(isCcTranscriptPath(claudeDir, 'C:/Windows/system32/config.json')).toBe(false);
    expect(isCcTranscriptPath(claudeDir, file.replace('projects', 'elsewhere-projects'))).toBe(false);
    expect(isCcTranscriptPath(claudeDir, file.replace('projects', 'projects-evil'))).toBe(false);
    expect(isCcTranscriptPath(claudeDir, `${file}/../../../../Windows/win.ini`)).toBe(false);
    expect(isCcTranscriptPath(claudeDir, String.raw`\\server\share\projects\x.jsonl`)).toBe(false);
    expect(isCcTranscriptPath(claudeDir, '')).toBe(false);
  });

  it('builds the transcript file name', () => {
    expect(transcriptFileName(SESSION)).toBe(`${SESSION}.jsonl`);
    expect(transcriptFileName('../x')).toBeNull();
  });
});
