import { describe, expect, it } from 'vitest';
import type { PetPack } from '../api/types';
import { checkPack, emptyPack, ensureMotion, fallbackText, motionChoices, packIdFrom, setClip, setState, stateTree, usedClips } from './model';

const still = (source: string) => ({ type: 'still' as const, source });

function pack(): PetPack {
  return {
    ...emptyPack('cat', '小猫'),
    clips: { sit: still('clips/sit.webp'), type: still('clips/type.webp'), bash: still('clips/bash.webp') },
    states: {
      idle: { clips: ['sit'] },
      active: { clips: ['type'] },
      'active.command.Bash': { clips: ['bash'] },
      'mine.dance': { clips: ['sit'] },
    },
  };
}

describe('stateTree', () => {
  const rows = stateTree(pack(), [{ name: '物理', stateKeys: [{ key: 'physics.hit', label: '撞墙' }] }]);
  const row = (k: string) => rows.find((r) => r.key === k)!;

  it('lists brain, plugin and pack keys, with gap-filling parents', () => {
    expect(row('idle').source).toBe('默认大脑');
    expect(row('physics.hit')).toMatchObject({ label: '撞墙', source: '物理', own: false, fallsBackTo: 'idle' });
    expect(row('mine.dance')).toMatchObject({ own: true, source: '只在这个宠物包' });
    expect(row('mine').source).toBe('上级');
    expect(row('active.command.Bash').depth).toBe(2);
  });

  it('brain keys come first, in their documented order; children follow parents', () => {
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf('idle')).toBe(0);
    expect(keys.indexOf('active')).toBeLessThan(keys.indexOf('active.command'));
    expect(keys.indexOf('active.command')).toBeLessThan(keys.indexOf('active.command.Bash'));
    expect(keys.indexOf('error')).toBeLessThan(keys.indexOf('mine'));
  });

  it('says where an unset key falls back to', () => {
    expect(row('active.thinking')).toMatchObject({ own: false, fallsBackTo: 'active' });
    expect(row('waiting').fallsBackTo).toBe('idle');
    expect(fallbackText(pack(), 'active.thinking')).toContain('「active」');
    expect(fallbackText(pack(), 'active')).toBe('');
  });
});

describe('edits', () => {
  it('setState / setClip never mutate, and removing a clip cleans references', () => {
    const p = pack();
    const q = setState(p, 'success', { clips: ['sit'] });
    expect(p.states.success).toBeUndefined();
    expect(q.states.success.clips).toEqual(['sit']);
    const r = setClip(q, 'sit', null);
    expect(r.clips.sit).toBeUndefined();
    expect(r.states.idle.clips).toEqual([]);
    expect(q.clips.sit).toBeDefined();
    expect(setState(q, 'success', null).states.success).toBeUndefined();
  });

  it('ensureMotion copies a preset in once', () => {
    const p = ensureMotion(pack(), 'hop');
    expect(p.motions?.hop?.type).toBe('keyframes');
    expect(ensureMotion(p, 'hop')).toBe(p);
    expect(ensureMotion(p, 'nope')).toBe(p);
  });

  it('motionChoices: own motions plus presets of the right kind not yet in the pack', () => {
    const p = ensureMotion(pack(), 'pop');
    const enter = motionChoices(p, 'enter').map((c) => c.value);
    expect(enter).toContain('pop');
    expect(enter).toContain('hop');
    expect(enter).not.toContain('breathe');
    const loop = motionChoices(p, 'loop').map((c) => c.value);
    expect(loop).toContain('breathe');
    expect(loop).not.toContain('pop'); // the pack's own one-shot motion
    expect(motionChoices(ensureMotion(p, 'sway'), 'enter').map((c) => c.value)).not.toContain('sway');
  });

  it('usedClips', () => {
    expect([...usedClips(pack())].sort()).toEqual(['bash', 'sit', 'type']);
  });
});

describe('checkPack', () => {
  it('flags real problems', () => {
    expect(checkPack(pack())).toEqual([]);
    const bad = { ...emptyPack('Bad Id', ''), states: {} };
    const texts = checkPack(bad).map((i) => i.text).join('\n');
    expect(texts).toContain('名字');
    expect(texts).toContain('id');
    expect(texts).toContain('片段');
    const noIdle = setState(pack(), 'idle', null);
    expect(checkPack(noIdle)[0]).toMatchObject({ level: 'warn' });
    const loose = setState(pack(), 'success', { clips: ['sit'], enter: 'ghost' });
    expect(checkPack(loose).map((i) => i.text).join()).toContain('ghost');
  });
});

describe('packIdFrom', () => {
  it('slugs names and avoids clashes', () => {
    expect(packIdFrom('My Cat', new Set())).toBe('my-cat');
    expect(packIdFrom('My Cat', new Set(['my-cat']))).toBe('my-cat-2');
    expect(packIdFrom('小猫', new Set())).toMatch(/^pet-[a-z0-9]+$/);
  });
});
