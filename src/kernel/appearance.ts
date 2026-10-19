// Appearance controller: turns "what should be shown" into clip playback + enter/exit/loop motions,
// following the switch timing in docs/03 §4.
//
//   A exit (optional, skipped when interrupted) → B enter motion → clip swaps at its 'swap' marker
//   (or at once) → swap may be gated by the transition (outgoing marker / loop end) → B loops on base layer.
//   A new target mid-flow cancels the flow and starts again from whatever picture is on screen.

import type { ClipDef, MotionHandle, MotionRef, StateAppearance, TransitionRef } from '../api/types';
import { Emitter } from './emitter';
import { ClipPlayback } from './pack/playback';

export type Target =
  | { kind: 'state'; resolvedKey: string; appearance: StateAppearance; clipId: string; clip: ClipDef }
  | { kind: 'clip'; token: object; clipId: string; clip: ClipDef; enter?: MotionRef; transition?: TransitionRef };

export interface TransitionPlan {
  crossfadeMs: number;
  waitFor?: { marker: string } | 'loop-end';
}

export interface AppearanceDeps {
  /** Start a motion on a layer; null when the reference cannot be resolved. */
  play(ref: MotionRef, layer: 'base' | 'transition'): { handle: MotionHandle; markers: string[] } | null;
  plan(ref: TransitionRef | undefined): TransitionPlan;
}

export interface ShownLayer {
  clipId: string;
  clip: ClipDef;
  frame: number;
  opacity: number;
}

interface Flow {
  phase: 'exit' | 'enter';
  to: Target;
  exitMotion: MotionHandle | null;
  exitMotionDone: boolean;
  exitClipDone: boolean;
  enterMotion: MotionHandle | null;
  swapReady: boolean;
  swapped: boolean;
  enterDone: boolean;
  plan: TransitionPlan;
}

const frameCount = (c: ClipDef) => (c.type === 'frames' ? (c.frames?.count ?? 1) : 1);

function sameTarget(a: Target, b: Target): boolean {
  if (a.kind === 'state' && b.kind === 'state') return a.resolvedKey === b.resolvedKey && a.clipId === b.clipId;
  if (a.kind === 'clip' && b.kind === 'clip') return a.token === b.token;
  return false;
}

export class Appearance {
  private shown: { pb: ClipPlayback; target: Target } | null = null;
  private fade: { pb: ClipPlayback; start: number; ms: number; frame: number } | null = null;
  private loops: MotionHandle[] = [];
  private flow: Flow | null = null;
  private target: Target | null = null;

  readonly clipChange = new Emitter<string>();
  readonly playback = new Emitter<{ clip: string; kind: 'marker' | 'loop' | 'end'; marker?: string }>();

  constructor(private deps: AppearanceDeps) {}

  get current(): Target | null {
    return this.target;
  }

  /** A switch is in progress (flow or crossfade). */
  get transitioning() {
    return !!this.flow || !!this.fade;
  }

  /** Whether frames need redrawing even with no motion running. */
  get animated() {
    return !!this.flow || !!this.fade || !!this.shown?.pb.animated;
  }

  set(t: Target, now: number) {
    if (this.target && sameTarget(this.target, t)) {
      this.target = t;
      return;
    }
    const prev = this.target;
    this.target = t;

    if (!this.shown) {
      this.shown = { pb: new ClipPlayback(t.clipId, t.clip, now, frameCount(t.clip)), target: t };
      this.clipChange.emit(t.clipId);
      this.flow = this.newFlow(t, 'enter');
      this.flow.swapped = true;
      this.startEnter(now);
      return;
    }

    // Same state, different variant (cycle): plain clip swap, no motions.
    if (prev && prev.kind === 'state' && t.kind === 'state' && prev.resolvedKey === t.resolvedKey && !this.flow) {
      const plan = this.deps.plan(t.appearance.transition);
      this.swap(t, now, plan.crossfadeMs);
      return;
    }

    const interrupted = this.flow !== null;
    this.cancelFlow();
    this.flow = this.newFlow(t, 'exit');
    const from = this.shown.target;
    const exitRef = !interrupted && from.kind === 'state' ? from.appearance.exit : undefined;
    const exitMotion = exitRef ? this.deps.play(exitRef, 'transition') : null;
    const exitClip = !interrupted && this.shown.pb.startExit(now);
    if (!exitMotion && !exitClip) {
      this.startEnter(now);
      return;
    }
    const flow = this.flow;
    flow.exitClipDone = !exitClip;
    flow.exitMotion = exitMotion?.handle ?? null;
    flow.exitMotionDone = !exitMotion;
    exitMotion?.handle.onEnd(() => {
      flow.exitMotionDone = true;
    });
  }

