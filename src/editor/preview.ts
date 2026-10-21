// The editor's live preview: a tiny kernel with one pet, the real Pet / Appearance / motion code and
// the dom2d renderer, so what you see here is what the desktop shows. No plugins run here.

import type { ClipDef, PetHandle, PetPack, Rect } from '../api/types';
import { BUILTIN_MOTION_TYPES } from '../kernel/motion/builtin';
import { Pet, petView, type LoadedPack } from '../kernel/pet';
import { validatePack } from '../kernel/pack/resolve';
import { Registries } from '../kernel/registry';
import { Scope } from '../kernel/scope';
import { BUILTIN_TRANSITIONS } from '../plugins/core';
import { AssetCache } from '../render/assets';
import { Coords } from '../render/coords';
import { Dom2dRenderer, type RenderPet } from '../render/dom2d';

export class Preview {
  private registries = new Registries();
  private assets = new AssetCache();
  private renderer: Dom2dRenderer;
  private pet: Pet | null = null;
  private view: PetHandle | null = null;
  private scope = new Scope();
  private raf = 0;
  private last = 0;
  private zoom = 1;
  private ghostClip: { clip: ClipDef; baseUrl: string; opacity: number } | null = null;
  private key = 'idle';
  private pending: ReturnType<typeof setTimeout> | null = null;
  private resize: ResizeObserver;
  /** Where the pet's feet stand, as fractions of the preview box. */
  readonly ground = { x: 0.5, y: 0.8 };

  constructor(private root: HTMLElement) {
    for (const m of BUILTIN_MOTION_TYPES) this.registries.motionTypes.add(m, 'core');
    for (const t of BUILTIN_TRANSITIONS) this.registries.transitionTypes.add(t, 'core');
    this.renderer = new Dom2dRenderer(root, this.assets, this.coords());
    this.resize = new ResizeObserver(() => {
      this.renderer.coords = this.coords();
      this.place();
    });
    this.resize.observe(root);
    const loop = (now: number) => {
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private coords() {
    const s = { label: 'preview', x: 0, y: 0, w: this.root.clientWidth, h: this.root.clientHeight, scale: 1 };
    return new Coords([s], s);
  }

  private place() {
    this.pet?.setBasePosition({ x: this.root.clientWidth * this.ground.x, y: this.root.clientHeight * this.ground.y });
  }

  /** Show `pack` (validated copy). The picture restarts, enter motion included. */
  setPack(pack: PetPack, baseUrl: string) {
    const { pack: valid } = validatePack(structuredClone(pack));
    const loaded: LoadedPack = { pack: valid, baseUrl };
    if (!this.pet) {
      this.pet = new Pet('preview', loaded, this.zoom, { x: 0, y: 0 }, {
        registries: this.registries,
        assets: this.assets,
        reducedMotion: () => false,
        log: (level, line) => (level === 'error' ? console.error : console.log)(line),
        wake: () => {},
      });
      this.view = petView(this.pet, 'editor', this.scope);
      this.place();
    } else this.pet.swapPack(loaded);
    this.pet.state.setBase(this.key);
  }

  /** Change one clip's anchor / scale in place, without restarting the picture (dragging). */
  patchClip(id: string, patch: Partial<ClipDef>) {
    const c = this.pet?.loaded.pack.clips[id];
    if (c) Object.assign(c, patch);
  }

  showState(key: string) {
    this.cancel();
    this.key = key;
    this.pet?.clip.setBase(null);
    this.pet?.state.setBase(key);
  }

  /** Show one clip directly (clip channel), whatever the state says; null goes back to the state. */
  showClip(id: string | null) {
    this.cancel();
    this.pet?.clip.setBase(id ? { clip: id } : null);
  }

  /** Play the switch into the current state again, optionally coming from another state. */
  replay(from?: string) {
    this.cancel();
    if (!this.pet) return;
    if (from && from !== this.key) {
      this.pet.state.setBase(from);
      this.pending = setTimeout(() => this.pet?.state.setBase(this.key), 900);
    } else this.pet.swapPack(this.pet.loaded);
  }

  private cancel() {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }

  setZoom(z: number) {
    this.zoom = z;
    if (this.pet) this.pet.scale = z;
  }

  /** A faint reference picture under the pet, at the same feet position (aligning clips). */
  setGhost(g: { clip: ClipDef; baseUrl: string; opacity?: number } | null) {
    this.ghostClip = g ? { ...g, opacity: g.opacity ?? 0.4 } : null;
  }

  /** Picture box of the pet, in preview px (before motion). */
  bounds(): Rect | null {
    return this.pet ? this.pet.bounds() : null;
  }

  /** The feet point (pet position) in preview px. */
  feet() {
    return this.pet?.pos ?? null;
  }

  private frame(now: number) {
    const dt = this.last ? Math.min(100, now - this.last) : 16;
    this.last = now;
    const out: RenderPet[] = [];
    if (this.pet && this.view) {
      const rp = this.pet.tick(now, dt, this.view);
      rp.z = 2;
      const g = this.ghostClip;
      if (g) {
        const count = g.clip.type === 'frames' ? Math.max(1, g.clip.frames?.count ?? 1) : 1;
        out.push({
          id: 'ghost',
          z: 1,
          x: rp.x,
          y: rp.y,
          outline: false,
          transform: { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, skewX: 0, skewY: 0, opacity: 1 },
          layers: [{ src: new URL(g.clip.source, g.baseUrl).href, columns: g.clip.frames?.columns ?? count, count, frame: 0, opacity: g.opacity, anchor: g.clip.anchor ?? { x: 0.5, y: 0.96 }, scale: (g.clip.scale ?? 1) * (this.pet.loaded.pack.scale ?? 1) * this.zoom }],
        });
      }
      out.push(rp);
    }
    this.renderer.render(out);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.cancel();
    this.resize.disconnect();
    this.scope.dispose();
    this.pet?.dispose();
    this.renderer.clear();
  }
}
