// `codex` connector. Hooks go into ~/.codex/hooks.json (Claude-Code-compatible shape).
//
// Facts carried over from v0 (petween-desktop docs/08): the hook `command` is ONE string run via
// `cmd.exe /C` on Windows — so only the exe path is quoted (exactly two quote characters keep cmd's
// quote rule intact) and args contain no spaces. Matchers are Rust regex without look-around, so a
// single catch-all PreToolUse group is used and tools are classified from the payload. Interrupt
// (Esc) ends the turn; SessionEnd / Interrupt timeouts are clamped to 3s by Codex. Codex asks the
// user to trust new hooks once.

import { definePlugin, type PluginManifest } from '../../api/types';
import { connectorActivate } from '../shared/connector-plugin';
import { objectAt } from '../shared/hook-connector';

export const manifest: PluginManifest = {
  id: 'codex',
  name: 'Codex 接入',
  version: '0.1.0',
  apiVersion: 1,
  permissions: ['fs:read', 'fs:write'],
};

export default definePlugin({
  activate: connectorActivate({
    id: 'codex',
    name: 'Codex',
    files: () => ['~/.codex/hooks.json'],
    events: [
      ['SessionStart', 'session-start'],
      ['UserPromptSubmit', 'prompt'],
      ['PreToolUse', 'pre-tool'],
      ['PostToolUse', 'post-tool'],
      ['PermissionRequest', 'permission'],
      ['Stop', 'stop'],
      ['Interrupt', 'interrupt', 3],
      ['SessionEnd', 'session-end', 3],
    ],
    group: (cmd, timeout = 5) => ({ hooks: [{ type: 'command', command: [`"${cmd.command}"`, ...cmd.args].join(' '), timeout }] }),
    getEvents: (config, file) => objectAt(config.hooks, `${file} 的 hooks`),
    setEvents: (config, events) => {
      if (Object.keys(events).length) config.hooks = events;
      else delete config.hooks;
    },
    installNote: 'Codex 下次启动会话时会请你确认信任这些 hook（只需一次）',
  }),
});
