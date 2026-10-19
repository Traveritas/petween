// The v1 renderer (docs/01 §3 `renderers`: dom2d). Draws RenderPets into one stage and hit-tests them.
// All sizes are in global units; each stage converts with its own scale, so mixed-DPI monitors agree.

import type { Point } from '../api/types';
import type { Transform } from '../kernel/motion/compose';
import { alphaAt, type AssetCache } from './assets';
import type { Coords } from './coords';

export interface RenderLayer {
  src: string;
  columns: number;
  count: number;
  frame: number;
  opacity: number;
  anchor: Point;
  /** Global px per image px. */
  scale: number;
}

/** Serializable frame description of one pet (also sent to mirror stages). */
export interface RenderPet {
  id: string;
  z: number;
  /** Anchor position, global. */
  x: number;
  y: number;
  transform: Transform;
  layers: RenderLayer[];
  /** Rescue mode: whole box is clickable and outlined. */
  outline: boolean;
}

interface LayerView {
  el: HTMLDivElement;
  m: DOMMatrix | null;
  w: number;
  h: number;
  styleKey: string;
}

interface PetView {
  root: HTMLDivElement;
  layers: LayerView[];
  last: RenderPet;
}

const ALPHA_HIT = 32;

export class Dom2dRenderer {
  private views = new Map<string, PetView>();

  constructor(
    private root: HTMLElement,
    private assets: AssetCache,
    public coords: Coords,
  ) {}

  render(pets: RenderPet[]) {
    const seen = new Set<string>();
    for (const p of pets) {
      seen.add(p.id);
      let v = this.views.get(p.id);
      if (!v) {
        const root = document.createElement('div');
        root.className = 'pet';
        this.root.appendChild(root);
        v = { root, layers: [], last: p };
        this.views.set(p.id, v);
      }
      v.last = p;
      v.root.style.zIndex = String(100 + p.z);
      this.drawLayers(v, p);
    }
    for (const [id, v] of this.views) {
      if (!seen.has(id)) {
        v.root.remove();
        this.views.delete(id);
      }
    }
  }

  private drawLayers(v: PetView, p: RenderPet) {
    while (v.layers.length < p.layers.length) {
      const el = document.createElement('div');
      el.className = 'clip';
      v.root.appendChild(el);
      v.layers.push({ el, m: null, w: 0, h: 0, styleKey: '' });
    }
    while (v.layers.length > p.layers.length) v.layers.pop()!.el.remove();

    const k = this.coords.cssPerGlobal;
    const at = this.coords.toLocal({ x: p.x, y: p.y });
    const t = p.transform;
    const vw = innerWidth, vh = innerHeight;
    p.layers.forEach((l, i) => {
      const lv = v.layers[i];
      const a = this.assets.get(l.src, l.columns, l.count);
      if (!a) {
        lv.el.style.display = 'none';
        lv.m = null;
        return;
      }
      const w = a.frameW * l.scale * k;
      const h = a.frameH * l.scale * k;
      const m = new DOMMatrix()
        .translate(at.x + t.x * k, at.y + t.y * k)
        .rotate(t.rotate)
        .skewX(t.skewX)
        .skewY(t.skewY)
        .scale(t.scaleX, t.scaleY)
        .translate(-l.anchor.x * w, -l.anchor.y * h);
      lv.m = m;
      lv.w = w;
      lv.h = h;
      // Cull when the box is clearly off this stage.
      const r = Math.max(w, h) * Math.max(Math.abs(t.scaleX), Math.abs(t.scaleY), 1) * 1.5;
      const visible = at.x + r > 0 && at.x - r < vw && at.y + r > 0 && at.y - r < vh;
      const col = l.frame % a.columns;
      const row = Math.floor(l.frame / a.columns);
      const opacity = Math.max(0, Math.min(1, t.opacity * l.opacity));
      const key = [visible, a.displayUrl, w, h, col, row, m.toString(), opacity, p.outline].join('|');
      if (key === lv.styleKey) return;
      lv.styleKey = key;
      const s = lv.el.style;
      s.display = visible ? '' : 'none';
      if (!visible) return;
      s.width = `${w}px`;
      s.height = `${h}px`;
      s.backgroundImage = `url("${a.displayUrl}")`;
      s.backgroundSize = `${a.columns * w}px ${a.rows * h}px`;
      s.backgroundPosition = `${-col * w}px ${-row * h}px`;
      s.transform = m.toString();
      s.opacity = String(opacity);
      s.outline = p.outline ? '2px dashed rgba(120, 110, 140, 0.8)' : '';
    });
  }

  /** Topmost pet under a stage-local CSS point. `padPx` widens the test (hysteresis while hovering). */
  hitTest(pt: Point, padPx = 0, prefer: string | null = null): string | null {
    const order = [...this.views.values()].sort((a, b) => b.last.z - a.last.z);
    for (const v of order) {
      if (this.hitView(v, pt, 0)) return v.last.id;
    }
    if (padPx > 0 && prefer) {
      const v = this.views.get(prefer);
      if (v && this.hitView(v, pt, padPx)) return prefer;
    }
    return null;
  }

  private hitView(v: PetView, pt: Point, pad: number): boolean {
    // The newest (top) layer decides; a crossfade's outgoing layer is underneath it.
    const i = v.layers.length - 1;
    const lv = v.layers[i];
    const l = v.last.layers[i];
    if (!lv?.m || !l) return false;
    const a = this.assets.get(l.src, l.columns, l.count);
    if (!a) return false;
    const inv = lv.m.inverse();
    const probes = pad > 0 ? [[0, 0], [pad, 0], [-pad, 0], [0, pad], [0, -pad], [pad, pad], [-pad, -pad], [pad, -pad], [-pad, pad]] : [[0, 0]];
    for (const [dx, dy] of probes) {
      const q = inv.transformPoint(new DOMPoint(pt.x + dx, pt.y + dy));
      if (q.x < 0 || q.y < 0 || q.x >= lv.w || q.y >= lv.h) continue;
      if (v.last.outline) return true;
      if (alphaAt(a, l.frame, (q.x / lv.w) * a.frameW, (q.y / lv.h) * a.frameH) > ALPHA_HIT) return true;
    }
    return false;
  }

  clear() {
    for (const v of this.views.values()) v.root.remove();
    this.views.clear();
  }
}
