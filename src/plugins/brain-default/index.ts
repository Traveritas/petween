// `brain-default` (docs/05 §4): the stock agent-signal -> state-key brain. One instance per pet.

import { definePlugin, type Disposable, type PluginManifest } from '../../api/types';
import { createBrain, DEFAULT_OPTIONS, type BrainOptions } from './brain';

export const manifest: PluginManifest = {
  id: 'brain-default',
  name: '默认大脑',
  version: '0.1.0',
  apiVersion: 1,
  dependencies: { core: '^0.1.0' },
  contributes: {
    settings: [
      { key: 'successHoldMs', label: '成功表情保持', type: 'number', default: 1600, min: 0, max: 30000, step: 100, unit: 'ms' },
      { key: 'errorHoldMs', label: '出错表情保持', type: 'number', default: 1800, min: 0, max: 30000, step: 100, unit: 'ms' },
      { key: 'holdUntilClick', label: '成功/出错表情保持到点击宠物', type: 'boolean', default: false },
      { key: 'idleLongMs', label: '闲置多久算「长时间闲置」', type: 'number', default: 300000, min: 30000, max: 3600000, step: 30000, unit: 'ms' },
      { key: 'followFocus', label: '只跟随最近操作的会话', type: 'boolean', default: false, description: '多个会话同时进行时，只看你最后发过消息的那个' },
    ],
  },
};

export default definePlugin({
  activate(ctx) {
    ctx.register.brain({
      id: 'default',
      create(pet, output) {
        // Read at create time: the kernel recreates brains when the registry changes.
        const opts = {} as BrainOptions;
        for (const k of Object.keys(DEFAULT_OPTIONS) as (keyof BrainOptions)[]) {
          (opts as unknown as Record<string, unknown>)[k] = ctx.settings.get(k, DEFAULT_OPTIONS[k]);
        }
        const brain = createBrain(
          output,
          {
            now: () => Date.now(),
            setTimeout: (fn, ms) => ctx.setTimeout(fn, ms),
            clearTimeout: (h) => (h as Disposable).dispose(),
          },
          opts,
        );
        const sub = opts.holdUntilClick
          ? pet.on('input', (e) => {
              if (e.type === 'click') brain.release();
            })
          : null;
        return {
          onEvent: (e) => brain.onEvent(e),
          dispose() {
            sub?.dispose();
            brain.dispose();
          },
        };
      },
    });
  },
});
