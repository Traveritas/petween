import { describe, expect, it } from 'vitest';
import type { PetPack } from '../api/types';
import { emptyPack } from './model';
import {
  addMotion,
  addTrack,
  deleteMotion,
  kfEnd,
  libraryPut,
  libraryRemove,
  motionUsers,
  parseLibrary,
  renameMotion,
  repeatGap,
  rescaleTime,
  sameDef,
  scaleAmplitude,
  setRepeat,
  setTrack,
  uniqueName,
  valueAt,
  type MotionDef,
} from './motions';

const hop: MotionDef = { type: 'keyframes', tracks: { y: [{ t: 0, v: 0 }, { t: 200, v: -10, ease: 'out' }, { t: 400, v: 0 }] }, markers: { '200': 'swap' } };

function pack(): PetPack {
  return {
    ...emptyPack('p', 'P'),
    clips: { a: { type: 'still', source: 'a.webp' } },
    motions: { hop, breathe: { type: 'sine', property: 'scaleY', amplitude: 0.02, periodMs: 3000 } },
    states: {
      idle: { clips: ['a'], loop: ['breathe'] },
      success: { clips: ['a'], enter: 'hop', loop: ['breathe', { type: 'sine' }] },
      error: { clips: ['a'], exit: 'hop' },
    },
  };
}

describe('named motions', () => {
  it('finds users', () => {
    expect(motionUsers(pack(), 'hop')).toEqual([
      { key: 'success', field: 'enter' },
      { key: 'error', field: 'exit' },
    ]);
    expect(motionUsers(pack(), 'breathe').map((u) => u.key)).toEqual(['idle', 'success']);
  });

  it('uniqueName', () => {
    expect(uniqueName(['hop'], 'jump')).toBe('jump');
    expect(uniqueName(['hop', 'hop 2'], 'hop')).toBe('hop 3');
    expect(uniqueName([], '  ')).toBe('动作');
  });

  it('rename keeps order and references', () => {
    const p = renameMotion(pack(), 'hop', '大跳');
    expect(Object.keys(p.motions!)).toEqual(['大跳', 'breathe']);
    expect(p.states.success.enter).toBe('大跳');
    expect(p.states.error.exit).toBe('大跳');
    // Clashing or empty names are refused.
    expect(renameMotion(pack(), 'hop', 'breathe')).toEqual(pack());
    expect(renameMotion(pack(), 'hop', ' ')).toEqual(pack());
  });

  it('delete drops references, keeps inline loops', () => {
    const p = deleteMotion(pack(), 'breathe');
    expect(p.motions!.breathe).toBeUndefined();
    expect(p.states.idle.loop).toEqual([]);
    expect(p.states.success.loop).toEqual([{ type: 'sine' }]);
    const q = deleteMotion(pack(), 'hop');
    expect('enter' in q.states.success).toBe(false);
    expect('exit' in q.states.error).toBe(false);
  });

  it('add copies under a free name', () => {
    const r = addMotion(pack(), 'hop', hop);
    expect(r.name).toBe('hop 2');
    expect(r.pack.motions![r.name]).toEqual(hop);
    expect(r.pack.motions![r.name]).not.toBe(hop);
  });
});

describe('keyframes', () => {
  it('end covers keys and markers', () => {
    expect(kfEnd(hop)).toBe(400);
    expect(kfEnd({ type: 'keyframes', tracks: { y: [{ t: 0, v: 0 }] }, markers: { '650': 'x' } })).toBe(650);
  });

  it('setTrack sorts, rounds and removes', () => {
    const d = setTrack(hop, 'y', [{ t: 300.4, v: 1 }, { t: 0, v: 0 }]);
    expect((d.tracks as Record<string, unknown>).y).toEqual([{ t: 0, v: 0 }, { t: 300, v: 1 }]);
    expect(setTrack(hop, 'y', []).tracks).toEqual({});
  });

  it('addTrack rests at the property rest value', () => {
    const d = addTrack(hop, 'scaleX');
    expect((d.tracks as Record<string, unknown>).scaleX).toEqual([{ t: 0, v: 1 }, { t: 400, v: 1 }]);
    expect(addTrack(hop, 'y')).toBe(hop);
    expect(addTrack(hop, 'nope')).toBe(hop);
  });

  it('valueAt interpolates', () => {
    const ks = [{ t: 0, v: 0 }, { t: 100, v: -10 }];
    expect(valueAt(ks, 50)).toBe(-5);
    expect(valueAt(ks, -5)).toBe(0);
    expect(valueAt(ks, 500)).toBe(-10);
  });

  it('rescaleTime stretches keys and markers', () => {
    const d = rescaleTime(hop, 800);
    expect((d.tracks as Record<string, { t: number }[]>).y.map((k) => k.t)).toEqual([0, 400, 800]);
    expect(d.markers).toEqual({ '400': 'swap' });
  });

  it('scaleAmplitude scales around rest', () => {
    const d = scaleAmplitude({ type: 'keyframes', tracks: { y: [{ t: 0, v: -10 }], scaleY: [{ t: 0, v: 0.9 }] } }, 0.5);
    expect(d.tracks).toEqual({ y: [{ t: 0, v: -5 }], scaleY: [{ t: 0, v: 0.95 }] });
  });

  it('repeat on drops markers; gap reads every form', () => {
    const d = setRepeat(hop, { gapMs: [500, 900] });
    expect(d.markers).toBeUndefined();
    expect(repeatGap(d)).toEqual([500, 900]);
    expect(repeatGap(setRepeat(hop, true))).toEqual([0, 0]);
    expect(repeatGap({ type: 'keyframes', repeat: { gapMs: 300 } })).toEqual([300, 300]);
    expect(repeatGap(setRepeat(d, null))).toBeNull();
  });
});

describe('library', () => {
  it('parses leniently', () => {
    const lib = parseLibrary({ motions: { ok: { def: hop, savedAt: 5 }, bad: { def: { nope: 1 } }, worse: 3 } });
    expect(Object.keys(lib.motions)).toEqual(['ok']);
    expect(parseLibrary(null).motions).toEqual({});
  });

  it('put / remove', () => {
    const lib = libraryPut(parseLibrary({}), '大跳', hop, 42);
    expect(lib.motions['大跳']).toEqual({ def: hop, savedAt: 42 });
    expect(libraryRemove(lib, '大跳').motions).toEqual({});
  });

  it('sameDef ignores key order', () => {
    expect(sameDef({ type: 'sine', a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1, type: 'sine' })).toBe(true);
    expect(sameDef(hop, scaleAmplitude(hop, 2))).toBe(false);
  });
});
