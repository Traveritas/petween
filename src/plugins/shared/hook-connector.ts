// Shared helpers for the built-in hook connectors (claude-code, codex, zcode). Plain library code
// over the public plugin API — no kernel access (docs/06 "内置功能不走后门").
//
// Every agent hook runs `petween --hook <connector> e=<kind>` (forward.rs); the connector maps
// its own kind vocabulary + the agent's stdin JSON to AgentEvents (docs/05 §2).

import type { AgentEvent, HookRequest, HostApi } from '../../api/types';

export type HookKind =
  | 'session-start'
  | 'prompt'
  | 'pre-tool'
  | 'post-tool'
  | 'post-tool-failure'
  | 'permission'
  | 'stop'
  | 'interrupt'
  | 'session-end';

// ---------- tool classification (real names are kept; only `kind` is coarse) ----------

const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'write_file', 'ApplyPatch']);
const COMMAND = new Set(['Bash', 'PowerShell', 'shell', 'local_shell', 'shell_command', 'exec_command']);
const READ = new Set(['Read', 'read_file', 'view', 'NotebookRead']);
const SEARCH = new Set(['Grep', 'Glob', 'LS', 'grep', 'search', 'list_dir', 'ToolSearch']);
const WEB = new Set(['WebFetch', 'WebSearch', 'web_search', 'fetch']);

export function toolKind(name: string): NonNullable<AgentEvent['tool']>['kind'] {
  if (EDIT.has(name)) return 'edit';
  if (COMMAND.has(name)) return 'command';
  if (READ.has(name)) return 'read';
  if (SEARCH.has(name)) return 'search';
  if (WEB.has(name)) return 'web';
  return 'other';
}

// ---------- parsing ----------

const str = (...vs: unknown[]) => vs.find((v): v is string => typeof v === 'string' && v.length > 0);

export function parseHook(agent: string, req: HookRequest): AgentEvent[] {
  const kind = new URLSearchParams(req.query).get('e') as HookKind | null;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(req.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    body = parsed;
  } catch {
    return [];
  }
  const sessionId = str(body.session_id, body.sessionId);
  if (!kind || !sessionId || sessionId.length > 200) return [];

  let at = req.receivedAt;
  if (typeof body.timestamp === 'number' && Number.isFinite(body.timestamp)) at = body.timestamp;
  else if (typeof body.timestamp === 'string' && Number.isFinite(Date.parse(body.timestamp))) at = Date.parse(body.timestamp);

  const extra: Record<string, unknown> = {};
  const turnId = str(body.prompt_id, body.turn_id, body.turnId, body.promptId);
  const transcriptPath = str(body.transcript_path, body.transcriptPath);
  const cwd = str(body.cwd);
  const hookEvent = str(body.hook_event_name, body.hookEventName);
  if (turnId) extra.turnId = turnId;
  if (transcriptPath) extra.transcriptPath = transcriptPath;
  if (cwd) extra.cwd = cwd;
  if (hookEvent) extra.hookEvent = hookEvent;
  const toolInput = body.tool_input ?? body.toolInput;
  if (toolInput !== undefined) extra.toolInput = toolInput;

  const base = { agent, sessionId, at, extra };
  const toolName = str(body.tool_name, body.toolName) ?? 'unknown';
  switch (kind) {
    case 'session-start':
      return [{ ...base, type: 'session-start' }];
    case 'prompt':
      return [{ ...base, type: 'turn-start' }];
    case 'pre-tool':
      return [{ ...base, type: 'tool-start', tool: { name: toolName, kind: toolKind(toolName) } }];
    case 'post-tool':
      return [{ ...base, type: 'tool-end', tool: { name: toolName, kind: toolKind(toolName), ok: true } }];
    case 'post-tool-failure':
      return [{ ...base, type: 'tool-end', tool: { name: toolName, kind: toolKind(toolName), ok: false } }];
    case 'permission':
      return [{ ...base, type: 'waiting' }];
    case 'stop':
      return [{ ...base, type: 'turn-end', outcome: 'success' }];
    case 'interrupt':
      return [{ ...base, type: 'turn-end', outcome: 'interrupted' }];
    case 'session-end':
      return [{ ...base, type: 'session-end' }];
    default:
      return [];
  }
}

// ---------- agent config files (v0 config-io hardening, over ctx.host.fs) ----------

