// `bubble` (docs/06 §6): draws whatever the kernel's bubble channel has on screen. The kernel decides
// WHO speaks and WHEN (parallel lanes, each a queue); this plugin decides WHERE and HOW it looks, so a
// third-party plugin can replace it wholesale.
//
// Layout and looks are v0's (petween-desktop bubbles/*): per-session columns above the pet, replies at
// its left, summaries below; seven skins and separate enter / exit animations, chosen per bubble kind.

import { definePlugin, type BubbleKind, type Disposable, type PetHandle, type PluginContext, type PluginManifest, type Rect, type SettingSpec, type ShownBubble, type StageLayer } from '../../api/types';
import { assignStickySlots, packColumnBand, pickVisible, regionOf, stackBelow, stackColumn, stackLeft, type Box, type Placed, type Region } from './layout';
import { ALL_CSS, DEFAULT_EXIT_MS, ENTERS, enter as enterOf, exit as exitOf, EXITS, kindClass, render, skin as skinOf, SKINS } from './skins';

const KINDS: { kind: BubbleKind; label: string; enter: string; exit: string }[] = [
  // Defaults = the author's v0 picks (soft everywhere; 飘落/随风 for live chips, 升起/沉落 for the rest).
  { kind: 'status', label: '状态（思考、写入）', enter: 'drift-in', exit: 'drift' },
  { kind: 'reply', label: '回复', enter: 'rise', exit: 'sink' },
  { kind: 'summary', label: '完成', enter: 'rise', exit: 'sink' },
  { kind: 'speech', label: '说话（其他插件）', enter: 'rise', exit: 'fade' },
];

const options = (list: { id: string; label: string }[]) => list.map((x) => ({ value: x.id, label: x.label }));

export const manifest: PluginManifest = {
  id: 'bubble',
  name: '气泡',
  version: '0.2.0',
  apiVersion: 1,
  contributes: {
    channels: [],
    settings: [
      ...KINDS.flatMap(({ kind, label, enter, exit }): SettingSpec[] => [
        { key: `${kind}.skin`, section: `${label}气泡`, label: '外观', type: 'select', default: 'soft', options: options(SKINS) },
        { key: `${kind}.enter`, section: `${label}气泡`, label: '出现', type: 'select', default: enter, options: options(ENTERS) },
        { key: `${kind}.exit`, section: `${label}气泡`, label: '消失', type: 'select', default: exit, options: options(EXITS) },
      ]),
      { key: 'perColumn', section: '排布', label: '每列最多', type: 'number', default: 3, min: 1, max: 6, step: 1, unit: '个', description: '一个会话一列；超出时最早的先收起' },
      { key: 'columnGap', section: '排布', label: '列间距', type: 'number', default: 24, min: 0, max: 80, step: 2, unit: 'px' },
    ],
  },
};

const GAP = 6;
const MARGIN = 6;
const BUMP_MS = 240;
/** No pulse while the enter animation still runs: the bump would restart it (v0.4.0 review). */
const ENTER_GUARD_MS = 1200;

interface Entry {
  id: number;
  el: HTMLElement;
  region: Region;
  session: string;
  pulse: number;
  spawnedAt: number;
  lastTouchedAt: number;
  placed: boolean;
  closing: boolean;
}

function screenOf(screens: Rect[], b: Rect): Rect {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height) ?? screens[0] ?? { x: 0, y: 0, width: innerWidth, height: innerHeight };
}

