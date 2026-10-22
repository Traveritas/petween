// The editor's view of motions (docs/03 §3, docs/04 §6): the pack's named motions, keyframe edits,
// and the user's motion library. Pure, so it is unit-tested.

import type { MotionRef, PetPack, StateAppearance } from '../api/types';
import { restValue, isProperty } from '../kernel/motion/compose';
import type { EaseSpec } from '../kernel/motion/easing';

export type MotionDef = { type: string; [param: string]: unknown };

export interface Key {
  t: number;
  v: number;
  ease?: EaseSpec;
}

export type Repeat = true | { gapMs: number | [number, number] };

// ---------- the pack's named motions ----------

export type MotionUse = { key: string; field: 'enter' | 'loop' | 'exit' };

/** Which states use a named motion, and where. */
export function motionUsers(pack: PetPack, name: string): MotionUse[] {
  const out: MotionUse[] = [];
  for (const [key, a] of Object.entries(pack.states)) {
    if (a.enter === name) out.push({ key, field: 'enter' });
    if (a.loop?.some((r) => r === name)) out.push({ key, field: 'loop' });
    if (a.exit === name) out.push({ key, field: 'exit' });
  }
  return out;
}

/** `base`, else `base 2`, `base 3`… — whichever is free. */
export function uniqueName(taken: Iterable<string>, base: string): string {
  const set = new Set(taken);
  const b = base.trim() || '动作';
  if (!set.has(b)) return b;
  for (let n = 2; ; n++) if (!set.has(`${b} ${n}`)) return `${b} ${n}`;
}

export function putMotion(pack: PetPack, name: string, def: MotionDef): PetPack {
  return { ...pack, motions: { ...pack.motions, [name]: def } };
}

/** Rewrite every state's references to a named motion (`to` null = drop them). */
function mapRefs(pack: PetPack, from: string, to: string | null): Record<string, StateAppearance> {
  const swap = (r: MotionRef | undefined) => (r === from ? (to ?? undefined) : r);
  const states: Record<string, StateAppearance> = {};
  for (const [k, a] of Object.entries(pack.states)) {
    const next: StateAppearance = { ...a, enter: swap(a.enter), exit: swap(a.exit) };
    if (a.loop) next.loop = a.loop.flatMap((r) => (r === from ? (to ? [to] : []) : [r]));
    for (const f of ['enter', 'exit', 'loop'] as const) if (next[f] === undefined) delete next[f];
    states[k] = next;
  }
  return states;
}

/** Rename a motion, keeping its place in the list and every state's reference to it. */
export function renameMotion(pack: PetPack, from: string, to: string): PetPack {
  const name = to.trim();
  if (!name || name === from || !pack.motions?.[from] || pack.motions[name]) return pack;
  const motions: Record<string, MotionDef> = {};
  for (const [k, d] of Object.entries(pack.motions)) motions[k === from ? name : k] = d;
  return { ...pack, motions, states: mapRefs(pack, from, name) };
}

/** Delete a motion; states that used it stop using it. */
export function deleteMotion(pack: PetPack, name: string): PetPack {
  if (!pack.motions?.[name]) return pack;
  const motions = { ...pack.motions };
  delete motions[name];
  return { ...pack, motions, states: mapRefs(pack, name, null) };
}

/** Copy a motion (from a preset, the library or another pack) in under a free name. */
export function addMotion(pack: PetPack, name: string, def: MotionDef): { pack: PetPack; name: string } {
  const n = uniqueName(Object.keys(pack.motions ?? {}), name);
  return { pack: putMotion(pack, n, structuredClone(def)), name: n };
}

// ---------- new motions ----------

export const NEW_MOTIONS: { id: string; label: string; def: MotionDef }[] = [
  {
    id: 'once',
    label: 'K 帧 · 播一次（进入 / 离开用）',
    def: { type: 'keyframes', tracks: { y: [{ t: 0, v: 0 }, { t: 150, v: -8, ease: 'out' }, { t: 300, v: 0, ease: 'in' }] } },
  },
  {
    id: 'repeat',
    label: 'K 帧 · 隔一阵播一次（持续用）',
    def: { type: 'keyframes', tracks: { y: [{ t: 0, v: 0 }, { t: 150, v: -6, ease: 'out' }, { t: 300, v: 0, ease: 'in' }] }, repeat: { gapMs: [800, 1600] } },
  },
  { id: 'sine', label: '来回摆（呼吸、摇摆）', def: { type: 'sine', property: 'rotate', amplitude: 1.5, periodMs: 3000 } },
  { id: 'noise', label: '随机晃', def: { type: 'noise', property: 'rotate', amplitude: 2, frequency: 1 } },
  { id: 'spring', label: '弹簧（弹一下）', def: { type: 'spring', property: 'scaleY', impulse: 1, stiffness: 180, damping: 10 } },
];

// ---------- keyframes ----------

export function tracksOf(def: MotionDef): Record<string, Key[]> {
  return (def.tracks && typeof def.tracks === 'object' ? def.tracks : {}) as Record<string, Key[]>;
}

export function markersOf(def: MotionDef): Record<string, string> {
  return (def.markers && typeof def.markers === 'object' ? def.markers : {}) as Record<string, string>;
}

