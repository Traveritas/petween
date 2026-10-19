/**
 * line-count: tool input → line counts (the privacy boundary — everything
 * downstream only ever sees integers). Covers Claude Code, Codex and zcode shapes.
 */
import { describe, expect, it } from 'vitest';
import { countEditLines, diffLineCounts, editToolClass } from './line-count';

describe('diffLineCounts', () => {
  it('counts whole-line edits', () => {
    expect(diffLineCounts('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
  });

  it('reports only the changed lines, not the whole block', () => {
    // old_string captures 5 lines, one line actually changes.
    expect(diffLineCounts('1\n2\n3\n4\n5', '1\n2\nX\n4\n5')).toEqual({ added: 1, removed: 1 });
  });

  it('handles pure additions and removals', () => {
    expect(diffLineCounts('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(diffLineCounts('x\ny', '')).toEqual({ added: 0, removed: 2 });
  });

  it('normalizes CRLF and trailing newlines', () => {
    expect(diffLineCounts('a\r\nb\r\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });

  it('falls back to block counts for oversized inputs', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n');
    const other = Array.from({ length: 2000 }, (_, i) => `other-${i}`).join('\n');
    // 2000×2000 = 4M cells > 1M guard → no LCS, straight block counts.
    expect(diffLineCounts(big, other)).toEqual({ added: 2000, removed: 2000 });
  });
});

describe('countEditLines', () => {
  it('reads Edit tool_input (snake_case)', () => {
    const counts = countEditLines('Edit', { file_path: 'D:/x/a.ts', old_string: 'hello', new_string: 'hello\nworld' });
    expect(counts).toEqual({ added: 1, removed: 0 });
  });

  it('reads camelCase duplicates (zcode native naming)', () => {
    const counts = countEditLines('Edit', { filePath: 'D:/x/a.ts', oldString: 'one\ntwo', newString: 'one' });
    expect(counts).toEqual({ added: 0, removed: 1 });
  });

  it('counts Write content lines as added', () => {
    expect(countEditLines('Write', { file_path: 'D:/x/new.ts', content: 'a\nb\nc' })).toEqual({ added: 3, removed: 0 });
  });

  it('parses unified patch text (ApplyPatch)', () => {
    const patch = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,4 @@', ' keep', '-old', '+new', '+extra', ' context'].join('\n');
    expect(countEditLines('ApplyPatch', { patch })).toEqual({ added: 2, removed: 1 });
  });

  it('sums a MultiEdit-style edits array', () => {
    const counts = countEditLines('MultiEdit', {
      file_path: 'D:/x/a.ts',
      edits: [
        { old_string: 'a', new_string: 'a\nb' },
        { old_string: 'c\nd', new_string: 'c' },
      ],
    });
    expect(counts).toEqual({ added: 1, removed: 1 });
  });

  it('returns null for unrecognized shapes (record without counts)', () => {
    expect(countEditLines('Edit', { file_path: 'D:/x/a.ts' })).toBeNull();
    expect(countEditLines('Read', { file_path: 'D:/x/a.ts' })).toBeNull();
    expect(countEditLines(undefined, undefined)).toBeNull();
  });

  it('counts a NotebookEdit new_source as added lines', () => {
    expect(countEditLines('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'a\nb' })).toEqual({ added: 2, removed: 0 });
  });

  it('counts Codex write_file content', () => {
    expect(countEditLines('write_file', { path: 'a.ts', content: 'x\ny\nz\n' })).toEqual({ added: 3, removed: 0 });
  });
});

describe('editToolClass', () => {
  it('classifies by tool name', () => {
    expect(editToolClass('Edit')).toBe('edit');
    expect(editToolClass('Write')).toBe('write');
    expect(editToolClass('ApplyPatch')).toBe('patch');
    expect(editToolClass(undefined)).toBe('edit');
  });

  it('covers Claude Code, Codex and zcode names', () => {
    expect(editToolClass('MultiEdit')).toBe('edit');
    expect(editToolClass('NotebookEdit')).toBe('edit');
    expect(editToolClass('apply_patch')).toBe('patch');
    expect(editToolClass('write_file')).toBe('write');
  });
});

describe('Codex apply_patch freeform input', () => {
  it('counts +/- lines from the `input` key (custom_tool_call shape)', () => {
    const counts = countEditLines('apply_patch', {
      input: '*** Begin Patch\n*** Update File: a.ts\n@@\n context\n-old\n+new\n+extra\n*** End Patch',
    });
    expect(counts).toEqual({ added: 2, removed: 1 });
  });

  it('an `input` key that is not a Codex patch is ignored (falls through)', () => {
    expect(countEditLines('shell', { input: 'echo hi' })).toBeNull();
  });

  it('an unrecognized write-shaped payload reports null, not 0/0', () => {
    expect(countEditLines('write_file', { mystery: true })).toBeNull();
  });
});
