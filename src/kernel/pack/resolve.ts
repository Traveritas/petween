// State key → appearance with fallback (docs/04 §4), and variant choice (docs/04 §3).

import type { PetPack, StateAppearance } from '../../api/types';

export const SUPPORTED_FORMAT = 1;

/** active.command.Bash → active.command → active → idle */
export function fallbackChain(key: string): string[] {
  const parts = key.split('.').filter(Boolean);
  const chain: string[] = [];
  for (let n = parts.length; n > 0; n--) chain.push(parts.slice(0, n).join('.'));
  if (chain[chain.length - 1] !== 'idle') chain.push('idle');
  return chain;
}

/** Whole-appearance fallback: the first key in the chain that the pack defines wins; fields never mix. */
export function resolveAppearance(pack: PetPack, key: string): { key: string; appearance: StateAppearance } {
  for (const k of fallbackChain(key)) {
    const a = pack.states[k];
    if (a && a.clips.length) return { key: k, appearance: a };
  }
  // A pack without a usable idle: show its first clip.
  const first = Object.keys(pack.clips)[0];
  return { key: 'idle', appearance: { clips: first ? [first] : [] } };
}

export class VariantPicker {
  private sticky = new Map<string, string>();

  constructor(private random: () => number = Math.random) {}

  /** `enteredAt` = when this state became current; used by `cycle`. */
  pick(key: string, a: StateAppearance, enteredAt: number, now: number): string | undefined {
    const clips = a.clips;
    if (clips.length <= 1) return clips[0];
    switch (a.variant) {
      case 'cycle': {
        const ms = Math.max(100, a.cycleMs ?? 8000);
        return clips[Math.floor((now - enteredAt) / ms) % clips.length];
      }
      case 'sticky': {
        const hit = this.sticky.get(key);
        if (hit && clips.includes(hit)) return hit;
        const c = this.weighted(a);
        this.sticky.set(key, c);
        return c;
      }
      default:
        return this.weighted(a);
    }
  }

  /** New agent turn: sticky choices may change (docs/04 §3). */
  resetSticky() {
    this.sticky.clear();
  }

  private weighted(a: StateAppearance): string {
    const w = a.clips.map((_, i) => Math.max(0, a.weights?.[i] ?? 1));
    const total = w.reduce((s, x) => s + x, 0);
    if (total <= 0) return a.clips[0];
    let r = this.random() * total;
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r < 0) return a.clips[i];
    }
    return a.clips[a.clips.length - 1];
  }
}

/** Validate a parsed pet.json. Unknown fields are kept; broken references are dropped with warnings. */
export function validatePack(raw: unknown): { pack: PetPack; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') throw new Error('pet.json 不是对象');
  const p = raw as PetPack;
  if (typeof p.format !== 'number') throw new Error('pet.json 缺少 format');
  if (p.format > SUPPORTED_FORMAT) throw new Error(`宠物包格式 ${p.format} 需要升级 Petween`);
  if (typeof p.id !== 'string' || !p.id) throw new Error('pet.json 缺少 id');
  const clips = p.clips && typeof p.clips === 'object' ? p.clips : {};
  const states: Record<string, StateAppearance> = {};
  for (const [k, a] of Object.entries(p.states ?? {})) {
    if (!a || !Array.isArray(a.clips)) {
      warnings.push(`状态 ${k} 没有 clips，已忽略`);
      continue;
    }
    const ok = a.clips.filter((c) => {
      if (clips[c]) return true;
      warnings.push(`状态 ${k} 引用了不存在的片段 ${c}`);
      return false;
    });
    states[k] = { ...a, clips: ok };
  }
  return { pack: { ...p, name: p.name || p.id, clips, states, motions: p.motions ?? {} }, warnings };
}
