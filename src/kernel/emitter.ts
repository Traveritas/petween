import type { Disposable } from '../api/types';
import { toDisposable } from './scope';

/** Minimal emitter. Listener errors are caught so one plugin cannot break another (docs/06 §1). */
export class Emitter<T> {
  private fns = new Set<(v: T) => void>();

  on(fn: (v: T) => void): Disposable {
    this.fns.add(fn);
    return toDisposable(() => this.fns.delete(fn));
  }

  emit(v: T) {
    for (const fn of [...this.fns]) {
      try {
        fn(v);
      } catch (e) {
        console.error('listener failed', e);
      }
    }
  }

  get size() {
    return this.fns.size;
  }
}
