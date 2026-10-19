// One pet instance: channels (docs/02), appearance (docs/03 §4), motion stack (docs/03 §3).
// Plugins never get a Pet directly — they get a PetView that stamps their id as owner and
// cleans up everything they requested when they deactivate.

import type {
  BubbleChannel,
  ClipDef,
  ClipIntent,
  Disposable,
  ExclusiveChannel,
  InputEvent,
  Lease,
  LeaseRequest,
  MotionHandle,
  MotionOptions,
  MotionRef,
  MotionSource,
  PetHandle,
  PetPack,
  PetPackInfo,
  PlaybackEvent,
  Point,
  Rect,
  TransitionRef,
} from '../api/types';
import type { AssetCache } from '../render/assets';
import type { RenderPet } from '../render/dom2d';
import { Appearance, type Target, type TransitionPlan } from './appearance';
import { BubbleQueue, ExclusiveStack } from './channels';
import { Emitter } from './emitter';
import type { Transform } from './motion/compose';
import { MotionStack } from './motion/stack';
import { resolveAppearance, VariantPicker } from './pack/resolve';
import type { Registries } from './registry';
import type { Scope } from './scope';
import { toDisposable } from './scope';

export interface LoadedPack {
  pack: PetPack;
  /** Base URL that clip sources resolve against (ends with '/'). */
  baseUrl: string;
}

export interface PetEnv {
  registries: Registries;
  assets: AssetCache;
  reducedMotion(): boolean;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  /** Something changed that needs a frame. */
  wake(): void;
}

const DEFAULT_ANCHOR = { x: 0.5, y: 0.96 };

const inertHandle = (): MotionHandle => ({
  active: false,
  setWeight() {},
  onEnd: () => toDisposable(() => {}),
  onMarker: () => toDisposable(() => {}),
  dispose() {},
});

export class Pet {
  readonly state: ExclusiveStack<string>;
  readonly clip = new ExclusiveStack<ClipIntent | null>(null);
  readonly position: ExclusiveStack<Point>;
  readonly bubble = new BubbleQueue();
  readonly motions = new MotionStack();
  readonly appearance: Appearance;
  private picker = new VariantPicker();

  readonly stateKeyEv = new Emitter<string>();
  readonly clipEv = new Emitter<string>();
  readonly inputEv = new Emitter<InputEvent>();
  readonly playbackEv = new Emitter<PlaybackEvent>();
  readonly bubbleEv = new Emitter<{ owner: string; text: string } | null>();
  readonly basePositionEv = new Emitter<Point>();

  velocity: Point = { x: 0, y: 0 };
  z = 0;
  outline = false;
  private lastPos: Point;
  private lastTransform: Transform | null = null;
  private stateEnteredAt = 0;
  private resolvedKey = '';
  private chosenClip = '';
  private inlineClips = new WeakMap<object, string>();
  private inlineSeq = 0;

  constructor(
    readonly id: string,
    public loaded: LoadedPack,
    public scale: number,
    start: Point,
    private env: PetEnv,
  ) {
    this.state = new ExclusiveStack<string>('idle');
    this.position = new ExclusiveStack<Point>(start, true);
    this.lastPos = start;
    // Releasing a position lease leaves the pet where the lease put it (docs/02 position).
    this.position.onRemoved = (l, wasActive) => {
      if (wasActive) {
        this.position.setBase(l.value, false);
        this.basePositionEv.emit(l.value);
      }
    };
    this.appearance = new Appearance({
      play: (ref, layer) => this.startMotion(ref, layer, 'pack'),
      plan: (ref) => this.plan(ref),
    });
    this.appearance.clipChange.on((id) => this.clipEv.emit(id));
    this.appearance.playback.on((e) => this.playbackEv.emit(e));
    this.state.change.on((k) => {
      this.stateKeyEv.emit(k);
      env.wake();
    });
    this.clip.change.on(() => env.wake());
    this.position.change.on(() => env.wake());
    this.bubble.change.on((b) => this.bubbleEv.emit(b));
    this.motions.onOverBudget = (owner) => env.log('warn', `motion from ${owner} stopped: over frame budget`);
  }

  get packInfo(): PetPackInfo {
    const p = this.loaded.pack;
    return { id: p.id, name: p.name, attribution: p.attribution };
  }

  get pos(): Point {
    return this.position.value;
  }

  /** Teleport without a lease (rescue, restoring instances). */
  setBasePosition(p: Point) {
    this.position.setBase(p, false);
    this.basePositionEv.emit(p);
  }

  resetStickyVariants() {
    this.picker.resetSticky();
  }

  // ---------- motion refs ----------

