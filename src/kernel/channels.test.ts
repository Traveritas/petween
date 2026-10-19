import { describe, expect, it, vi } from 'vitest';
import { BubbleQueue, ExclusiveStack } from './channels';

describe('ExclusiveStack (docs/02 §2)', () => {
  it('base value is the bottom and never released', () => {
    const s = new ExclusiveStack('idle');
    expect(s.value).toBe('idle');
    s.setBase('active');
    expect(s.value).toBe('active');
  });

  it('higher priority suppresses, release restores — no revoke by default', () => {
    const s = new ExclusiveStack('idle');
    const low = s.request({ priority: 20, value: 'roamer.walk' }, 'roamer');
    const high = s.request({ priority: 40, value: 'wave' }, 'notify');
    const revoked = vi.fn();
    low.onRevoked(revoked);
    expect(s.value).toBe('wave');
    expect(low.active).toBe(false);
    expect(high.active).toBe(true);
    high.release();
    expect(s.value).toBe('roamer.walk');
    expect(low.active).toBe(true);
    expect(revoked).not.toHaveBeenCalled();
  });

  it('equal priority queues behind the current top', () => {
    const s = new ExclusiveStack('idle');
    const a = s.request({ priority: 40, value: 'a' }, 'p1');
    const b = s.request({ priority: 40, value: 'b' }, 'p2');
    expect(s.value).toBe('a');
    expect(b.active).toBe(false);
    a.release();
    expect(s.value).toBe('b');
  });

  it('preempt revokes equal-or-lower holders', () => {
    const s = new ExclusiveStack({ x: 0, y: 0 }, true);
    const a = s.request({ priority: 20, value: { x: 1, y: 1 } }, 'roamer');
    const revoked = vi.fn();
    a.onRevoked(revoked);
    s.request({ priority: 95, value: { x: 2, y: 2 } }, 'physics');
    expect(revoked).toHaveBeenCalledOnce();
    expect(a.revoked).toBe(true);
    expect(s.entries()).toHaveLength(1);
  });

  it('signal-change leases end when the base moves', () => {
    const s = new ExclusiveStack('idle');
    const l = s.request({ priority: 40, value: 'oops', releaseOn: 'signal-change' }, 'p');
    s.setBase('idle');
    expect(l.revoked).toBe(false);
    s.setBase('active');
    expect(l.revoked).toBe(true);
    expect(s.value).toBe('active');
  });

  it('update only changes the output while active; change fires once per value', () => {
    const s = new ExclusiveStack('idle');
    const changes: string[] = [];
    s.change.on((v) => changes.push(v));
    const l = s.request({ priority: 10, value: 'a' }, 'p');
    l.update('b');
    l.release();
    expect(changes).toEqual(['a', 'b', 'idle']);
  });

  it('onRemoved reports whether the lease was on top', () => {
    const s = new ExclusiveStack(0);
    const seen: [number, boolean][] = [];
    s.onRemoved = (l, wasActive) => seen.push([l.value, wasActive]);
    const a = s.request({ priority: 10, value: 1 }, 'a');
    const b = s.request({ priority: 20, value: 2 }, 'b');
    a.release();
    b.release();
    expect(seen).toEqual([[1, false], [2, true]]);
  });
});

describe('BubbleQueue', () => {
  it('higher priority cuts in line but does not interrupt', () => {
    vi.useFakeTimers();
    const q = new BubbleQueue();
    q.say({ text: 'first', priority: 10, ttlMs: 1000 }, 'a');
    q.say({ text: 'low', priority: 10, ttlMs: 1000 }, 'b');
    q.say({ text: 'urgent', priority: 80, ttlMs: 1000 }, 'c');
    expect(q.current?.text).toBe('first');
    vi.advanceTimersByTime(1000);
    expect(q.current?.text).toBe('urgent');
    vi.advanceTimersByTime(1000);
    expect(q.current?.text).toBe('low');
    vi.advanceTimersByTime(1000);
    expect(q.current).toBeNull();
    vi.useRealTimers();
  });

  it('disposing a waiting bubble removes it', () => {
    const q = new BubbleQueue();
    q.say({ text: 'a', ttlMs: 0 }, 'x');
    const b = q.say({ text: 'b', ttlMs: 0 }, 'x');
    b.dispose();
    expect(q.entries().map((e) => e.text)).toEqual(['a']);
  });
});
