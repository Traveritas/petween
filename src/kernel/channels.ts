// Channel arbitration (docs/02). Exclusive stacks hold leases; the top wins.
// Default is "suppress, don't revoke": a lower lease comes back by itself when the higher one is released.

import type { BubbleChannel, BubbleHandle, BubbleRequest, Disposable, ExclusiveChannel, Lease, LeaseRequest, ShownBubble } from '../api/types';
import { Emitter } from './emitter';

let seq = 0;

class LeaseImpl<T> implements Lease<T> {
  readonly order = ++seq;
  active = false;
  revoked = false;
  readonly activeChange = new Emitter<boolean>();
  readonly revokedEv = new Emitter<void>();

  constructor(
    private ch: ExclusiveStack<T>,
    readonly owner: string,
    readonly priority: number,
    public value: T,
    readonly releaseOn: 'never' | 'signal-change',
  ) {}

  update(value: T) {
    if (this.revoked) return;
    this.value = value;
    if (this.active) this.ch.changed();
  }
  release() {
    this.ch.remove(this, false);
  }
  dispose() {
    this.release();
  }
  onActiveChange(fn: (a: boolean) => void): Disposable {
    return this.activeChange.on(fn);
  }
  onRevoked(fn: () => void): Disposable {
    return this.revokedEv.on(fn);
  }
}

export class ExclusiveStack<T> implements ExclusiveChannel<T> {
  /** Sorted: highest priority first; within a priority, earlier requests first. */
  private stack: LeaseImpl<T>[] = [];
  readonly change = new Emitter<T>();
  private last: T;
  /** Called with a lease after it leaves the stack (position uses it to keep the last value). */
  onRemoved?: (l: Lease<T>, wasActive: boolean) => void;

  /** `base` is the bottom value (priority 0, e.g. the brain's output) — not a lease, never released. */
  constructor(
    private base: T,
    private defaultPreempt = false,
  ) {
    this.last = base;
  }

  get value(): T {
    return this.stack.length ? this.stack[0].value : this.base;
  }

  get baseValue() {
    return this.base;
  }

  /** Replace the bottom value. Leases with releaseOn 'signal-change' end when it moves. */
  setBase(v: T, signalChanged = true) {
    const moved = v !== this.base;
    this.base = v;
    if (moved && signalChanged) {
      for (const l of [...this.stack]) if (l.releaseOn === 'signal-change') this.remove(l, false);
    }
    this.changed();
  }

  request(req: LeaseRequest<T>, owner = 'unknown'): Lease<T> {
    const lease = new LeaseImpl(this, owner, req.priority, req.value, req.releaseOn ?? 'never');
    if (req.preempt ?? this.defaultPreempt) {
      for (const l of [...this.stack]) if (l.priority <= req.priority) this.remove(l, true);
    }
    this.stack.push(lease);
    this.stack.sort((a, b) => b.priority - a.priority || a.order - b.order);
    this.refreshActive();
    this.changed();
    return lease;
  }

  remove(l: LeaseImpl<T>, revoke: boolean) {
    const i = this.stack.indexOf(l);
    if (i < 0) return;
    this.stack.splice(i, 1);
    l.revoked = true;
    const wasActive = l.active;
    if (l.active) {
      l.active = false;
      l.activeChange.emit(false);
    }
    if (revoke) l.revokedEv.emit();
    this.onRemoved?.(l, wasActive);
    this.refreshActive();
    this.changed();
  }

  private refreshActive() {
    this.stack.forEach((l, i) => {
      const a = i === 0;
      if (l.active !== a) {
        l.active = a;
        l.activeChange.emit(a);
      }
    });
  }

  changed() {
    const v = this.value;
    if (v !== this.last) {
      this.last = v;
      this.change.emit(v);
    }
  }

  entries() {
    return this.stack.map((l) => ({ owner: l.owner, priority: l.priority, value: l.value, active: l.active }));
  }

  clear() {
    for (const l of [...this.stack]) this.remove(l, true);
  }
}