  resolveMotion(ref: MotionRef): { type: string; params: Record<string, unknown> } | null {
    if (typeof ref === 'string') {
      const def = this.loaded.pack.motions?.[ref];
      if (!def) return null;
      const { type, ...params } = def;
      return { type, params };
    }
    if (!ref || typeof ref.type !== 'string') return null;
    const { type, ...params } = ref;
    return { type, params };
  }

  createSource(ref: MotionRef): { source: MotionSource; params: Record<string, unknown> } | null {
    const r = this.resolveMotion(ref);
    if (!r) {
      this.env.log('warn', `pet ${this.id}: unknown motion ${JSON.stringify(ref)}`);
      return null;
    }
    const type = this.env.registries.motionTypes.get(r.type);
    if (!type) {
      this.env.log('warn', `pet ${this.id}: motion type "${r.type}" is not registered`);
      return null;
    }
    try {
      return { source: type.create(r.params), params: r.params };
    } catch (e) {
      this.env.log('error', `motion type ${r.type} failed to create: ${e}`);
      return null;
    }
  }

  private startMotion(ref: MotionRef, layer: 'base' | 'transition', owner: string) {
    const s = this.createSource(ref);
    if (!s) return null;
    const handle = this.motions.add(s.source, { layer }, owner, s.params);
    this.env.wake();
    return { handle, markers: Object.values(s.source.markers ?? {}) };
  }

  addMotion(src: MotionSource | MotionRef, opts: MotionOptions, owner: string): MotionHandle {
    let source: MotionSource;
    let params: Record<string, unknown> = {};
    if (typeof src === 'object' && src !== null && 'evaluate' in src) source = src as MotionSource;
    else {
      const s = this.createSource(src as MotionRef);
      if (!s) return inertHandle();
      source = s.source;
      params = s.params;
    }
    const h = this.motions.add(source, opts, owner, params);
    this.env.wake();
    return h;
  }

  private plan(ref: TransitionRef | undefined): TransitionPlan {
    const r = ref ?? 'cut';
    const { type, params } = typeof r === 'string' ? { type: r, params: {} } : (() => {
      const { type, ...params } = r;
      return { type, params };
    })();
    const def = this.env.registries.transitionTypes.get(type);
    if (!def) return { crossfadeMs: 0 };
    try {
      return def.plan(params);
    } catch {
      return { crossfadeMs: 0 };
    }
  }

  // ---------- per frame ----------

  private target(now: number): Target | null {
    const intent = this.clip.value;
    const pack = this.loaded.pack;
    if (intent) {
      const clip: ClipDef | undefined = typeof intent.clip === 'string' ? pack.clips[intent.clip] : intent.clip;
      if (clip) {
        let clipId = typeof intent.clip === 'string' ? intent.clip : this.inlineClips.get(intent.clip);
        if (!clipId) {
          clipId = `inline:${++this.inlineSeq}`;
          this.inlineClips.set(intent.clip as object, clipId);
        }
        return { kind: 'clip', token: intent, clipId, clip, enter: intent.enter, transition: intent.transition };
      }
    }
    const { key, appearance } = resolveAppearance(pack, this.state.value);
    if (key !== this.resolvedKey) {
      this.resolvedKey = key;
      this.stateEnteredAt = now;
      this.chosenClip = this.picker.pick(key, appearance, now, now) ?? '';
    } else if (appearance.variant === 'cycle') {
      this.chosenClip = this.picker.pick(key, appearance, this.stateEnteredAt, now) ?? this.chosenClip;
    }
    const clip = pack.clips[this.chosenClip];
    if (!clip) return null;
    return { kind: 'state', resolvedKey: key, appearance, clipId: this.chosenClip, clip };
  }

  get animated() {
    return this.motions.size > 0 || this.appearance.animated;
  }

  /** Needs full frame rate: something beyond ambient loops is moving. */
  get busy() {
    return this.motions.hasForeground || this.appearance.transitioning || this.position.entries().length > 0;
  }

