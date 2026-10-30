// `dsh` connector core (docs/05 §1.2): parse the bridge's compact events, and own the two files the
// bridge needs in $DSH_HOME. Pure functions with no host access, so tests can drive them directly.

import type { AgentEvent, HookRequest } from '../../api/types';
import { toolKind } from '../shared/hook-connector';

export const BRIDGE_FILENAME = 'petween-bridge.mjs';
export const PATCH_FILENAME = 'cordis.patch.yml';
export const BRIDGE_ROW_ID = 'petween-dsh-bridge';
const START = '# >>> petween managed block >>>';
const END = '# <<< petween <<<';

type Json = Record<string, unknown>;

const object = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const text = (v: unknown) => (typeof v === 'string' && v.length ? v : undefined);
const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------- parsing (bridge payload -> AgentEvent, docs/05 §2) ----------

function toolInput(v: unknown): unknown {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || !v) return undefined;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === 'object' ? parsed : v;
  } catch {
    return v;
  }
}

function outcomeOf(reason: unknown): AgentEvent['outcome'] {
  const kind = text(object(reason)?.kind);
  if (kind === 'error') return 'error';
  if (kind === 'aborted' || kind === 'interrupted' || kind === 'forked' || kind === 'blocked') return 'interrupted';
  return 'success';
}

/**
 * One bridge request may produce two events: the session-start Petween did not see yet, then the
 * event itself. `seen` lives for one activation of the connector plugin.
 */
export function parseDshHook(req: HookRequest, seen: Set<string>): AgentEvent[] {
  let raw: unknown;
  try {
    raw = JSON.parse(req.body);
  } catch {
    return [];
  }
  const body = object(raw);
  if (!body) return [];
  const sessionId = text(body.session_id);
  if (!sessionId || sessionId.length > 200) return [];
  if (body.subagent === true) return [];
  const event = text(body.event);
  if (!event) return [];

  const data = object(body.data) ?? {};
  const at = finite(body.at) ?? req.receivedAt;
  const extra: Record<string, unknown> = { hookEvent: event };
  const cwd = text(body.cwd);
  if (cwd) extra.cwd = cwd;
  const turn = finite(data.turn);
  if (turn !== undefined) extra.turnId = String(turn);

  const base = { agent: 'dsh', sessionId, at, extra };

  if (event === 'session/disposed') {
    seen.delete(sessionId);
    return [{ ...base, type: 'session-end' }];
  }

  const out: AgentEvent[] = [];
  switch (event) {
    case 'turn/start':
      out.push({ ...base, type: 'turn-start' });
      break;
    case 'step/start':
      out.push({ ...base, type: 'thinking' });
      break;
    case 'tool/call': {
      const name = text(data.name) ?? 'unknown';
      if (name === 'ask_user_question') {
        // DSH's question tool blocks until the user answers: that is the `waiting` face, not a tool.
        out.push({ ...base, type: 'waiting' });
      } else {
        const input = toolInput(data.arguments);
        if (input !== undefined) extra.toolInput = input;
        out.push({ ...base, type: 'tool-start', tool: { name, kind: toolKind(name) } });
      }
      break;
    }
    case 'tool/result': {
      const name = text(body.tool_name) ?? text(data.name) ?? 'unknown';
      out.push({ ...base, type: 'tool-end', tool: { name, kind: toolKind(name), ok: data.isError !== true } });
      break;
    }
    case 'approval/asked': {
      const toolName = text(data.toolName);
      if (toolName) extra.toolName = toolName;
      out.push({ ...base, type: 'waiting' });
      break;
    }
    case 'approval/decided':
      // Waiting is over; the approved tool is about to run.
      out.push({ ...base, type: 'thinking' });
      break;
    case 'turn/end':
      out.push({ ...base, type: 'turn-end', outcome: outcomeOf(data.reason) });
      break;
    default:
      return [];
  }

  if (!seen.has(sessionId)) {
    seen.add(sessionId);
    out.unshift({ ...base, type: 'session-start', extra: { ...extra } });
  }
  return out;
}

// ---------- $DSH_HOME patch (home-level cordis.patch.yml) ----------

/** The exact block Petween owns. `name` is relative: the loader anchors it beside the patch file. */
export function bridgeBlock(): string {
  return `${START}\n- insert:\n    - id: ${BRIDGE_ROW_ID}\n      name: './${BRIDGE_FILENAME}'\n${END}\n`;
}

export function patchHasBlock(current: string | null): boolean {
  if (typeof current !== 'string') return false;
  const start = current.indexOf(START);
  return start >= 0 && current.indexOf(END, start) > start;
}

/** Lines that carry YAML meaning (blank lines, comments and document markers do not). */
function meaningful(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line !== '---');
}

/**
 * Add or refresh our insert row. Foreign rows and comments stay untouched; a shape we cannot edit
 * safely (`{}`, an inline list) is refused instead of being replaced.
 */
export function installPatch(current: string | null): string {
  const block = bridgeBlock();
  if (current === null) return block;
  const start = current.indexOf(START);
  if (start >= 0) {
    const end = current.indexOf(END, start);
    if (end < 0) throw new Error('cordis.patch.yml 里的 petween 段不完整，拒绝改写');
    return (current.slice(0, start) + block + current.slice(end + END.length)).replace(/\s*$/, '\n');
  }
  const lines = meaningful(current);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '[]')) return block;
  if (lines[0].startsWith('[')) throw new Error('cordis.patch.yml 是内联列表，拒绝改写');
  if (!lines.some((line) => line.startsWith('-'))) throw new Error('cordis.patch.yml 不是条目列表，拒绝改写');
  return `${current.replace(/\s*$/, '')}\n\n${block}`;
}

/**
 * Remove only our block. If nothing but comments is left, write `[]` (an empty patch file makes DSH
 * fail to boot; `[]` is its documented "no patch" form).
 */
export function uninstallPatch(current: string | null): { text: string; removed: boolean } {
  if (current === null) return { text: '', removed: false };
  const start = current.indexOf(START);
  if (start < 0) return { text: current, removed: false };
  const end = current.indexOf(END, start);
  if (end < 0) throw new Error('cordis.patch.yml 里的 petween 段不完整，拒绝改写');
  const left = (current.slice(0, start) + current.slice(end + END.length)).replace(/\s*$/, '');
  const text = meaningful(left).length ? `${left}\n` : '[]\n';
  return { text, removed: true };
}
