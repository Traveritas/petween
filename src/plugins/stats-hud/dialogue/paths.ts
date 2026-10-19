// Pure path-string helpers (no node:path): the dialogue reader only follows transcript paths that
// live under the agent's own data dir, so a forged signal cannot turn the reader into an arbitrary-file oracle.

const MAX_PATH_CHARS = 4096;

/** Fold separators, '.' and '..' lexically. Returns null for relative or non-string input. */
export function normalizeAbsolute(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_CHARS) return null;
  const s = p.replace(/\\/g, '/');
  let prefix: string;
  let rest: string;
  const drive = /^([A-Za-z]:)\//.exec(s);
  if (drive) {
    prefix = `${drive[1]}/`;
    rest = s.slice(3);
  } else if (s.startsWith('//')) {
    prefix = '//'; // UNC: never equals a local root
    rest = s.slice(2);
  } else if (s.startsWith('/')) {
    prefix = '/';
    rest = s.slice(1);
  } else {
    return null;
  }
  const stack: string[] = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return prefix + stack.join('/');
}

/** True when `candidate` resolves strictly inside `root` (case-insensitive: Windows paths). */
export function isPathUnder(root: string, candidate: string): boolean {
  const r = normalizeAbsolute(root);
  const c = normalizeAbsolute(candidate);
  if (r === null || c === null) return false;
  const base = (r.endsWith('/') ? r : `${r}/`).toLowerCase();
  return c.toLowerCase().startsWith(base) && c.length > base.length;
}
