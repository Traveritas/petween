// `physics` (docs/06 §6). Drag with a velocity-driven wobble, plus throw → flight → wall bounces → slide → settle
// (port of petween-physics v0; the simulation itself lives in throw.ts). Pictures are never chosen here:
// wall hits and slides only raise optional state keys that the pet pack may map to clips.

import {
  definePlugin,
  type Disposable,
  type Lease,
  type MotionHandle,
  type PetHandle,
  type PluginManifest,
  type Point,
  type Rect,
} from '../../api/types';
import { readSettings } from './settings';
import { arenaFor, boxFrom, Flight, pickScreen, VelocitySampler, type Box } from './throw';

export const manifest: PluginManifest = {
  id: 'physics',
  name: '物理',
  version: '0.2.0',
  apiVersion: 1,
  dependencies: { core: '^0.1.0' },
  contributes: {
    channels: ['position', 'motion', 'state'],
    settings: [
      { key: 'gravity', label: '重力', type: 'number', default: 3000, min: 500, max: 10000, step: 100, unit: 'px/s²' },
      { key: 'restitution', label: '弹性', type: 'number', default: 0.6, min: 0, max: 0.95, step: 0.05, description: '撞墙后保留多少速度' },
      { key: 'throwMultiplier', label: '抛掷力度', type: 'number', default: 1, min: 0.2, max: 3, step: 0.1 },
      { key: 'minThrowSpeed', label: '起飞所需手速', type: 'number', default: 350, min: 0, max: 3000, step: 50, unit: 'px/s', description: '松手比这慢就只是放下' },
      { key: 'groundFriction', label: '地面摩擦', type: 'number', default: 2, min: 0, max: 20, step: 0.5 },
      { key: 'bounceMotion', label: '撞墙时挤压变形', type: 'boolean', default: true },
      { key: 'hitStateMs', label: '撞墙表情持续', type: 'number', default: 0, min: 0, max: 5000, step: 100, unit: 'ms', description: '0 = 不切换；宠物包需配置 physics.hit' },
      { key: 'slideState', label: '滑行时切换表情', type: 'boolean', default: false, description: '宠物包需配置 physics.slide' },
    ],
    stateKeys: [
      { key: 'physics.hit', label: '撞墙' },
      { key: 'physics.slide', label: '滑行' },
    ],
  },
};

/** docs/02 §2: user direct manipulation. */
const DRAG_PRIORITY = 95;
/** A flight yields to the user's hand but beats ordinary plugin position control. */
const FLIGHT_PRIORITY = 85;
/** Transient reaction states sit below the brain's real states' top bands. */
const REACTION_STATE_PRIORITY = 60;

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

/** v0 factory bounce-pop (260 ms): squash on impact, overshoot, recover. Both tracks share times, per docs/03. */
export const BOUNCE = {
  type: 'keyframes',
  tracks: {
    scaleX: [{ t: 0, v: 1 }, { t: 78, v: 1.22, ease: 'outBack' }, { t: 156, v: 0.88, ease: 'inOut' }, { t: 260, v: 1, ease: 'inOut' }],
    scaleY: [{ t: 0, v: 1 }, { t: 78, v: 0.76, ease: 'outBack' }, { t: 156, v: 1.14, ease: 'inOut' }, { t: 260, v: 1, ease: 'inOut' }],
  },
};

/** What the collision box falls back to when the current frame has no visible pixels. */
const POINT_BOX: Box = { dx: 0, dy: 0, width: 0, height: 0 };

interface Flying {
  flight: Flight;
  lease: Lease<Point>;
  walls: Rect;
  frame: Disposable;
  slide: Lease<string> | null;
}

