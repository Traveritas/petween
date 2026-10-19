// Runtime → host bridge (docs/01 §6). The only module that talks to Tauri; tests swap in a fake.

import { invoke } from '@tauri-apps/api/core';
import { emitTo, listen } from '@tauri-apps/api/event';
import type { ExecResult, HookRequest } from '../api/types';
import type { StageInfo } from '../render/coords';

export interface HostPaths {
  appData: string;
  home: string;
  pets: string;
  plugins: string;
  settings: string;
  data: string;
  cache: string;
  instances: string;
  hookPortFile: string;
}

export interface TrayItemWire {
  id: string;
  label: string;
  checked?: boolean;
  enabled?: boolean;
}

/** Pointer input forwarded from a mirror stage to the kernel. */
export interface RemoteInput {
  type: 'hover' | 'down' | 'up';
  stage: string;
  petId: string | null;
  x: number;
  y: number;
  button: number;
}

export interface HostEvents {
  cursor: { x: number; y: number };
  layout: StageInfo[];
  hook: HookRequest;
  'plugin-changed': string;
  'tray-click': string;
  rescue: null;
  'second-instance': null;
  'remote-input': RemoteInput;
  'admin-call': import('../shared/admin').AdminCall;
  frame: import('../render/dom2d').RenderPet[];
}

export interface Host {
  paths(): Promise<HostPaths>;
  layout(): Promise<StageInfo[]>;
  setHit(hit: boolean): Promise<void>;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  hookPort(): Promise<number>;
  hookCommand(connectorId: string, query?: string): Promise<{ command: string; args: string[] }>;
  readText(path: string): Promise<string>;
  readTail(path: string, maxBytes: number): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  list(path: string): Promise<{ name: string; isDir: boolean }[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exec(cmd: string, args: string[], cwd?: string): Promise<ExecResult>;
  openExternal(url: string): Promise<void>;
  traySetItems(items: TrayItemWire[]): Promise<void>;
  quit(): Promise<void>;
  on<K extends keyof HostEvents>(event: K, fn: (payload: HostEvents[K]) => void): Promise<() => void>;
  emitTo(label: string, event: string, payload: unknown): Promise<void>;
}

/** Base URLs of the file protocols (Windows exposes custom schemes as http://<scheme>.localhost/). */
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
export const PLUGIN_BASE = isWindows ? 'http://petplugin.localhost' : 'petplugin://localhost';
export const PACK_BASE = isWindows ? 'http://petpack.localhost' : 'petpack://localhost';

export const tauriHost: Host = {
  paths: () => invoke('paths'),
  layout: () => invoke('get_layout'),
  setHit: (hit) => invoke('set_hit', { hit }),
  log: (level, line) => {
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
    void invoke('log_line', { level, line }).catch(() => {});
  },
  hookPort: () => invoke('hook_port'),
  hookCommand: (connectorId, query) => invoke('hook_command', { connectorId, query: query ?? null }),
  readText: (path) => invoke('fs_read_text', { path }),
  readTail: (path, maxBytes) => invoke('fs_read_tail', { path, maxBytes }),
  writeText: (path, content) => invoke('fs_write_text', { path, content }),
  list: (path) => invoke('fs_list', { path }),
  exists: (path) => invoke('fs_exists', { path }),
  mkdir: (path) => invoke('fs_mkdir', { path }),
  remove: (path) => invoke('fs_remove', { path }),
  exec: (cmd, args, cwd) => invoke('shell_exec', { cmd, args, cwd: cwd ?? null }),
  openExternal: (url) => invoke('open_external', { url }),
  traySetItems: (items) => invoke('tray_set_items', { items }),
  quit: () => invoke('quit'),
  on: (event, fn) => listen(event, (e) => fn(e.payload as never)),
  emitTo: (label, event, payload) => emitTo(label, event, payload),
};

export const joinPath = (...parts: string[]) => parts.join('/').replace(/[\\/]+/g, '/');
