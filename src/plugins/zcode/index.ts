// `zcode` connector. Hooks go into ~/.zcode/cli/config.json under `hooks.events`.
//
// Facts carried over from v0 (petween-desktop docs/06): entries are `type: 'process'` with
// command + args and `timeoutMs`; there is a global `hooks.enabled` runner flag; zcode has no
// SessionEnd (the kernel watchdog ends silent sessions); the client must restart after install.

import { definePlugin, type PluginManifest } from '../../api/types';
import { connectorActivate } from '../shared/connector-plugin';
import { objectAt } from '../shared/hook-connector';

export const manifest: PluginManifest = {
  id: 'zcode',
  name: 'zcode 接入',
  version: '0.1.0',
  apiVersion: 1,
  permissions: ['fs:read', 'fs:write'],
};

export default definePlugin({
  activate: connectorActivate({
    id: 'zcode',
    name: 'zcode',
    files: () => ['~/.zcode/cli/config.json'],
    events: [
      ['SessionStart', 'session-start'],
      ['UserPromptSubmit', 'prompt'],
      ['PreToolUse', 'pre-tool'],
      ['PostToolUse', 'post-tool'],
      ['PostToolUseFailure', 'post-tool-failure'],
      ['PermissionRequest', 'permission'],
      ['Stop', 'stop'],
    ],
    group: (cmd) => ({ hooks: [{ type: 'process', command: cmd.command, args: cmd.args, timeoutMs: 2500 }] }),
    getEvents: (config, file) => objectAt(objectAt(config.hooks, `${file} 的 hooks`).events, `${file} 的 hooks.events`),
    setEvents: (config, events, installing) => {
      const hooks = objectAt(config.hooks, 'hooks');
      const before = objectAt(hooks.events, 'hooks.events');
      // Turn the runner on only if nothing was configured before: a user who disabled hooks keeps it.
      const enabled = installing
        ? hooks.enabled === true || Object.keys(before).length === 0 || (hooks.enabled ?? false)
        : Object.keys(events).length > 0 && (hooks.enabled ?? false);
      config.hooks = { ...hooks, enabled, events };
    },
    installNote: '需要重启 zcode 才会生效',
  }),
});