  private newFlow(to: Target, phase: 'exit' | 'enter'): Flow {
    const ref = to.kind === 'state' ? to.appearance.transition : to.transition;
    return {
      phase,
      to,
      exitMotion: null,
      exitMotionDone: true,
      exitClipDone: true,
      enterMotion: null,
      swapReady: false,
      swapped: false,
      enterDone: false,
      plan: this.deps.plan(ref),
    };
  }

  private startEnter(_now: number) {
    const flow = this.flow!;
    flow.phase = 'enter';
    flow.exitMotion?.dispose();
    flow.exitMotion = null;
    this.stopLoops();
    const ref = flow.to.kind === 'state' ? flow.to.appearance.enter : flow.to.enter;
    const enter = ref ? this.deps.play(ref, 'transition') : null;
    if (!enter) {
      flow.swapReady = true;
      flow.enterDone = true;
      this.startLoops(flow.to);
      return;
    }
    flow.enterMotion = enter.handle;
    flow.swapReady = !enter.markers.includes('swap');
    enter.handle.onMarker((m) => {
      if (m === 'swap' && this.flow === flow) flow.swapReady = true;
    });
    enter.handle.onEnd(() => {
      if (this.flow !== flow) return;
      flow.enterDone = true;
      flow.enterMotion = null;
      this.startLoops(flow.to);
    });
  }

  private startLoops(t: Target) {
    this.stopLoops();
    if (t.kind !== 'state') return;
    for (const ref of t.appearance.loop ?? []) {
      const m = this.deps.play(ref, 'base');
      if (m) this.loops.push(m.handle);
    }
  }

  private stopLoops() {
    for (const l of this.loops) l.dispose();
    this.loops = [];
  }

  private cancelFlow() {
    if (!this.flow) return;
    this.flow.exitMotion?.dispose();
    this.flow.enterMotion?.dispose();
    this.flow = null;
  }

  private swap(to: Target, now: number, crossfadeMs: number) {
    const cur = this.shown!;
    if (cur.target.clipId === to.clipId && cur.target.clip === to.clip) {
      cur.target = to;
      return;
    }
    if (crossfadeMs > 0) this.fade = { pb: cur.pb, start: now, ms: crossfadeMs, frame: 0 };
    this.shown = { pb: new ClipPlayback(to.clipId, to.clip, now, frameCount(to.clip)), target: to };
    this.clipChange.emit(to.clipId);
  }

  tick(now: number): ShownLayer[] {
    if (!this.shown) return [];
    const res = this.shown.pb.tick(now);
    const clipId = this.shown.target.clipId;
    for (const m of res.markers) this.playback.emit({ clip: clipId, kind: 'marker', marker: m });
    if (res.wrapped) this.playback.emit({ clip: clipId, kind: 'loop' });

    const flow = this.flow;
    if (flow) {
      if (flow.phase === 'exit') {
        if (res.ended) flow.exitClipDone = true;
        if (flow.exitClipDone && flow.exitMotionDone) {
          if (res.ended) this.playback.emit({ clip: clipId, kind: 'end' });
          this.startEnter(now);
        }
      }
      if (this.flow === flow && flow.phase === 'enter') {
        if (flow.swapReady && !flow.swapped) {
          const w = flow.plan.waitFor;
          const gateOpen =
            !w ||
            !this.shown.pb.animated ||
            (w === 'loop-end' ? res.wrapped || this.shown.pb.segment !== 'loop' : res.markers.includes(w.marker));
          if (gateOpen) {
            this.swap(flow.to, now, flow.plan.crossfadeMs);
            flow.swapped = true;
          }
        }
        if (flow.swapped && flow.enterDone) this.flow = null;
      }
    }

    const layers: ShownLayer[] = [];
    if (this.fade) {
      const p = (now - this.fade.start) / this.fade.ms;
      if (p >= 1) this.fade = null;
      else {
        this.fade.frame = this.fade.pb.tick(now).frame;
        layers.push({ clipId: this.fade.pb.id, clip: this.fade.pb.clip, frame: this.fade.frame, opacity: 1 });
        layers.push({ clipId: this.shown.target.clipId, clip: this.shown.target.clip, frame: res.frame, opacity: p });
        return layers;
      }
    }
    layers.push({ clipId: this.shown.target.clipId, clip: this.shown.target.clip, frame: res.frame, opacity: 1 });
    return layers;
  }

  dispose() {
    this.cancelFlow();
    this.stopLoops();
    this.shown = null;
    this.fade = null;
    this.target = null;
  }
}
