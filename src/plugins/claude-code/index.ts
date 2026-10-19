// `claude-code` connector (docs/05, docs/06 §6). Hooks go into <config dir>/settings.json.
//
// Facts carried over from v0 (petween-desktop docs/07): hooks live under the top-level `hooks` key;
// the exec form (command + args) spawns without a shell; `timeout` is in seconds; settings.json is
// hot-reloaded, so no restart is needed. Notification is deliberately not hooked — its post-turn
// "waiting for input" nudge showed a phantom waiting face.

import { definePlugin, type PluginManifest } from '../../api/types';
import { connectorActivate } from '../shared/connector-plugin';
import { objectAt } from '../shared/hook-connector';

export const manifest: PluginManifest = {
  id: 'claude-code',
  name: 'Claude Code 接入',
  version: '0.1.0',
  apiVersion: 1,
  permissions: ['fs:read', 'fs:write'],
  contributes: {
    settings: [
      {
        key: 'configDirs',
        label: 'Claude Code 配置目录',
        type: 'list',
        default: ['~/.claude'],
        description: '用了 CLAUDE_CONFIG_DIR 的话把那个目录也加上；改完需重新接入',
      },
    ],
  },
};

export default definePlugin({
  activate: connectorActivate({
    id: 'claude-code',
    name: 'Claude Code',
    // `configDirs` covers CLAUDE_CONFIG_DIR setups (several profiles); default is ~/.claude.
    files: (ctx) => ctx.settings.get<string[]>('configDirs', ['~/.claude']).map((d) => `${d.replace(/[\\/]+$/, '')}/settings.json`),
    events: [
      ['SessionStart', 'session-start'],
      ['UserPromptSubmit', 'prompt'],
      ['PreToolUse', 'pre-tool'],
      ['PostToolUse', 'post-tool'],
      ['PostToolUseFailure', 'post-tool-failure'],
      ['PermissionRequest', 'permission'],
      ['Stop', 'stop'],
      ['SessionEnd', 'session-end'],
    ],
    group: (cmd) => ({ hooks: [{ type: 'command', command: cmd.command, args: cmd.args, timeout: 5 }] }),
    getEvents: (config, file) => objectAt(config.hooks, `${file} 的 hooks`),
    setEvents: (config, events) => {
      if (Object.keys(events).length) config.hooks = events;
      else delete config.hooks;
    },
  }),
});
