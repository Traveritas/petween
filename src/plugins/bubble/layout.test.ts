import { describe, expect, it } from 'vitest';
import { assignStickySlots, packColumnBand, pickVisible, stackBelow, stackColumn, stackLeft } from './layout';

// Ported from v0 tests/companions/bubble-slots.test.ts.
describe('assignStickySlots', () => {
  it('first appearance: most recent gets the center, others alternate outward', () => {
    const { slots, memory } = assignStickySlots(new Map(), [
      { key: 'old', lastActiveAt: 1 },
      { key: 'mid', lastActiveAt: 3 },
      { key: 'new', lastActiveAt: 9 },
    ]);
    expect(slots.get('new')).toBe(0);
    expect(slots.get('mid')).toBe(-1);
    expect(slots.get('old')).toBe(1);
    expect(memory).toEqual(slots);
  });

  it('slots are sticky: recency flips do not reorder columns', () => {
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 10 },
      { key: 'b', lastActiveAt: 5 },
    ]);
    const flipped = assignStickySlots(first.memory, [
      { key: 'a', lastActiveAt: 1 },
      { key: 'b', lastActiveAt: 99 },
    ]);
    expect(flipped.slots.get('a')).toBe(first.slots.get('a'));
    expect(flipped.slots.get('b')).toBe(first.slots.get('b'));
  });

  it('newcomers reuse freed slots, closest to center first', () => {
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 30 },
      { key: 'b', lastActiveAt: 20 },
      { key: 'c', lastActiveAt: 10 },
    ]);
    expect(first.slots.get('b')).toBe(-1);
    const after = assignStickySlots(first.memory, [
      { key: 'a', lastActiveAt: 31 },
      { key: 'c', lastActiveAt: 11 },
      { key: 'd', lastActiveAt: 99 },
    ]);
    expect(after.slots.get('a')).toBe(0);
    expect(after.slots.get('c')).toBe(1);
    expect(after.slots.get('d')).toBe(-1);
  });

  it('a returning session lands back in its old slot when free', () => {
    const first = assignStickySlots(new Map(), [
      { key: 'a', lastActiveAt: 30 },
      { key: 'b', lastActiveAt: 20 },
    ]);
    const withoutB = assignStickySlots(first.memory, [{ key: 'a', lastActiveAt: 31 }]);
    const back = assignStickySlots(withoutB.memory, [
      { key: 'a', lastActiveAt: 31 },
      { key: 'b', lastActiveAt: 99 },
    ]);
    expect(back.slots.get('b')).toBe(first.slots.get('b'));
  });

  it('memory drops departed sessions', () => {
    const first = assignStickySlots(new Map(), [{ key: 'a', lastActiveAt: 1 }, { key: 'b', lastActiveAt: 2 }]);
    const after = assignStickySlots(first.memory, [{ key: 'a', lastActiveAt: 3 }]);
    expect(after.memory.has('b')).toBe(false);
  });
});

describe('packColumnBand (edge-packed, pet-centered, clamp-first)', () => {
  const cols = [
    { key: 'a', width: 100, slot: -1 },
    { key: 'focus', width: 100, slot: 0 },
    { key: 'b', width: 100, slot: 1 },
  ];

  it('centers the whole band on the pet with exact border gaps', () => {
    const centers = packColumnBand(cols, 1000, 24, 6, 2042);
    expect(centers.get('a')).toBe(876);
    expect(centers.get('focus')).toBe(1000);
    expect(centers.get('b')).toBe(1124);
  });

  it('shifts the band inward when it would overflow the screen', () => {
    const centers = packColumnBand(cols, 1900, 24, 6, 2042);
    const startX = 2042 - 348;
    expect(centers.get('a')).toBe(startX + 50);
    expect(centers.get('b')).toBe(startX + 298);
  });

  it('anchors left when the band is wider than the screen', () => {
    const wide = [
      { key: 'w1', width: 1100, slot: -1 },
      { key: 'w2', width: 1100, slot: 0 },
    ];
    const centers = packColumnBand(wide, 1000, 24, 6, 2042);
    expect(centers.get('w1')).toBe(556);
  });

  it('works on a screen that does not start at 0 (second monitor)', () => {
    const centers = packColumnBand([{ key: 'x', width: 100, slot: 0 }], 2700, 24, 2566, 4474);
    expect(centers.get('x')).toBe(2700);
    expect(packColumnBand([{ key: 'x', width: 100, slot: 0 }], 2560, 24, 2566, 4474).get('x')).toBe(2616);
  });

  it('empty input yields no centers', () => {
    expect(packColumnBand([], 500, 24, 0, 1000).size).toBe(0);
  });
});

describe('stacks', () => {
  const pet = { x: 900, y: 700, width: 120, height: 120 };
  const screen = { x: 0, y: 0, width: 2048, height: 1280 };

  it('column stacks upward from the pet, newest nearest', () => {
    const p = stackColumn([{ w: 80, h: 30 }, { w: 80, h: 30 }], 960, pet, screen, 6, 6);
    expect(p[0].top).toBe(700 - 6 - 30);
    expect(p[1].top).toBe(700 - 6 - 30 - 6 - 30);
  });

  it('column flips below the pet when there is no room above', () => {
    const p = stackColumn([{ w: 80, h: 30 }], 960, { ...pet, y: 10 }, screen, 6, 6);
    expect(p[0].top).toBeGreaterThan(10 + 120);
  });

  it('left stack hugs the pet left edge; below stack sits under it', () => {
    expect(stackLeft([{ w: 200, h: 60 }], pet, screen, 6, 6)[0].cx).toBe(900 - 6 - 100);
    expect(stackBelow([{ w: 200, h: 40 }], pet, screen, 6, 6)[0].top).toBe(700 + 120 + 6);
  });
});

describe('pickVisible', () => {
  const b = (id: number, kind: string, session?: string) => ({ id, kind, session });

  it('splits by region and session, newest first, capped', () => {
    const groups = pickVisible([b(1, 'status', 's1'), b(2, 'status', 's1'), b(3, 'status', 's1'), b(4, 'status', 's2'), b(5, 'reply', 's1'), b(6, 'reply', 's2'), b(7, 'reply', 's3'), b(8, 'summary')], 2);
    const by = Object.fromEntries(groups.map((g) => [`${g.region}:${g.key}`, g.items.map((x) => x.id)]));
    expect(by['column:s1']).toEqual([3, 2]);
    expect(by['column:s2']).toEqual([4]);
    expect(by['left:s3']).toEqual([7, 6]);
    expect(by['below:']).toEqual([8]);
  });
});
