// DSH-side half of Petween's `dsh` connector (docs/05 §1.2).
//
// DSH has no executable hook entry point: its extension point is a Cordis host plugin. This file is
// installed into $DSH_HOME by Petween and loaded from the home-level cordis.patch.yml. It only reads
// DSH's session event stream, compacts the events Petween needs, and POSTs them to the local hook
// server. All agent-format interpretation lives in the Petween connector (protocol.ts).
//
// No dependencies, no imports from DSH: a DSH update can rename its packages without breaking us.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTOR_ID = 'dsh';
const MAX_ARGUMENTS = 64 * 1024;
const PORT_TTL_MS = 1000;
const DOWN_TTL_MS = 3000;

// A running DSH keeps this module loaded even after Petween deletes it on disconnect. Checking that
// our own file still exists makes the orphaned module go quiet instead of POSTing to a connector that
// is no longer registered (the hook server would log every request as unknown).
const SELF_FILE = fileURLToPath(import.meta.url);

const FORWARDED = new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'tool/call',
  'tool/result',
  'approval/asked',
  'approval/decided',
]);

let portCache = { at: 0, port: 0 };
let downUntil = 0;
let selfCache = { at: 0, alive: true };

/** Must match `identifier` in petween's tauri.conf.json (and forward.rs). */
function appDataDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, 'com.petween.app');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'com.petween.app');
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'com.petween.app');
}

function hookPort() {
  const now = Date.now();
  if (now - portCache.at < PORT_TTL_MS) return portCache.port;
  let port = 0;
  try {
    const n = Number(fs.readFileSync(path.join(appDataDir(), 'hook-port'), 'utf8').trim());
    if (Number.isInteger(n) && n > 0 && n <= 65535) port = n;
  } catch {
    // Petween is not running (or has not written the port yet): stay silent.
  }
  portCache = { at: now, port };
  return port;
}

function installed() {
  const now = Date.now();
  if (now - selfCache.at < PORT_TTL_MS) return selfCache.alive;
  let alive = false;
  try {
    alive = fs.existsSync(SELF_FILE);
  } catch {
    // Treat an unreadable location like a removed installation.
  }
  selfCache = { at: now, alive };
  return alive;
}

function post(body) {
  if (!installed() || Date.now() < downUntil) return;
  const port = hookPort();
  if (!port) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    fetch(`http://127.0.0.1:${port}/hook/${CONNECTOR_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then((res) => res.arrayBuffer())
      .catch(() => {
        downUntil = Date.now() + DOWN_TTL_MS;
      })
      .finally(() => clearTimeout(timer));
  } catch {
    clearTimeout(timer);
    downUntil = Date.now() + DOWN_TTL_MS;
  }
}

const string = (v) => (typeof v === 'string' ? v : '');

function sessionCwd(session) {
  try {
    return string(session?.header?.cwd) || string(session?.cwd);
  } catch {
    return '';
  }
}

function isSubagent(session) {
  try {
    return (session?.header?.origin ?? session?.origin) === 'subagent';
  } catch {
    return false;
  }
}

/**
 * DSH session event -> compact hook payload. Exported so the Node test can drive it without a live
 * DSH. Returns null for events Petween does not need (subagents, messages, titles, ...).
 */
export function compactEvent(session, event, pending) {
  try {
    const type = string(event?.type);
    if (!FORWARDED.has(type)) return null;
    const sessionId = string(session?.id);
    if (!sessionId || isSubagent(session)) return null;
    const d = event?.data && typeof event.data === 'object' ? event.data : {};
    const data = {};
    if (typeof d.turn === 'number') data.turn = d.turn;
    if (typeof d.step === 'number') data.step = d.step;
    const body = {
      session_id: sessionId,
      cwd: sessionCwd(session),
      at: typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now(),
      event: type,
      data,
    };
    const prefix = `${sessionId}\u0000`;
    switch (type) {
      case 'tool/call': {
        const name = string(d.name) || 'unknown';
        const callId = string(d.callId);
        data.callId = callId;
        data.name = name;
        if (typeof d.arguments === 'string') data.arguments = d.arguments.slice(0, MAX_ARGUMENTS);
        else if (d.arguments && typeof d.arguments === 'object') data.arguments = JSON.stringify(d.arguments).slice(0, MAX_ARGUMENTS);
        if (callId) pending.set(prefix + callId, name);
        break;
      }
      case 'tool/result': {
        const callId = string(d.callId) || string(d.message?.callId);
        data.callId = callId;
        data.isError = !!(d.error || d.message?.isError);
        body.tool_name = (callId && pending.get(prefix + callId)) || '';
        if (callId) pending.delete(prefix + callId);
        break;
      }
      case 'approval/asked':
        data.id = string(d.id);
        data.toolName = string(d.toolName);
        break;
      case 'approval/decided':
        data.id = string(d.id);
        data.outcome = string(d.outcome);
        break;
      case 'turn/end':
        data.reason = { kind: string(d.reason?.kind) };
        // A turn may end with calls that never produced a result (interrupt). Drop their names.
        for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
        break;
      default:
        break;
    }
    return body;
  } catch {
    return null;
  }
}

function sendDisposed(session, pending) {
  try {
    const sessionId = string(session?.id);
    if (!sessionId) return;
    const prefix = `${sessionId}\u0000`;
    for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
    post({ session_id: sessionId, cwd: sessionCwd(session), at: Date.now(), event: 'session/disposed', data: {} });
  } catch {
    // Never let a DSH event handler throw into the host.
  }
}

export default {
  name: 'petween-bridge',
  apply(ctx) {
    const pending = new Map();
    ctx.on('session/event', (session, event) => {
      const body = compactEvent(session, event, pending);
      if (body) post(body);
    });
    ctx.on('session/disposed', (session) => sendDisposed(session, pending));
  },
};
