// `physics` (docs/06 §6). M0 scope: drag with a velocity-driven wobble and a small landing squash.
// Throwing, gravity and edge bounce arrive in M1 (port of petween-physics).

import { definePlugin, type Disposable, type Lease, type MotionHandle, type PetHandle, type PluginManifest, type Point } from '../../api/types';

export const manifest: PluginManifest = {
  id: 'physics',
  name: '物理',
  version: '0.1.0',
  apiVersion: 1,
  dependencies: { core: "^0.1.0" },
  contributes: { channels: ['position', 'motion'] },
};

/** docs/02 §2: user direct manipulation. */
const DRAG_PRIORITY = 95;

const GRAB = {
  type: 'keyframes',
  tracks: {
    scaleY: [{ t: 0, v: 1 }, { t: 90, v: 1.06, ease: 'out' }, { t: 220, v: 1, ease: 'inOut' }],
    scaleX: [{ t: 0, v: 1 }, { t: 90, v: 0.96, ease: 'out' }, { t: 220, v: 1, ease: 'inOut' }],
  },
};

const LAND = {
  type: 'keyframes',
  tracks: {
    scaleY: [{ t: 0, v: 1 }, { t: 80, v: 0.9, ease: 'out' }, { t: 200, v: 1.03, ease: 'inOut' }, { t: 320, v: 1, ease: 'inOut' }],
    scaleX: [{ t: 0, v: 1 }, { t: 80, v: 1.08, ease: 'out' }, { t: 200, v: 0.98, ease: 'inOut' }, { t: 320, v: 1, ease: 'inOut' }],
  },
};

export default definePlugin({
  activate(ctx) {
    const attach = (pet: PetHandle) => {
      let lease: Lease<Point> | null = null;
      let wobble: MotionHandle | null = null;
      let fade: Disposable | null = null;
      let grab = { x: 0, y: 0 };

      pet.on('input', (e) => {
        if (e.type === 'drag-start') {
          fade?.dispose();
          wobble?.dispose();
          const p = pet.position;
          grab = { x: e.x - p.x, y: e.y - p.y };
          lease = pet.channel('position').request({ priority: DRAG_PRIORITY, value: p, preempt: true });
          wobble = pet.motion.add(
            { type: 'spring', property: 'rotate', drive: 'velocityX', gain: 0.02, max: 14, stiffness: 140, damping: 9 },
            { layer: 'physics' },
          );
          pet.play(GRAB, { layer: 'physics' });
        } else if (e.type === 'drag-move' && lease) {
          lease.update({ x: e.x - grab.x, y: e.y - grab.y });
        } else if (e.type === 'drag-end' && lease) {
          lease.release();
          lease = null;
          pet.play(LAND, { layer: 'physics' });
          // Let the wobble settle back once the pet stops moving.
          const w = wobble;
          fade = ctx.setTimeout(() => w?.dispose(), 900);
        }
      });
    };
    ctx.pets.list().forEach(attach);
    ctx.pets.on('added', attach);
  },
});
