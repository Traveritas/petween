import type { Disposable } from '../api/types';

/** Collects disposables; disposing the scope disposes everything registered in it (docs/06 §3). */
export class Scope implements Disposable {
  private items = new Set<Disposable>();
  private disposed = false;

  add<T extends Disposable>(d: T): T {
    if (this.disposed) {
      d.dispose();
      return d;
    }
    this.items.add(d);
    return d;
  }

  /** Wrap a disposable so disposing it early also forgets it here. */
  track(d: Disposable): Disposable {
    const wrapped: Disposable = {
      dispose: () => {
        this.items.delete(wrapped);
        d.dispose();
      },
    };
    return this.add(wrapped);
  }

  get isDisposed() {
    return this.disposed;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const d of [...this.items].reverse()) {
      try {
        d.dispose();
      } catch (e) {
        console.error('dispose failed', e);
      }
    }
    this.items.clear();
  }
}

export const toDisposable = (fn: () => void): Disposable => {
  let done = false;
  return {
    dispose() {
      if (!done) {
        done = true;
        fn();
      }
    },
  };
};