  tick(now: number, dt: number, view: PetHandle): RenderPet {
    const t = this.target(now);
    if (t) this.appearance.set(t, now);
    const layers = this.appearance.tick(now);

    const p = this.pos;
    if (dt > 0) {
      const a = 0.5;
      this.velocity = {
        x: this.velocity.x * (1 - a) + ((p.x - this.lastPos.x) / dt) * 1000 * a,
        y: this.velocity.y * (1 - a) + ((p.y - this.lastPos.y) / dt) * 1000 * a,
      };
      if (Math.abs(this.velocity.x) < 0.5 && Math.abs(this.velocity.y) < 0.5 && p.x === this.lastPos.x && p.y === this.lastPos.y) this.velocity = { x: 0, y: 0 };
    }
    this.lastPos = p;

    const reduced = this.env.reducedMotion();
    const transform = this.motions.evaluate(now, dt, (params) => ({ pet: view, params, strength: 1, reducedMotion: reduced }));
    this.lastTransform = transform;

    const packScale = this.loaded.pack.scale ?? 1;
    return {
      id: this.id,
      z: this.z,
      x: p.x,
      y: p.y,
      transform,
      outline: this.outline,
      layers: layers.map((l) => {
        const count = l.clip.type === 'frames' ? Math.max(1, l.clip.frames?.count ?? 1) : 1;
        return {
          src: new URL(l.clip.source, this.loaded.baseUrl).href,
          columns: l.clip.frames?.columns ?? count,
          count,
          frame: l.frame,
          opacity: l.opacity,
          anchor: l.clip.anchor ?? DEFAULT_ANCHOR,
          scale: (l.clip.scale ?? 1) * packScale * this.scale,
        };
      }),
    };
  }

  /** Picture box on the desktop (before motion transforms). */
  bounds(): Rect {
    const t = this.appearance.current;
    const p = this.pos;
    if (!t) return { x: p.x, y: p.y, width: 0, height: 0 };
    const count = t.clip.type === 'frames' ? Math.max(1, t.clip.frames?.count ?? 1) : 1;
    const a = this.env.assets.get(new URL(t.clip.source, this.loaded.baseUrl).href, t.clip.frames?.columns ?? count, count);
    if (!a) return { x: p.x, y: p.y, width: 0, height: 0 };
    const s = (t.clip.scale ?? 1) * (this.loaded.pack.scale ?? 1) * this.scale;
    const w = a.frameW * s, h = a.frameH * s;
    const anchor = t.clip.anchor ?? DEFAULT_ANCHOR;
    return { x: p.x - anchor.x * w, y: p.y - anchor.y * h, width: w, height: h };
  }

  get transform() {
    return this.lastTransform;
  }

  dispose() {
    this.appearance.dispose();
    this.motions.clear();
    this.state.clear();
    this.clip.clear();
    this.position.clear();
    this.bubble.clear();
  }
}

// ---------- the handle plugins see ----------

function ownedChannel<T>(ch: ExclusiveStack<T>, owner: string, scope: Scope): ExclusiveChannel<T> {
  return {
    request: (req: LeaseRequest<T>): Lease<T> => {
      const l = ch.request(req, owner);
      scope.track(l);
      return l;
    },
    get value() {
      return ch.value;
    },
    entries: () => ch.entries(),
  };
}

export function petView(pet: Pet, owner: string, scope: Scope): PetHandle {
  const track = <T extends Disposable>(d: T) => {
    scope.track(d);
    return d;
  };
  const channels = {
    state: ownedChannel(pet.state, owner, scope),
    clip: ownedChannel(pet.clip, owner, scope),
    position: ownedChannel(pet.position, owner, scope),
    bubble: {
      say: (req) => track(pet.bubble.say(req, owner)),
      get current() {
        return pet.bubble.current;
      },
      entries: () => pet.bubble.entries(),
    } satisfies BubbleChannel,
  };
  const motion = {
    add: (src: MotionSource | MotionRef, opts: MotionOptions = {}) => track(pet.addMotion(src, opts, owner)),
  };
  const view: PetHandle = {
    id: pet.id,
    get pack() {
      return pet.packInfo;
    },
    get position() {
      return pet.pos;
    },
    get velocity() {
      return pet.velocity;
    },
    get bounds() {
      return pet.bounds();
    },
    get stateKey() {
      return pet.state.value;
    },
    on(event: string, fn: (v: never) => void): Disposable {
      const ev =
        event === 'stateKey' ? pet.stateKeyEv
        : event === 'clip' ? pet.clipEv
        : event === 'input' ? pet.inputEv
        : event === 'playback' ? pet.playbackEv
        : event === 'bubble' ? pet.bubbleEv
        : null;
      if (!ev) throw new Error(`unknown pet event ${event}`);
      return track((ev as Emitter<unknown>).on(fn as (v: unknown) => void));
    },
    channel: ((name: keyof typeof channels) => {
      const c = channels[name];
      if (!c) throw new Error(`unknown channel ${name}`);
      return c;
    }) as PetHandle['channel'],
    motion,
    showState: (key, opts = {}) => channels.state.request({ priority: opts.priority ?? 40, value: key, releaseOn: opts.releaseOn }),
    say: (text, opts = {}) => channels.bubble.say({ text, ...opts }),
    play: (m, opts = {}) => motion.add(m, { layer: 'plugin', ...opts }),
    pluginConfig: <T,>() => pet.loaded.pack.plugins?.[owner] as T | undefined,
  };
  return view;
}
