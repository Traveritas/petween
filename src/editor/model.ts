// The editor's view of a pack: which state keys exist, what each one falls back to, small edits,
// and what is worth warning about before saving. Pure, so it is unit-tested.

import type { ClipDef, MotionRef, PetPack, StateAppearance } from '../api/types';
import { fallbackChain, resolveAppearance } from '../kernel/pack/resolve';
import { BRAIN_STATE_KEYS } from '../shared/state-keys';

export interface KeyInfo {
  key: string;
  label: string;
  hint?: string;
  /** Who uses the key: the default brain, a plugin (its name), or only this pack. */
  source: string;
  depth: number;
}

export interface TreeRow extends KeyInfo {
  /** The pack defines this key itself. */
  own: boolean;
  /** The key it shows instead (when not own). */
  fallsBackTo: string | null;
}

/** Every key worth showing: the brain's, the plugins' and the pack's own, as a tree (parents first). */
export function stateTree(pack: PetPack, plugins: { name: string; stateKeys?: { key: string; label: string }[] }[]): TreeRow[] {
  const known = new Map<string, KeyInfo>();
  const add = (key: string, label: string, source: string, hint?: string) => {
    if (!known.has(key)) known.set(key, { key, label, source, hint, depth: key.split('.').length - 1 });
  };
  for (const k of BRAIN_STATE_KEYS) add(k.key, k.label, '默认大脑', k.hint);
  for (const p of plugins) for (const k of p.stateKeys ?? []) add(k.key, k.label, p.name);
  for (const k of Object.keys(pack.states)) add(k, '', '只在这个宠物包');
  // Parents of deep keys, so the tree has no gaps (active.command.Bash needs active.command).
  for (const k of [...known.keys()]) {
    const parts = k.split('.');
    for (let n = 1; n < parts.length; n++) add(parts.slice(0, n).join('.'), '', '上级');
  }
  const sorted = [...known.values()].sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key));
  return sorted.map((k) => {
    const own = !!pack.states[k.key]?.clips.length;
    return { ...k, own, fallsBackTo: own ? null : resolveAppearance(pack, k.key).key };
  });
}

/** Brain keys keep their documented order; others sort by name, children right after parents. */
function order(key: string) {
  const root = key.split('.')[0];
  const i = BRAIN_STATE_KEYS.findIndex((k) => k.key === root);
  return i < 0 ? 1000 : i;
}

/** "未配置，用 active 的" style explanation of what a key shows. */
export function fallbackText(pack: PetPack, key: string): string {
  if (pack.states[key]?.clips.length) return '';
  const chain = fallbackChain(key).slice(1);
  const hit = chain.find((k) => pack.states[k]?.clips.length);
  if (hit) return `没有单独设置，显示「${hit}」的样子`;
  const first = Object.keys(pack.clips)[0];
  return first ? `没有单独设置，也没有 idle：显示第一个片段「${first}」` : '还没有任何片段';
}

// ---------- edits (return new packs; never mutate) ----------

export function setState(pack: PetPack, key: string, a: StateAppearance | null): PetPack {
  const states = { ...pack.states };
  if (a) states[key] = a;
  else delete states[key];
  return { ...pack, states };
}

export function setClip(pack: PetPack, id: string, clip: ClipDef | null): PetPack {
  const clips = { ...pack.clips };
  if (clip) clips[id] = clip;
  else {
    delete clips[id];
    // A removed clip leaves no dangling references behind.
    const states: Record<string, StateAppearance> = {};
    for (const [k, a] of Object.entries(pack.states)) states[k] = { ...a, clips: a.clips.filter((c) => c !== id) };
    return { ...pack, clips, states };
  }
  return { ...pack, clips };
}

/** Make sure a preset motion exists in the pack (copied in when first used). */
export function ensureMotion(pack: PetPack, name: string): PetPack {
  if (pack.motions?.[name] || !MOTION_PRESETS[name]) return pack;
  return { ...pack, motions: { ...pack.motions, [name]: MOTION_PRESETS[name].def } };
}

/** Clip ids in use by some state. */
export function usedClips(pack: PetPack): Set<string> {
  return new Set(Object.values(pack.states).flatMap((a) => a.clips));
}

// ---------- motion presets (M3a: pick, don't edit; editing comes in M3b) ----------