// ---------- bubbles: parallel lanes, each a queue (priority first, then first-come) ----------
// A lane is (speaking plugin, group). One bubble shows per lane; different lanes show together,
// so one pet can carry many sessions' bubbles at once (docs/02 §1). Where they go on screen is
// the renderer's business.

let bubbleSeq = 0;

class BubbleImpl implements BubbleHandle {
  readonly id = ++bubbleSeq;
  readonly order = ++seq;
  showing = false;
  pulse = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  readonly showEv = new Emitter<void>();
  readonly hideEv = new Emitter<void>();
  readonly lane: string;
  constructor(
    private q: BubbleQueue,
    readonly owner: string,
    public req: BubbleRequest & { group: string; kind: string; priority: number; ttlMs: number },
  ) {
    this.lane = `${owner}\n${req.group}`;
  }
  get text() {
    return this.req.text;
  }
  update(patch: Partial<Pick<BubbleRequest, 'text' | 'label' | 'value' | 'note'>>, opts?: { pulse?: boolean }) {
    this.req = { ...this.req, ...patch };
    if (opts?.pulse) this.pulse++;
    this.q.changed(this);
  }
  dispose() {
    this.q.remove(this);
  }
  onShow(fn: () => void) {
    return this.showEv.on(fn);
  }
  onHide(fn: () => void) {
    return this.hideEv.on(fn);
  }
  shown(): ShownBubble {
    const r = this.req;
    return { id: this.id, owner: this.owner, text: r.text, kind: r.kind, group: r.group, session: r.session, label: r.label, value: r.value, note: r.note, priority: r.priority, pulse: this.pulse };
  }
}

export class BubbleQueue implements BubbleChannel {
  private items: BubbleImpl[] = [];
  /** Order bubbles went on screen, for `current` and `showing()`. */
  private shownOrder: BubbleImpl[] = [];
  /** Most recently shown bubble, or null (single-bubble renderers). */
  readonly change = new Emitter<{ owner: string; text: string } | null>();
  /** Everything on screen, on every show / update / hide. */
  readonly list = new Emitter<ShownBubble[]>();

  say(req: BubbleRequest, owner = 'unknown'): BubbleHandle {
    const b = new BubbleImpl(this, owner, { ...req, group: req.group ?? '', kind: req.kind ?? 'speech', priority: req.priority ?? 50, ttlMs: req.ttlMs ?? 4000 });
    this.items.push(b);
    this.pump(b.lane);
    return b;
  }

  get current() {
    const b = this.shownOrder.at(-1);
    return b ? { owner: b.owner, text: b.text } : null;
  }

  showing(): ShownBubble[] {
    return this.shownOrder.map((b) => b.shown());
  }

  remove(b: BubbleImpl) {
    const i = this.items.indexOf(b);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (b.timer) clearTimeout(b.timer);
    if (b.showing) {
      b.showing = false;
      this.shownOrder.splice(this.shownOrder.indexOf(b), 1);
      b.hideEv.emit();
      this.pump(b.lane, true);
    }
  }

  changed(b: BubbleImpl) {
    if (b.showing) this.emit();
  }

  /** A higher-priority bubble cuts in line but does not interrupt the one showing in its lane. */
  private pump(lane: string, hid = false) {
    const queued = this.items.filter((i) => i.lane === lane);
    if (queued.some((i) => i.showing)) return;
    const next = queued.sort((a, c) => c.req.priority - a.req.priority || a.order - c.order)[0];
    if (next) {
      next.showing = true;
      this.shownOrder.push(next);
      next.showEv.emit();
      if (next.req.ttlMs > 0) next.timer = setTimeout(() => this.remove(next), next.req.ttlMs);
    } else if (!hid) return;
    this.emit();
  }

  private emit() {
    this.change.emit(this.current);
    this.list.emit(this.showing());
  }

  entries() {
    return this.items.map((b) => ({ owner: b.owner, text: b.text, priority: b.req.priority, showing: b.showing, group: b.req.group, kind: b.req.kind }));
  }

  clear() {
    for (const b of [...this.items]) this.remove(b);
  }
}
