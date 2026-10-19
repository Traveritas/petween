// Agent signal path (docs/05 §1): raw hook → connector.parse → AgentEvent → session table → binding rule → brains.
// Session timeouts / watchdog parameters arrive with the connectors in M1.

import type { AgentEvent, BrainInstance, ConnectorDef, HookRequest, PetHandle, SessionInfo } from '../api/types';
import { Emitter } from './emitter';
import type { Pet } from './pet';
import type { Registries } from './registry';

export interface AgentHubDeps {
  registries: Registries;
  pets(): Pet[];
  /** Handle owned by the plugin that registered `brainId` / the binding rule. */
  viewFor(ownerPluginId: string, pet: Pet): PetHandle;
  setting<T>(key: string, fallback: T): T;
  log(level: 'info' | 'warn' | 'error', line: string): void;
}

type SessionPolicy = NonNullable<ConnectorDef['session']>;

/** v0 defaults: a stranded permission prompt after 10 min, a silent session after 30 min. */
const DEFAULT_POLICY: Required<SessionPolicy> = { waitingTimeoutMs: 600_000, disposeAfterMs: 1_800_000 };

export class AgentHub {
  private sessions = new Map<string, SessionInfo>();
  private brains = new Map<string, { brainId: string; instance: BrainInstance }>();
  /** Watchdog timers per session (docs/05 §3.1). */
  private watch = new Map<string, { policy: Required<SessionPolicy>; waiting?: ReturnType<typeof setTimeout>; dispose?: ReturnType<typeof setTimeout> }>();
  readonly event = new Emitter<AgentEvent>();

  constructor(private d: AgentHubDeps) {
    d.registries.brains.change.on(() => this.reattachAll());
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  ingest(req: HookRequest) {
    const c = this.d.registries.connectors.get(req.connectorId);
    if (!c) {
      this.d.log('warn', `hook for unknown connector "${req.connectorId}"`);
      return;
    }
    let events: AgentEvent[];
    try {
      events = c.parse(req) ?? [];
    } catch (e) {
      this.d.log('error', `connector ${c.id} failed to parse: ${e}`);
      return;
    }
    for (const e of events) this.dispatch(e, c.session);
  }

  dispatch(e: AgentEvent, policy?: SessionPolicy) {
    const key = `${e.agent}:${e.sessionId}`;
    const s = this.sessions.get(key);
    if (e.type === 'session-end') this.sessions.delete(key);
    else if (s) Object.assign(s, { lastEventAt: e.at, lastEvent: e.type });
    else this.sessions.set(key, { agent: e.agent, sessionId: e.sessionId, startedAt: e.at, lastEventAt: e.at, lastEvent: e.type });
    this.arm(key, e, policy);

    this.event.emit(e);

    const pets = this.d.pets();
    const rules = this.d.registries.bindingRules;
    const rule = rules.get(this.d.setting('binding', 'single')) ?? rules.list()[0];
    if (!rule) return;
    let targets: PetHandle[] = [];
    try {
      const owner = rules.ownerOf(rule.id)!;
      targets = rule.route(e, pets.map((p) => this.d.viewFor(owner, p)));
    } catch (err) {
      this.d.log('error', `binding rule ${rule.id} failed: ${err}`);
    }
    for (const t of targets) {
      const pet = pets.find((p) => p.id === t.id);
      if (!pet) continue;
      if (e.type === 'turn-start') pet.resetStickyVariants();
      const b = this.brains.get(pet.id);
      try {
        b?.instance.onEvent(e);
      } catch (err) {
        this.d.log('error', `brain ${b?.brainId} failed: ${err}`);
      }
    }
  }

  /** Reset this session's watchdog timers from its latest event. */
  private arm(key: string, e: AgentEvent, policy?: SessionPolicy) {
    let w = this.watch.get(key);
    if (w) {
      clearTimeout(w.waiting);
      clearTimeout(w.dispose);
    }
    if (e.type === 'session-end') {
      this.watch.delete(key);
      return;
    }
    if (!w) this.watch.set(key, (w = { policy: { ...DEFAULT_POLICY, ...policy } }));
    const synth = (type: AgentEvent['type'], extra: Partial<AgentEvent> = {}) => () =>
      this.dispatch({ agent: e.agent, sessionId: e.sessionId, at: Date.now(), type, ...extra, extra: { synthetic: 'watchdog' } });
    w.waiting = e.type === 'waiting' ? setTimeout(synth('turn-end', { outcome: 'interrupted' }), w.policy.waitingTimeoutMs) : undefined;
    w.dispose = setTimeout(synth('session-end'), w.policy.disposeAfterMs);
  }

  dispose() {
    for (const w of this.watch.values()) {
      clearTimeout(w.waiting);
      clearTimeout(w.dispose);
    }
    this.watch.clear();
  }

  attach(pet: Pet) {
    this.detach(pet);
    const brains = this.d.registries.brains;
    const def = brains.get(this.d.setting('brain', 'default')) ?? brains.list()[0];
    if (!def) {
      pet.state.setBase('idle');
      return;
    }
    try {
      const view = this.d.viewFor(brains.ownerOf(def.id)!, pet);
      const instance = def.create(view, (key) => pet.state.setBase(key));
      this.brains.set(pet.id, { brainId: def.id, instance });
    } catch (e) {
      this.d.log('error', `brain ${def.id} failed to start for ${pet.id}: ${e}`);
    }
  }

  detach(pet: Pet) {
    const b = this.brains.get(pet.id);
    if (!b) return;
    this.brains.delete(pet.id);
    try {
      b.instance.dispose?.();
    } catch (e) {
      this.d.log('error', `brain ${b.brainId} dispose failed: ${e}`);
    }
  }

  private reattachAll() {
    for (const p of this.d.pets()) this.attach(p);
  }
}
