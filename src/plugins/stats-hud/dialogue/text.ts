// Reply-preview reduction shared by every transcript extractor: plain text, one line, bounded.
// Reduction happens at the source so only the short preview ever leaves the reader (privacy).

export const DIALOGUE_MAX_CHARS = 160;

/** Per-line guard: a transcript line larger than this is damage (or a giant request echo), skip it. */
export const MAX_LINE_CHARS = 4 * 1024 * 1024;

// Markdown markers read as noise in a bubble.
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

export function truncatePreview(text: string, max: number = DIALOGUE_MAX_CHARS): string {
  const single = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export interface LastReply {
  /** Agent turn id when recoverable from the tail, else null. */
  turnId: string | null;
  text: string;
}

// Same session-id shape v0 accepted before touching any path.
const SESSION_ID_PATTERN = /^[\w.-]+$/;
export function isSafeSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}
