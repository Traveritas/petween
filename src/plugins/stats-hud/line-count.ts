/**
 * line-count — reduce an AgentEvent's `extra.toolInput` to edit line counts.
 * Edit CONTENT is reduced to integers here and never travels further: the
 * ledger stores counts only (privacy invariant).
 *
 * Tool names are the agent's real ones (Claude Code Edit/Write/MultiEdit/
 * NotebookEdit, Codex apply_patch/write_file, zcode ApplyPatch). Every reader
 * takes snake_case first, camelCase as fallback, so one function serves all.
 */

export interface EditLineCounts {
  added: number;
  removed: number;
}

const MAX_DIFF_CELLS = 1_000_000;

const splitLines = (text: string): string[] => {
  if (text === '') return [];
  // A trailing newline ends the last line, it does not open an empty one
  // ("a\nb\n" is two lines, not three) — keeps Edit diffs symmetric.
  return text.replace(/(\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/);
};

/**
 * Line-level diff via LCS. For whole-line Edit semantics this reports the
 * actually-added/removed lines; oversized inputs (a generated file paste)
 * fall back to whole-block counts — the guard keeps the O(n·m) table bounded.
 */
export function diffLineCounts(oldText: string, newText: string): EditLineCounts {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return { added: b.length, removed: a.length };
  }
  // dp[i][j] = LCS length of a[i:] × b[j:] (rolling rows, Int32 packed).
  let next = new Int32Array(b.length + 1);
  let current = new Int32Array(b.length + 1);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      current[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], current[j + 1]);
    }
    const swap = next;
    next = current;
    current = swap;
  }
  const common = next[0];
  return { added: b.length - common, removed: a.length - common };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Unified-diff / Codex patch text: count hunk +/- lines, skip headers. */
function countsFromPatch(patch: string): EditLineCounts {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

type ToolInput = Record<string, unknown>;

const isRecord = (value: unknown): value is ToolInput => typeof value === 'object' && value !== null;

/**
 * The edit facts for one edit-class tool call, or null when the shape is not
 * recognized (unknown tool / payload-less event): callers still record the
 * edit, just without counts. The shape decides, not the tool name.
 */
export function countEditLines(_toolName: string | undefined, toolInput: unknown): EditLineCounts | null {
  if (!isRecord(toolInput)) return null;
  const read = (key: string): unknown => {
    const snake = toolInput[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
    return snake !== undefined ? snake : toolInput[key];
  };
  const oldText = asString(read('oldString'));
  const newText = asString(read('newString'));
  if (oldText !== null && newText !== null) return diffLineCounts(oldText, newText);
  const content = asString(read('content'));
  if (content !== null) {
    // Write: the previous file content is not in the payload — count the
    // written lines as added.
    return { added: splitLines(content).length, removed: 0 };
  }
  // NotebookEdit: only the new cell source is in the payload, no old cell.
  const newSource = asString(read('newSource'));
  if (newSource !== null) return { added: splitLines(newSource).length, removed: 0 };
  const patch = asString(read('patch'));
  if (patch !== null) return countsFromPatch(patch);
  // Codex's native apply_patch is a custom tool whose payload key is `input`
  // ("*** Begin Patch…" freeform text).
  const freeform = asString(read('input'));
  if (freeform !== null && /^\*{3}\s+(Begin|Update|Add|Delete)/m.test(freeform)) return countsFromPatch(freeform);
  const edits = read('edits');
  if (Array.isArray(edits)) {
    let added = 0;
    let removed = 0;
    for (const entry of edits) {
      if (!isRecord(entry)) continue;
      const o = asString(entry.old_string ?? entry.oldString);
      const n = asString(entry.new_string ?? entry.newString);
      if (o === null || n === null) continue;
      const part = diffLineCounts(o, n);
      added += part.added;
      removed += part.removed;
    }
    if (edits.length > 0) return { added, removed };
  }
  // Unrecognized shape → null: "unknown" must not masquerade as "zero lines"
  // (a write_file with an unexpected payload key reports no fact, not 0/0).
  return null;
}

/** Tool classification for edit events (drives the bubble icon/label). */
export function editToolClass(toolName: string | undefined): 'edit' | 'write' | 'patch' {
  const name = toolName ?? '';
  if (/apply_?patch/i.test(name)) return 'patch';
  if (/write/i.test(name)) return 'write';
  return 'edit';
}
