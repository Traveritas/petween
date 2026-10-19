// `brain-default` (docs/05 §4): the stock agent-signal -> state-key brain. One instance per pet.

import { definePlugin, type Disposable, type PluginManifest } from '../../api/types';
import { createBrain, DEFAULT_OPTIONS, type BrainOptions } from './brain';

export const manifest: PluginManifest = {
  id: 'brain-default',
  name: '默认大脑',
  version: '0.1.0',
  apiVersion: 1,
  dependencies: { core: '^0.1.0' },
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