export default definePlugin({
  activate(ctx) {
    const flyings = new Set<Flying>();
    const now = () => performance.now();

    // Monitors hot-plugged mid-flight: re-pick the walls for where the pet is now.
    ctx.desktop.on('change', (screens) => {
      for (const f of flyings) f.walls = pickScreen(screens, f.flight.position) ?? f.walls;
    });

    const attach = (pet: PetHandle) => {
      const sampler = new VelocitySampler();
      let drag: Lease<Point> | null = null;
      let wobble: MotionHandle | null = null;
      let fade: Disposable | null = null;
      let grab = { x: 0, y: 0 };
      let flying: Flying | null = null;
      let hit: { lease: Lease<string>; timer: Disposable } | null = null;

      /** Stop simulating; `release` false when the lease was already revoked by someone else. */
      const stopFlight = (release: boolean) => {
        const f = flying;
        if (!f) return;
        flying = null;
        flyings.delete(f);
        f.frame.dispose(); // nothing flying → no frame subscription → the app can idle
        f.slide?.release();
        if (release) f.lease.release(); // kernel commits + persists the last value as the base position
      };

      const dropHit = () => {
        hit?.timer.dispose();
        hit?.lease.release();
        hit = null;
      };

      const onWallHit = (hitStateMs: number, bounceMotion: boolean) => {
        if (bounceMotion) pet.play(BOUNCE, { layer: 'physics' });
        if (hitStateMs > 0) {
          dropHit();
          const lease = pet.showState('physics.hit', { priority: REACTION_STATE_PRIORITY });
          hit = { lease, timer: ctx.setTimeout(dropHit, hitStateMs) };
        }
      };

      const startFlight = (from: Point, v: { vx: number; vy: number }, p = readSettings(ctx.settings)) => {
        const walls = pickScreen(ctx.desktop.screens(), from);
        if (!walls) return;
        const lease = pet.channel('position').request({ priority: FLIGHT_PRIORITY, value: from, preempt: true });
        const f: Flying = {
          flight: new Flight(from, v, p),
          lease,
          walls,
          slide: null,
          frame: { dispose() {} },
        };
        flying = f;
        flyings.add(f);
        // The user's drag lease preempts this one: stop simulating, do not release what is no longer ours.
        lease.onRevoked(() => { if (flying === f) stopFlight(false); });
        f.frame = ctx.requestFrame((_, dt) => {
          if (flying !== f) return;
          const s = readSettings(ctx.settings); // settings may change mid-flight; one read per frame
          const anchor = pet.position;
          const ob = pet.opaqueBounds;
          const box = ob.width > 0 && ob.height > 0 ? boxFrom(ob, anchor) : POINT_BOX;
          const step = f.flight.step(dt, arenaFor(f.walls, box));
          lease.update({ x: step.x, y: step.y });
          for (const e of step.events) {
            if (e.type === 'wall-hit') onWallHit(s.hitStateMs, s.bounceMotion);
            else if (e.type === 'slide-start' && s.slideState) {
              f.slide = pet.showState('physics.slide', { priority: REACTION_STATE_PRIORITY });
            } else if (e.type === 'settled') {
              stopFlight(true);
              return;
            }
          }
        });
      };

      pet.on('input', (e) => {
        if (e.type === 'drag-start') {
          fade?.dispose();
          wobble?.dispose();
          // A mid-air catch grabs from where the flight is now.
          const p = flying ? flying.lease.value : pet.position;
          grab = { x: e.x - p.x, y: e.y - p.y };
          drag = pet.channel('position').request({ priority: DRAG_PRIORITY, value: p, preempt: true });
          // Preemption already revoked the flight lease; this also covers a kernel that revokes lazily.
          stopFlight(false);
          sampler.reset();
          sampler.push(p.x, p.y, now(), readSettings(ctx.settings).sampleWindowMs);
          wobble = pet.motion.add(
            { type: 'spring', property: 'rotate', drive: 'velocityX', gain: 0.02, max: 14, stiffness: 140, damping: 9 },
            { layer: 'physics' },
          );
          pet.play(GRAB, { layer: 'physics' });
        } else if (e.type === 'drag-move' && drag) {
          const p = { x: e.x - grab.x, y: e.y - grab.y };
          drag.update(p);
          sampler.push(p.x, p.y, now(), readSettings(ctx.settings).sampleWindowMs);
        } else if (e.type === 'drag-end' && drag) {
          const s = readSettings(ctx.settings);
          const at = drag.value;
          const v = sampler.velocity(now(), s);
          drag.release();
          drag = null;
          // Slow release = just drop where it is.
          if (v) startFlight(at, v, s);
          if (!flying) pet.play(LAND, { layer: 'physics' });
          // Let the wobble settle back once the pet stops moving.
          const w = wobble;
          fade = ctx.setTimeout(() => w?.dispose(), flying ? 2500 : 900);
        }
      });
    };
    ctx.pets.list().forEach(attach);
    ctx.pets.on('added', attach);
  },
});
