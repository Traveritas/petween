// Channel arbitration (docs/02). Exclusive stacks hold leases; the top wins.
// Default is "suppress, don't revoke": a lower lease comes back by itself when the higher one is released.

import type { BubbleChannel, BubbleHandle, BubbleRequest, Disposable, ExclusiveChannel, Lease, LeaseRequest } from '../api/types';
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

// ---------- bubble queue: priority first, then first-come ----------

class BubbleImpl implements BubbleHandle {
  readonly order = ++seq;
  showing = false;
  timer: ReturnType<typeof setTimeout> | null = null;
  readonly showEv = new Emitter<void>();
  readonly hideEv = new Emitter<void>();
  constructor(
    private q: BubbleQueue,
    readonly owner: string,
    readonly text: string,
    readonly priority: number,
    readonly ttlMs: number,
  ) {}
  dispose() {
    this.q.remove(this);
  }
  onShow(fn: () => void) {
    return this.showEv.on(fn);
  }
  onHide(fn: () => void) {
    return this.hideEv.on(fn);
  }
}

export class BubbleQueue implements BubbleChannel {
  private items: BubbleImpl[] = [];
  readonly change = new Emitter<{ owner: string; text: string } | null>();

  say(req: BubbleRequest, owner = 'unknown'): BubbleHandle {
    const b = new BubbleImpl(this, owner, req.text, req.priority ?? 50, req.ttlMs ?? 4000);
    this.items.push(b);
    this.items.sort((a, c) => Number(c.showing) - Number(a.showing) || c.priority - a.priority || a.order - c.order);
    this.pump();
    return b;
  }

  get current() {
    const b = this.items.find((i) => i.showing);
    return b ? { owner: b.owner, text: b.text } : null;
  }

  remove(b: BubbleImpl) {
    const i = this.items.indexOf(b);
    if (i < 0) return;
    this.items.splice(i, 1);
    if (b.timer) clearTimeout(b.timer);
    if (b.showing) {
      b.showing = false;
      b.hideEv.emit();
    }
    this.pump();
  }

  /** A higher-priority bubble cuts in line but does not interrupt the one showing. */
  private pump() {
    const showing = this.items.find((i) => i.showing);
    if (!showing && this.items.length) {
      const b = this.items[0];
      b.showing = true;
      b.showEv.emit();
      if (b.ttlMs > 0) b.timer = setTimeout(() => this.remove(b), b.ttlMs);
      this.change.emit(this.current);
    } else if (!showing) {
      this.change.emit(null);
    }
  }

  entries() {
    return this.items.map((b) => ({ owner: b.owner, text: b.text, priority: b.priority, showing: b.showing }));
  }

  clear() {
    for (const b of [...this.items]) this.remove(b);
  }
}
