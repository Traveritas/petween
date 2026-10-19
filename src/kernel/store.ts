// Per-plugin JSON stores (docs/01 §5, docs/06 §4 settings / data). Writes are debounced and atomic (host side).

import type { Disposable, Store } from '../api/types';
import { Emitter } from './emitter';
import type { Host } from './host';

export class FileStore implements Store {
  private values: Record<string, unknown> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly changeEv = new Emitter<string>();

  constructor(
    private host: Host | null,
    private path: string,
  ) {}

  async load() {
    if (!this.host) return this;
    try {
      if (await this.host.exists(this.path)) this.values = JSON.parse(await this.host.readText(this.path)) ?? {};
    } catch (e) {
      this.host.log('warn', `store ${this.path} unreadable, starting empty: ${e}`);
    }
    return this;
  }

  get<T>(key: string, fallback?: T): T {
    return (key in this.values ? this.values[key] : fallback) as T;
  }

  set(key: string, value: unknown) {
    if (value === undefined) return this.delete(key);
    this.values[key] = value;
    this.changeEv.emit(key);
    this.schedule();
  }

  delete(key: string) {
    if (!(key in this.values)) return;
    delete this.values[key];
    this.changeEv.emit(key);
    this.schedule();
  }

  all() {
    return { ...this.values };
  }

  onChange(fn: (key: string) => void): Disposable {
    return this.changeEv.on(fn);
  }

  private schedule() {
    if (!this.host) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 300);
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.host?.writeText(this.path, JSON.stringify(this.values, null, 2));
  }
}