/** Where the last key or marker sits (ms). */
export function kfEnd(def: MotionDef): number {
  let end = 0;
  for (const ks of Object.values(tracksOf(def))) for (const k of ks) end = Math.max(end, k.t);
  for (const ms of Object.keys(markersOf(def))) end = Math.max(end, Number(ms) || 0);
  return end;
}

const sortKeys = (ks: Key[]) => [...ks].sort((a, b) => a.t - b.t);

/** Replace one track's keys (kept sorted); an empty list removes the track. */
export function setTrack(def: MotionDef, prop: string, keys: Key[]): MotionDef {
  const tracks = { ...tracksOf(def) };
  if (keys.length) tracks[prop] = sortKeys(keys.map((k) => ({ ...k, t: Math.max(0, Math.round(k.t)) })));
  else delete tracks[prop];
  return { ...def, tracks };
}

/** A new track spanning the motion, resting at its property's rest value. */
export function addTrack(def: MotionDef, prop: string): MotionDef {
  if (!isProperty(prop) || tracksOf(def)[prop]) return def;
  const rest = restValue(prop);
  return setTrack(def, prop, [{ t: 0, v: rest }, { t: Math.max(100, kfEnd(def)), v: rest }]);
}

/** Value of a track at time t (linear between keys; good enough for placing a new key). */
export function valueAt(keys: Key[], t: number): number {
  if (!keys.length) return 0;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1], b = keys[i];
      const f = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return round(a.v + (b.v - a.v) * f);
    }
  }
  return keys[keys.length - 1].v;
}

export function setMarkers(def: MotionDef, markers: Record<string, string>): MotionDef {
  const next = { ...def };
  if (Object.keys(markers).length) next.markers = markers;
  else delete next.markers;
  return next;
}

/** Stretch every key and marker so the motion lasts `ms`. */
export function rescaleTime(def: MotionDef, ms: number): MotionDef {
  const end = kfEnd(def);
  if (end <= 0 || ms <= 0) return def;
  const f = ms / end;
  const tracks: Record<string, Key[]> = {};
  for (const [p, ks] of Object.entries(tracksOf(def))) tracks[p] = ks.map((k) => ({ ...k, t: Math.round(k.t * f) }));
  const markers: Record<string, string> = {};
  for (const [t, m] of Object.entries(markersOf(def))) markers[String(Math.round(Number(t) * f))] = m;
  return setMarkers({ ...def, tracks }, markers);
}

/** Make every key's distance from rest `f` times as large (stronger / weaker). */
export function scaleAmplitude(def: MotionDef, f: number): MotionDef {
  const tracks: Record<string, Key[]> = {};
  for (const [p, ks] of Object.entries(tracksOf(def))) {
    const rest = isProperty(p) ? restValue(p) : 0;
    tracks[p] = ks.map((k) => ({ ...k, v: round(rest + (k.v - rest) * f) }));
  }
  return { ...def, tracks };
}

export function setRepeat(def: MotionDef, repeat: Repeat | null): MotionDef {
  const next = { ...def };
  if (repeat) {
    next.repeat = repeat;
    delete next.markers; // a repeating motion fires none (docs/03 §3.2)
  } else delete next.repeat;
  return next;
}

/** The repeat gap as [min, max] ms, or null when it plays once. */
export function repeatGap(def: MotionDef): [number, number] | null {
  const r = def.repeat;
  if (r === true) return [0, 0];
  if (!r || typeof r !== 'object') return null;
  const g = (r as { gapMs?: unknown }).gapMs;
  if (Array.isArray(g)) return [Number(g[0]) || 0, Number(g[1] ?? g[0]) || 0];
  return [Number(g) || 0, Number(g) || 0];
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ---------- the user's motion library (docs/04 §6) ----------

export interface MotionLibrary {
  format: 1;
  motions: Record<string, { def: MotionDef; savedAt: number }>;
}

export const emptyLibrary = (): MotionLibrary => ({ format: 1, motions: {} });

/** Read whatever the file holds, keeping only well-formed entries. */
export function parseLibrary(raw: unknown): MotionLibrary {
  const lib = emptyLibrary();
  const motions = (raw as { motions?: unknown } | null)?.motions;
  if (!motions || typeof motions !== 'object') return lib;
  for (const [name, e] of Object.entries(motions as Record<string, unknown>)) {
    const def = (e as { def?: unknown } | null)?.def as MotionDef | undefined;
    if (def && typeof def === 'object' && typeof def.type === 'string') lib.motions[name] = { def, savedAt: Number((e as { savedAt?: unknown }).savedAt) || 0 };
  }
  return lib;
}

/** Save (or overwrite) a motion in the library under `name`. */
export function libraryPut(lib: MotionLibrary, name: string, def: MotionDef, now = Date.now()): MotionLibrary {
  return { ...lib, motions: { ...lib.motions, [name]: { def: structuredClone(def), savedAt: now } } };
}

export function libraryRemove(lib: MotionLibrary, name: string): MotionLibrary {
  const motions = { ...lib.motions };
  delete motions[name];
  return { ...lib, motions };
}

/** Same definition (ignoring key order)? Lets the UI say "已在库里" vs "库里的版本不同". */
export function sameDef(a: MotionDef | undefined, b: MotionDef | undefined): boolean {
  return !!a && !!b && canon(a) === canon(b);
}

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
