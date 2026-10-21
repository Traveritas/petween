// Where bubbles go around a pet — pure geometry, ported from v0 (bubbles/bubble-host.ts).
//
// Regions (v0 second batch, user-directed):
//   column  per-session stacks above the pet (status chips, plain speech)
//   left    one stack at the pet's left edge (reply previews)
//   below   one stack under the pet (turn summaries)
// Columns are packed edge to edge with a fixed gap, the whole band centred on the pet and shifted
// inward when it would overflow. A session keeps its column slot while it lives (taskbar order, not
// most-recently-used), so two sessions taking turns don't ping-pong.

import type { BubbleKind } from '../../api/types';

export type Region = 'column' | 'left' | 'below';

export const regionOf = (kind: BubbleKind): Region => (kind === 'reply' ? 'left' : kind === 'summary' ? 'below' : 'column');

/**
 * Sticky column slots: a session keeps its slot while its column lives, regardless of activity order.
 * Newcomers take freed slots first (closest to centre), then fresh alternating slots, so a session
 * returning after its column died usually lands back where it was. Slots only decide ORDER inside
 * the band; x positions come from packColumnBand.
 */
export function assignStickySlots(
  memory: ReadonlyMap<string, number>,
  live: ReadonlyArray<{ key: string; lastActiveAt: number }>,
): { slots: Map<string, number>; memory: Map<string, number> } {
  const slots = new Map<string, number>();
  for (const session of live) {
    const remembered = memory.get(session.key);
    if (remembered !== undefined) slots.set(session.key, remembered);
  }
  const used = new Set(slots.values());
  const freed = [...memory.entries()]
    .filter(([key]) => !slots.has(key))
    .map(([, slot]) => slot)
    .filter((slot) => !used.has(slot))
    .sort((a, b) => Math.abs(a) - Math.abs(b));
  const newcomers = live.filter((s) => !slots.has(s.key)).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  let nextNegative = -1;
  let nextPositive = 1;
  const freshSlot = (): number => {
    // The very first column sits at 0 (the band middle); then alternate.
    if (!used.has(0)) {
      used.add(0);
      return 0;
    }
    while (used.has(nextNegative)) nextNegative -= 1;
    while (used.has(nextPositive)) nextPositive += 1;
    const slot = -nextNegative <= nextPositive ? nextNegative : nextPositive;
    if (slot === nextNegative) nextNegative -= 1;
    else nextPositive += 1;
    return slot;
  };
  for (const newcomer of newcomers) {
    const slot = freed.length > 0 ? (freed.shift() as number) : freshSlot();
    slots.set(newcomer.key, slot);
    used.add(slot);
  }
  return { slots, memory: new Map(slots) };
}

/**
 * Pack all columns edge to edge with a fixed border gap and centre the band on the pet. If the band
 * overflows [minX, maxX] the whole band shifts inward (staying on screen wins over centring).
 * Returns column centre x per key.
 */
export function packColumnBand(
  columns: ReadonlyArray<{ key: string; width: number; slot: number }>,
  petCenterX: number,
  gap: number,
  minX: number,
  maxX: number,
): Map<string, number> {
  const centers = new Map<string, number>();
  if (columns.length === 0) return centers;
  const ordered = [...columns].sort((a, b) => a.slot - b.slot);
  const total = ordered.reduce((sum, c) => sum + c.width, 0) + gap * (ordered.length - 1);
  const last = maxX - total;
  const startX = last < minX ? minX : Math.min(Math.max(petCenterX - total / 2, minX), last);
  let cursor = startX;
  for (const c of ordered) {
    centers.set(c.key, cursor + c.width / 2);
    cursor += c.width + gap;
  }
  return centers;
}

export interface Placed {
  /** Bubble centre x and top y, in the same coordinates as the inputs. */
  cx: number;
  top: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One column's vertical stack above the pet, newest nearest the pet; flips below when there is no
 * room above. `sizes` newest first.
 */
export function stackColumn(sizes: { w: number; h: number }[], cx: number, pet: Box, screen: Box, gap: number, margin: number): Placed[] {
  const total = sizes.reduce((s, x) => s + x.h, 0) + gap * Math.max(0, sizes.length - 1);
  const roomAbove = pet.y - (screen.y + margin);
  const below = total + gap > roomAbove && pet.y + pet.height + gap + total + margin < screen.y + screen.height;
  let nextBottom = below ? pet.y + pet.height + gap + total : Math.max(pet.y - gap, screen.y + margin + total);
  return sizes.map((s) => {
    const top = nextBottom - s.h;
    nextBottom = top - gap;
    return { cx: clampCx(cx, s.w, screen, margin), top: Math.max(top, screen.y + margin) };
  });
}

/** Stack at the pet's left edge, vertically centred on it, newest nearest the top. */
export function stackLeft(sizes: { w: number; h: number }[], pet: Box, screen: Box, gap: number, margin: number): Placed[] {
  const total = sizes.reduce((s, x) => s + x.h, 0) + gap * Math.max(0, sizes.length - 1);
  let top = Math.max(screen.y + margin, pet.y + pet.height / 2 - total / 2);
  return sizes.map((s) => {
    const p = { cx: clampCx(pet.x - gap - s.w / 2, s.w, screen, margin), top };
    top += s.h + gap;
    return p;
  });
}

/** Stack under the pet, centred on it, newest on top. */
export function stackBelow(sizes: { w: number; h: number }[], pet: Box, screen: Box, gap: number, margin: number): Placed[] {
  let top = pet.y + pet.height + gap;
  return sizes.map((s) => {
    const p = { cx: clampCx(pet.x + pet.width / 2, s.w, screen, margin), top: Math.min(top, screen.y + screen.height - margin - s.h) };
    top += s.h + gap;
    return p;
  });
}

function clampCx(cx: number, w: number, screen: Box, margin: number) {
  const half = w / 2;
  return Math.max(screen.x + half + margin, Math.min(cx, screen.x + screen.width - margin - half));
}

/** Per-region caps: a column holds `perColumn`; the side stacks hold two (v0). */
export const SIDE_STACK_CAP = 2;

/**
 * Which shown bubbles get drawn: newest first per region, oldest dropped past the cap.
 * `shown` is oldest first (channel order).
 */
export function pickVisible<T extends { kind: BubbleKind; session?: string }>(shown: T[], perColumn: number): { region: Region; key: string; items: T[] }[] {
  const groups = new Map<string, { region: Region; key: string; items: T[] }>();
  for (const b of [...shown].reverse()) {
    const region = regionOf(b.kind);
    const key = region === 'column' ? `column:${b.session ?? ''}` : region;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { region, key: b.session ?? '', items: [] }));
    if (g.items.length < (region === 'column' ? perColumn : SIDE_STACK_CAP)) g.items.push(b);
  }
  return [...groups.values()];
}