const chains = new Map<string, Promise<unknown>>();

/** Serialize read-modify-write per file: a double click must never interleave two writes. */
export function serialized<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = chains.get(path) ?? Promise.resolve();
  const run = prev.then(op, op);
  chains.set(path, run.catch(() => {}));
  return run;
}

/** null = no file yet. Throws on corrupt JSON — user data is never clobbered by a parse failure. */
export async function readConfig(host: HostApi, path: string): Promise<Record<string, unknown> | null> {
  if (!(await host.fs.exists(path))) return null;
  const text = await host.fs.readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} 不是合法 JSON，拒绝改写：${e}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} 根节点不是对象，拒绝改写`);
  return parsed as Record<string, unknown>;
}

/** Atomic write with a one-generation `.petween-bak` of the previous content. */
export async function writeConfig(host: HostApi, path: string, config: Record<string, unknown>) {
  if (await host.fs.exists(path)) await host.fs.writeText(`${path}.petween-bak`, await host.fs.readText(path));
  await host.fs.writeText(path, JSON.stringify(config, null, 2));
}

/** After an uninstall the backup (which may mirror secrets in the config) must not linger. */
export async function removeBackup(host: HostApi, path: string) {
  const bak = `${path}.petween-bak`;
  if (await host.fs.exists(bak)) await host.fs.remove(bak);
}

// ---------- ownership ----------

type Entry = { command?: unknown; args?: unknown };
type Group = { hooks?: unknown };

const isExe = (s: string) => /(^|[\\/])petween(\.exe)?$/i.test(s.replace(/^"+|"+$/g, ''));

/** A hook entry is ours iff it runs a petween executable with `--hook <connectorId>` — whatever the install path. */
export function isOurEntry(entry: unknown, connectorId: string): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const { command, args } = entry as Entry;
  if (typeof command !== 'string') return false;
  let tokens: string[];
  if (Array.isArray(args)) tokens = [command, ...args.filter((a): a is string => typeof a === 'string')];
  else tokens = command.match(/"[^"]*"|\S+/g) ?? [];
  // The petween executable must BE the command, immediately followed by `--hook <id>`.
  return tokens.length >= 3 && isExe(tokens[0]) && tokens[1] === '--hook' && tokens[2] === connectorId;
}

export const isOurGroup = (g: unknown, connectorId: string) =>
  !!g && typeof g === 'object' && Array.isArray((g as Group).hooks) && ((g as Group).hooks as unknown[]).some((e) => isOurEntry(e, connectorId));

/**
 * Merge our groups into an event → groups map. Foreign groups and events survive; a malformed
 * (non-array) event value is refused rather than silently replaced.
 */
export function mergeEvents(events: Record<string, unknown>, ours: Record<string, unknown[]>, connectorId: string, file: string) {
  const out: Record<string, unknown> = { ...events };
  for (const [name, groups] of Object.entries(ours)) {
    const existing = events[name];
    if (existing !== undefined && !Array.isArray(existing)) throw new Error(`${file} 里 ${name} 不是数组，拒绝改写`);
    out[name] = [...((existing as unknown[]) ?? []).filter((g) => !isOurGroup(g, connectorId)), ...groups];
  }
  return out;
}

/** Remove our groups; empty events disappear. Returns whether anything was ours. */
export function stripEvents(events: Record<string, unknown>, connectorId: string): { events: Record<string, unknown>; removed: boolean } {
  let removed = false;
  const out: Record<string, unknown> = {};
  for (const [name, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) {
      out[name] = groups;
      continue;
    }
    const kept = groups.filter((g) => {
      const mine = isOurGroup(g, connectorId);
      if (mine) removed = true;
      return !mine;
    });
    if (kept.length) out[name] = kept;
  }
  return { events: out, removed };
}

/** Our groups as currently installed, for "is it up to date" checks. */
export function ourGroups(events: Record<string, unknown>, connectorId: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [name, groups] of Object.entries(events)) {
    if (!Array.isArray(groups)) continue;
    const mine = groups.filter((g) => isOurGroup(g, connectorId));
    if (mine.length) out[name] = mine;
  }
  return out;
}

export const objectAt = (v: unknown, what: string): Record<string, unknown> => {
  if (v === undefined) return {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} 不是对象，拒绝改写`);
  return v as Record<string, unknown>;
};

export const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
