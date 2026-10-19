import { describe, expect, it } from 'vitest';
import type { PetPack } from '../../api/types';
import { ClipPlayback } from './playback';
import { fallbackChain, resolveAppearance, validatePack, VariantPicker } from './resolve';

const pack = (states: PetPack['states']): PetPack => ({
  format: 1,
  id: 't',
  name: 't',
  clips: { sit: { type: 'still', source: 'a.png' }, type: { type: 'still', source: 'b.png' }, term: { type: 'still', source: 'c.png' } },
  states,
});

describe('fallback (docs/04 §4)', () => {
  it('walks up to idle', () => {
    expect(fallbackChain('active.command.Bash')).toEqual(['active.command.Bash', 'active.command', 'active', 'idle']);
    expect(fallbackChain('roamer.doze')).toEqual(['roamer.doze', 'roamer', 'idle']);
    expect(fallbackChain('idle')).toEqual(['idle']);
  });

  it('uses the most specific defined key as a whole', () => {
    const p = pack({ idle: { clips: ['sit'] }, active: { clips: ['type'], enter: 'pop' }, 'active.command.Bash': { clips: ['term'] } });
    expect(resolveAppearance(p, 'active.command.Bash').key).toBe('active.command.Bash');
    expect(resolveAppearance(p, 'active.command.Bash').appearance.enter).toBeUndefined();
    expect(resolveAppearance(p, 'active.edit').key).toBe('active');
    expect(resolveAppearance(p, 'roamer.doze').key).toBe('idle');
  });

  it('a pack with only idle shows idle for everything; no idle shows the first clip', () => {
    expect(resolveAppearance(pack({ idle: { clips: ['sit'] } }), 'error').appearance.clips).toEqual(['sit']);
    expect(resolveAppearance(pack({}), 'error').appearance.clips).toEqual(['sit']);
  });
});

describe('validatePack', () => {
  it('rejects newer formats and drops broken clip references', () => {
    expect(() => validatePack({ format: 2, id: 'x', clips: {}, states: {} })).toThrow(/升级/);
    const { pack: p, warnings } = validatePack({ format: 1, id: 'x', clips: { a: { type: 'still', source: 'a' } }, states: { idle: { clips: ['a', 'missing'] } } });
    expect(p.states.idle.clips).toEqual(['a']);
    expect(warnings).toHaveLength(1);
  });
});

describe('VariantPicker', () => {
  it('weighted random', () => {
    const picker = new VariantPicker(() => 0.9);
    expect(picker.pick('k', { clips: ['a', 'b'], weights: [1, 1] }, 0, 0)).toBe('b');
  });

  it('cycle rotates over time', () => {
    const picker = new VariantPicker();
    const a = { clips: ['a', 'b', 'c'], variant: 'cycle' as const, cycleMs: 1000 };
    expect(picker.pick('k', a, 0, 500)).toBe('a');
    expect(picker.pick('k', a, 0, 1500)).toBe('b');
    expect(picker.pick('k', a, 0, 3500)).toBe('a');
  });

  it('sticky holds until reset', () => {
    let r = 0;
    const picker = new VariantPicker(() => r);
    const a = { clips: ['a', 'b'], variant: 'sticky' as const };
    expect(picker.pick('k', a, 0, 0)).toBe('a');
    r = 0.99;
    expect(picker.pick('k', a, 0, 0)).toBe('a');
    picker.resetSticky();
    expect(picker.pick('k', a, 0, 0)).toBe('b');
  });
});

describe('ClipPlayback', () => {
  const clip = { type: 'frames', source: 'x', fps: 10, frames: { count: 30 }, segments: { enter: [0, 9] as [number, number], loop: [10, 19] as [number, number], exit: [20, 29] as [number, number] }, markers: { 9: 'peak', 12: 'tap' } };

  it('plays enter then loops, reporting markers and wraps', () => {
    const pb = new ClipPlayback('c', clip, 0, 30);
    expect(pb.tick(0).frame).toBe(0);
    expect(pb.tick(950).markers).toEqual(['peak']);
    expect(pb.segment).toBe('enter');
    const t = pb.tick(1050);
    expect(pb.segment).toBe('loop');
    expect(t.frame).toBe(10);
    expect(pb.tick(1250).markers).toEqual(['tap']);
    const w = pb.tick(2050);
    expect(w.frame).toBe(10);
    expect(w.wrapped).toBe(true);
  });

  it('exit holds the last frame and reports ended', () => {
    const pb = new ClipPlayback('c', clip, 0, 30);
    pb.tick(1500);
    expect(pb.startExit(2000)).toBe(true);
    expect(pb.tick(2100).ended).toBe(false);
    const end = pb.tick(3000);
    expect(end.ended).toBe(true);
    expect(end.frame).toBe(29);
    expect(pb.tick(9000).frame).toBe(29);
  });

  it('stills have one frame and no exit', () => {
    const pb = new ClipPlayback('s', { type: 'still', source: 'x' }, 0, 1);
    expect(pb.animated).toBe(false);
    expect(pb.startExit(0)).toBe(false);
    expect(pb.tick(1234).frame).toBe(0);
  });
});