/** All bubbles of one pet. */
function petBubbles(ctx: PluginContext, layer: StageLayer, pet: PetHandle): Disposable {
  const entries = new Map<number, Entry>();
  let slotMemory = new Map<string, number>();
  let frame: Disposable | null = null;
  const timers = new Set<Disposable>();
  const setting = <T,>(key: string, fallback: T) => ctx.settings.get<T>(key, fallback);
  const kindDefaults = (kind: BubbleKind) => KINDS.find((k) => k.kind === kind) ?? KINDS[3];

  const later = (fn: () => void, ms: number) => {
    const t = ctx.setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const spawn = (b: ShownBubble): Entry => {
    const kind = ['status', 'reply', 'summary'].includes(b.kind) ? b.kind : 'speech';
    const d = kindDefaults(kind);
    const el = document.createElement('div');
    const region = regionOf(b.kind);
    const enterClass = enterOf(setting(`${kind}.enter`, d.enter)).className;
    el.className = ['pt-bubble', skinOf(setting(`${kind}.skin`, 'soft')).className, enterClass, region === 'column' ? '' : `pt-bubble--at-${region}`, kindClass(b.kind)].filter(Boolean).join(' ');
    el.dataset.exit = exitOf(setting(`${kind}.exit`, d.exit)).id;
    el.dataset.enter = enterClass;
    render(el, b);
    layer.el.appendChild(el);
    const now = performance.now();
    return { id: b.id, el, region, session: b.session ?? '', pulse: b.pulse, spawnedAt: now, lastTouchedAt: now, placed: false, closing: false };
  };

  const close = (e: Entry) => {
    if (e.closing) return;
    e.closing = true;
    const ex = exitOf(e.el.dataset.exit);
    // Drop the enter class first so the two never fight over `animation`.
    e.el.classList.remove('pt-bubble--bump', e.el.dataset.enter ?? '');
    e.el.classList.add(ex.className);
    later(() => {
      e.el.remove();
      // The same bubble may have come back meanwhile (an older one evicted, then room again).
      if (entries.get(e.id) === e) entries.delete(e.id);
    }, ex.durationMs ?? DEFAULT_EXIT_MS);
  };

  const sync = (shown: ShownBubble[]) => {
    const visible = pickVisible(shown, Math.max(1, setting('perColumn', 3)));
    const keep = new Set<number>();
    for (const g of visible) {
      for (const b of g.items) {
        keep.add(b.id);
        let e = entries.get(b.id);
        if (!e || e.closing) {
          e = spawn(b);
          entries.set(b.id, e);
          continue;
        }
        render(e.el, b);
        e.lastTouchedAt = performance.now();
        if (b.pulse !== e.pulse) {
          e.pulse = b.pulse;
          if (performance.now() - e.spawnedAt >= ENTER_GUARD_MS) {
            const el = e.el;
            el.classList.remove('pt-bubble--bump');
            void el.offsetWidth; // restart the animation
            el.classList.add('pt-bubble--bump');
            later(() => el.classList.remove('pt-bubble--bump'), BUMP_MS);
          }
        }
      }
    }
    for (const e of entries.values()) if (!keep.has(e.id)) close(e);
    if (entries.size) frame ??= ctx.requestFrame(layout);
    layout();
  };

  const place = (e: Entry, p: Placed) => {
    const l = layer.toLocal({ x: p.cx, y: p.top });
    const left = `${Math.round(l.x)}px`;
    const top = `${Math.round(l.y)}px`;
    if (!e.placed) {
      // First position lands without the glide.
      e.el.style.left = left;
      e.el.style.top = top;
      void e.el.offsetWidth;
      e.el.classList.add('pt-bubble--placed');
      e.placed = true;
      return;
    }
    if (e.el.style.left !== left) e.el.style.left = left;
    if (e.el.style.top !== top) e.el.style.top = top;
  };

  function layout() {
    if (entries.size === 0) {
      frame?.dispose();
      frame = null;
      return;
    }
    const live = [...entries.values()].filter((e) => !e.closing);
    if (!live.length) return; // only exit animations left: they stay where they were
    const b = pet.opaqueBounds;
    const petBox: Box = { x: b.x, y: b.y, width: b.width, height: b.height };
    const screen = screenOf(ctx.desktop.screens(), b);
    const size = (e: Entry) => ({ w: e.el.offsetWidth, h: e.el.offsetHeight });
    const newestFirst = (xs: Entry[]) => xs.sort((a, c) => c.id - a.id);

    const columns = new Map<string, Entry[]>();
    const left: Entry[] = [];
    const below: Entry[] = [];
    for (const e of live) {
      if (e.region === 'left') left.push(e);
      else if (e.region === 'below') below.push(e);
      else columns.set(e.session, [...(columns.get(e.session) ?? []), e]);
    }
    const sticky = assignStickySlots(
      slotMemory,
      [...columns.entries()].map(([key, xs]) => ({ key, lastActiveAt: Math.max(...xs.map((e) => e.lastTouchedAt)) })),
    );
    slotMemory = sticky.memory;
    const band = [...columns.entries()].map(([key, xs]) => ({ key, slot: sticky.slots.get(key) ?? 0, width: Math.max(...xs.map((e) => e.el.offsetWidth)) }));
    const centers = packColumnBand(band, b.x + b.width / 2, Math.max(0, setting('columnGap', 24)), screen.x + MARGIN, screen.x + screen.width - MARGIN);
    for (const [key, xs] of columns) {
      const col = newestFirst(xs);
      stackColumn(col.map(size), centers.get(key) ?? b.x + b.width / 2, petBox, screen, GAP, MARGIN).forEach((p, i) => place(col[i], p));
    }
    const l = newestFirst(left);
    stackLeft(l.map(size), petBox, screen, GAP, MARGIN).forEach((p, i) => place(l[i], p));
    const d = newestFirst(below);
    stackBelow(d.map(size), petBox, screen, GAP, MARGIN).forEach((p, i) => place(d[i], p));
  }

  const sub = pet.on('bubbles', sync);
  return {
    dispose() {
      sub.dispose();
      frame?.dispose();
      for (const t of timers) t.dispose();
      for (const e of entries.values()) e.el.remove();
      entries.clear();
    },
  };
}

export default definePlugin({
  activate(ctx) {
    const layer = ctx.stage.addLayer({ z: 20 });
    const style = document.createElement('style');
    style.textContent = ALL_CSS;
    layer.el.appendChild(style);

    const perPet = new Map<string, Disposable>();
    const attach = (pet: PetHandle) => perPet.set(pet.id, petBubbles(ctx, layer, pet));
    ctx.pets.list().forEach(attach);
    ctx.pets.on('added', attach);
    ctx.pets.on('removed', (pet) => {
      perPet.get(pet.id)?.dispose();
      perPet.delete(pet.id);
    });
  },
});
