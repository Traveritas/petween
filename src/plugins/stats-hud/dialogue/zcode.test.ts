import { describe, expect, it } from 'vitest';
import { lastReply, rolloutFileName } from './zcode';

const modelIo = (response: Record<string, unknown>, turnId = 'turn_1'): string =>
  JSON.stringify({ type: 'model_io', turnId, response });

describe('zcode lastReply', () => {
  it('picks the last completed reply without tool calls', () => {
    const lines = [
      modelIo({ finishReason: 'tool-calls', text: 'thinking aloud', toolCalls: [{ id: 't' }] }),
      modelIo({ finishReason: 'stop', text: 'intermediate summary', toolCalls: [{ id: 't2' }] }),
      modelIo({ finishReason: 'stop', text: 'All done: the fix landed.' }),
      'not json at all {',
    ];
    expect(lastReply(lines)).toEqual({ turnId: 'turn_1', text: 'All done: the fix landed.' });
  });

  it('returns null without any completed reply', () => {
    expect(lastReply([modelIo({ finishReason: 'length', text: 'partial' })])).toBeNull();
    expect(lastReply([''])).toBeNull();
    expect(lastReply([])).toBeNull();
  });

  it('ignores non-model_io lines and blank text', () => {
    expect(lastReply([JSON.stringify({ type: 'other', response: { finishReason: 'stop', text: 'x' } })])).toBeNull();
    expect(lastReply([modelIo({ finishReason: 'stop', text: '   ' })])).toBeNull();
  });

  it('works when the tail starts mid-conversation (only a later turn present)', () => {
    expect(lastReply([modelIo({ finishReason: 'stop', text: '后半段回复' }, 'turn_9')])).toEqual({
      turnId: 'turn_9',
      text: '后半段回复',
    });
  });

  it('skips an oversized line and keeps the earlier reply', () => {
    const huge = modelIo({ finishReason: 'stop', text: 'x'.repeat(5 * 1024 * 1024) });
    expect(lastReply([modelIo({ finishReason: 'stop', text: 'ok' }), huge])).toEqual({ turnId: 'turn_1', text: 'ok' });
  });

  it('prefers the requested turn and returns null when it is absent', () => {
    const lines = [
      modelIo({ finishReason: 'stop', text: 'first' }, 'turn_1'),
      modelIo({ finishReason: 'stop', text: 'second' }, 'turn_2'),
    ];
    expect(lastReply(lines, 'turn_1')).toEqual({ turnId: 'turn_1', text: 'first' });
    expect(lastReply(lines, 'turn_3')).toBeNull();
  });
});

describe('rolloutFileName', () => {
  it('builds the model-io name and rejects unsafe ids', () => {
    expect(rolloutFileName('s1')).toBe('model-io-s1.jsonl');
    expect(rolloutFileName('../escape')).toBeNull();
  });
});
