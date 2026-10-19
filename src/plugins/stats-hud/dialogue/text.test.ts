import { describe, expect, it } from 'vitest';
import { DIALOGUE_MAX_CHARS, isSafeSessionId, truncatePreview } from './text';
import { isPathUnder, normalizeAbsolute } from './paths';

describe('truncatePreview', () => {
  it('collapses whitespace to a single line', () => {
    expect(truncatePreview('a\n\n  b')).toBe('a b');
  });

  it('truncates with an ellipsis within the limit', () => {
    const cut = truncatePreview('x'.repeat(300));
    expect(cut.length).toBeLessThanOrEqual(DIALOGUE_MAX_CHARS);
    expect(cut.endsWith('…')).toBe(true);
    expect(truncatePreview('x'.repeat(20), 10)).toBe('xxxxxxxxx…');
  });

  it('strips markdown markers', () => {
    expect(truncatePreview('# 标题\n**加粗** 和 `code` [链接](http://x) ```\nblock\n``` 完')).toBe('标题 加粗 和 code 链接 完');
  });
});

describe('isSafeSessionId', () => {
  it('accepts ids and rejects traversal', () => {
    expect(isSafeSessionId('7fb28543-52c9')).toBe(true);
    expect(isSafeSessionId('../escape')).toBe(false);
    expect(isSafeSessionId('')).toBe(false);
  });
});

describe('paths', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizeAbsolute('C:\\a\\b\\..\\c')).toBe('C:/a/c');
    expect(normalizeAbsolute('relative/x')).toBeNull();
  });

  it('isPathUnder is strict, case-insensitive and traversal-proof', () => {
    const root = 'C:\\Users\\me\\.claude\\projects';
    expect(isPathUnder(root, 'c:/users/me/.claude/projects/p/s.jsonl')).toBe(true);
    expect(isPathUnder(root, root)).toBe(false);
    expect(isPathUnder(root, 'C:\\Users\\me\\.claude\\projects-evil\\s.jsonl')).toBe(false);
    expect(isPathUnder(root, 'C:\\Users\\me\\.claude\\projects\\..\\..\\x.jsonl')).toBe(false);
    expect(isPathUnder(root, '\\\\server\\share\\projects\\x.jsonl')).toBe(false);
    expect(isPathUnder(root, '')).toBe(false);
  });
});
