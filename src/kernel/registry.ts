// Extension-point registries (docs/01 §3). Built-in and plugin entries register the same way.

import type { BindingRuleDef, BrainDef, ConnectorDef, Disposable, MotionType, TransitionTypeDef } from '../api/types';
import { Emitter } from './emitter';
import { toDisposable } from './scope';

export class Registry<T extends { id: string }> {
  private items = new Map<string, { def: T; owner: string }>();
  readonly change = new Emitter<void>();

  constructor(readonly name: string) {}

  add(def: T, owner: string): Disposable {
    if (!def || typeof def.id !== 'string' || !def.id) throw new Error(`${this.name}: id is required`);
    const existing = this.items.get(def.id);
    if (existing) throw new Error(`${this.name}: "${def.id}" already registered by ${existing.owner}`);
    this.items.set(def.id, { def, owner });
    this.change.emit();
    return toDisposable(() => {
      if (this.items.get(def.id)?.def === def) {
        this.items.delete(def.id);
        this.change.emit();
      }
    });
  }

  get(id: string): T | undefined {
    return this.items.get(id)?.def;
  }

  ownerOf(id: string) {
    return this.items.get(id)?.owner;
  }

  list(): T[] {
    return [...this.items.values()].map((i) => i.def);
  }
}

export class Registries {
  readonly connectors = new Registry<ConnectorDef>('connectors');
  readonly brains = new Registry<BrainDef>('brains');
  readonly motionTypes = new Registry<MotionType>('motionTypes');
  readonly transitionTypes = new Registry<TransitionTypeDef>('transitionTypes');
  readonly bindingRules = new Registry<BindingRuleDef>('bindingRules');
}