export const MOTION_PRESETS: Record<string, { label: string; kind: 'enter' | 'loop'; def: { type: string; [k: string]: unknown } }> = {
  breathe: { label: '呼吸', kind: 'loop', def: { type: 'sine', property: 'scaleY', amplitude: 0.015, periodMs: 3200 } },
  sway: { label: '摇摆', kind: 'loop', def: { type: 'sine', property: 'rotate', amplitude: 1.2, periodMs: 4400 } },
  busy: { label: '上下忙碌', kind: 'loop', def: { type: 'sine', property: 'y', amplitude: 2, periodMs: 700 } },
  ponder: { label: '琢磨（随机晃）', kind: 'loop', def: { type: 'noise', property: 'rotate', amplitude: 2.5, frequency: 0.6 } },
  pop: {
    label: '弹一下',
    kind: 'enter',
    def: {
      type: 'keyframes',
      tracks: {
        scaleY: [{ t: 0, v: 1 }, { t: 90, v: 0.94, ease: 'out' }, { t: 220, v: 1.03, ease: 'inOut' }, { t: 340, v: 1, ease: 'inOut' }],
        scaleX: [{ t: 0, v: 1 }, { t: 90, v: 1.04, ease: 'out' }, { t: 220, v: 0.985, ease: 'inOut' }, { t: 340, v: 1, ease: 'inOut' }],
      },
    },
  },
  hop: {
    label: '蹦一下',
    kind: 'enter',
    def: {
      type: 'keyframes',
      tracks: {
        y: [{ t: 0, v: 0 }, { t: 160, v: -11, ease: 'out' }, { t: 320, v: 0, ease: 'in' }, { t: 400, v: -2.5, ease: 'out' }, { t: 480, v: 0, ease: 'in' }],
        scaleY: [{ t: 0, v: 1 }, { t: 60, v: 0.95 }, { t: 160, v: 1.025 }, { t: 320, v: 0.965 }, { t: 480, v: 1 }],
      },
    },
  },
  shake: {
    label: '抖一下',
    kind: 'enter',
    def: { type: 'keyframes', tracks: { x: [{ t: 0, v: 0 }, { t: 50, v: -3 }, { t: 100, v: 3 }, { t: 150, v: -2.5 }, { t: 200, v: 2 }, { t: 260, v: 0 }] } },
  },
};

/** One-shot motion types play on enter / exit; the rest run on as loops. */
const ONE_SHOT = new Set(['keyframes', 'spring']);
export const motionKind = (def: { type: string }): 'enter' | 'loop' => (ONE_SHOT.has(def.type) ? 'enter' : 'loop');

/** Motions a state can pick: the pack's own of the right kind, plus presets it doesn't have yet. */
export function motionChoices(pack: PetPack, kind: 'enter' | 'loop'): { value: string; label: string }[] {
  const own = Object.entries(pack.motions ?? {})
    .filter(([, def]) => motionKind(def) === kind)
    .map(([name]) => ({ value: name, label: MOTION_PRESETS[name]?.label ?? name }));
  const presets = Object.entries(MOTION_PRESETS)
    .filter(([name, p]) => p.kind === kind && !pack.motions?.[name])
    .map(([name, p]) => ({ value: name, label: `${p.label}（预设）` }));
  return [...own, ...presets];
}

export const refName = (r: MotionRef | undefined) => (typeof r === 'string' ? r : r ? r.type : '');

// ---------- checks ----------

export interface Issue {
  level: 'error' | 'warn';
  text: string;
}

export function checkPack(pack: PetPack): Issue[] {
  const out: Issue[] = [];
  if (!pack.name?.trim()) out.push({ level: 'error', text: '宠物包还没有名字' });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pack.id)) out.push({ level: 'error', text: `id「${pack.id}」只能用小写字母、数字和短横线` });
  if (!Object.keys(pack.clips).length) out.push({ level: 'error', text: '还没有任何片段：先导入图片' });
  else if (!pack.states.idle?.clips.length) out.push({ level: 'warn', text: '「空闲 idle」没有设置：所有没配的状态都会回退到它，没有的话只能显示第一个片段' });
  for (const [k, a] of Object.entries(pack.states)) {
    const missing = a.clips.filter((c) => !pack.clips[c]);
    if (missing.length) out.push({ level: 'warn', text: `状态 ${k} 用到了不存在的片段 ${missing.join('、')}` });
    for (const r of [a.enter, a.exit, ...(a.loop ?? [])]) {
      if (typeof r === 'string' && !pack.motions?.[r]) out.push({ level: 'warn', text: `状态 ${k} 用到了不存在的动作 ${r}` });
    }
  }
  const unused = Object.keys(pack.clips).filter((c) => !usedClips(pack).has(c));
  if (unused.length) out.push({ level: 'warn', text: `${unused.length} 个片段还没有被任何状态使用` });
  return out;
}

/** A pack id from a display name: ascii slug, else `pet-<random>`. */
export function packIdFrom(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || `pet-${Math.random().toString(36).slice(2, 7)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

export function emptyPack(id: string, name: string): PetPack {
  return { format: 1, id, name, attribution: { creators: [] }, scale: 1, clips: {}, motions: {}, states: {} };
}
