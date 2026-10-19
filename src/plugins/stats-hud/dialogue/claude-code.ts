// Claude Code reply source. CC persists the session transcript as JSONL at the path every hook payload
// carries in `transcript_path`: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl.
// Shape (spike-verified on CC 2.1.234):
// - mixed line types (mode/attachment/system/...); only `user` and `assistant` matter;
// - every `user` line carries `promptId` (= the hook's prompt_id = turnId); assistant lines never do,
//   but the parentUuid chain from a main-chain assistant walks back to its user line;
// - reply = `text` blocks of the LAST main-chain (isSidechain !== true) assistant message that has any;
// - API-error assistant entries (isApiErrorMessage) are skipped.
// The reader sees only a tail, so the chain may leave it: then turnId is null (reply still returned).

import { isPathUnder } from './paths';
import { isSafeSessionId, MAX_LINE_CHARS, type LastReply } from './text';

/** True when `path` lies inside `<claudeDir>/projects` (forged-signal guard). */
export function isCcTranscriptPath(claudeDir: string, path: string): boolean {
  return isPathUnder(`${claudeDir.replace(/[\\/]+$/, '')}/projects`, path);
}

/** Transcript file name inside a project dir, or null for an unsafe id. */
export function transcriptFileName(sessionId: string): string | null {
  return isSafeSessionId(sessionId) ? `${sessionId}.jsonl` : null;
}

interface TranscriptLine {
  type?: unknown;
  uuid?: unknown;
  parentUuid?: unknown;
  isSidechain?: unknown;
  promptId?: unknown;
  isApiErrorMessage?: unknown;
  message?: unknown;
}

interface ChainNode {
  parentUuid: string | null;
  type?: unknown;
  promptId?: string;
}

function textBlocksOf(line: TranscriptLine): string[] {
  const message = line.message;
  if (typeof message !== 'object' || message === null) return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== 'text') continue;
    if (typeof record.text !== 'string' || record.text.trim() === '') continue;
    texts.push(record.text);
  }
  return texts;
}

/** Last completed reply in the tail. With `turnId`, the last reply whose turn matches (else null). */
export function lastReply(lines: string[], turnId?: string): LastReply | null {
  const byUuid = new Map<string, ChainNode>();
  const candidates: { uuid: string; text: string }[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.length > MAX_LINE_CHARS) continue;
    let entry: TranscriptLine | null;
    try {
      entry = JSON.parse(trimmed) as TranscriptLine | null;
    } catch {
      continue; // mid-append
    }
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.isSidechain === true) continue; // subagent traffic never drives the pet
    if (typeof entry.uuid === 'string') {
      byUuid.set(entry.uuid, {
        parentUuid: typeof entry.parentUuid === 'string' ? entry.parentUuid : null,
        type: entry.type,
        promptId: typeof entry.promptId === 'string' ? entry.promptId : undefined,
      });
    }
    if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) continue;
    const texts = textBlocksOf(entry);
    if (texts.length === 0 || typeof entry.uuid !== 'string') continue;
    candidates.push({ uuid: entry.uuid, text: texts.join('\n').trim() });
  }

  const turnOf = (uuid: string): string | null => {
    let cursor: ChainNode | undefined = byUuid.get(uuid);
    // Hop cap guards a cyclic parent chain in damaged input.
    for (let hops = 0; cursor !== undefined && hops < 10_000; hops++) {
      if (cursor.type === 'user' && cursor.promptId !== undefined) return cursor.promptId;
      cursor = cursor.parentUuid === null ? undefined : byUuid.get(cursor.parentUuid);
    }
    return null; // chain left the tail
  };

  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    const id = turnOf(c.uuid);
    if (turnId === undefined || id === turnId) return { turnId: id, text: c.text };
  }
  return null;
}
