// Spike runtime. Throwaway code for docs/08 — not a base for real code.
//
// Coordinates: pets live in global *physical* desktop pixels (gx, gy = bottom-centre of the pet).
// Each stage converts to its own CSS pixels with its monitor origin and scale factor.
// stage-0 (primary monitor) runs the "kernel"; other stages only render and forward pointer input.

import { invoke } from '@tauri-apps/api/core';
import { listen, emitTo } from '@tauri-apps/api/event';

const q = new URLSearchParams(location.search);
const STAGE = Number(q.get('stage') ?? 0);
const STAGES = Number(q.get('n') ?? 1);
const SX = Number(q.get('x') ?? 0), SY = Number(q.get('y') ?? 0);
const SW = Number(q.get('w') ?? innerWidth), SH = Number(q.get('h') ?? innerHeight);
const SCALE = Number(q.get('scale') ?? devicePixelRatio);
const KERNEL = STAGE === 0;

const FRAMES = 12, SRC = 512, CSS = 256, MASK = 128, FPS = 12;
const PALETTE = [['#b0a0c4', '#8f7fa6'], ['#a3b8a0', '#7f977c'], ['#c9b89a', '#a8977a']];

const log = (line: string) => invoke('log_line', { line });

// ---------- sprites: 12-frame 512px spritesheet + low-res alpha mask (the "hit mask" cache) ----------

type Sheet = { url: string; mask: Uint8Array };

async function makeSheet(colors: string[]): Promise<Sheet> {
  const c = new OffscreenCanvas(SRC * FRAMES, SRC);
  const g = c.getContext('2d')!;
  for (let f = 0; f < FRAMES; f++) {
    const ox = f * SRC, ph = (f / FRAMES) * Math.PI * 2;
    const squash = Math.sin(ph) * 0.06;
    const rx = 190 * (1 + squash), ry = 170 * (1 - squash);
    g.fillStyle = colors[1];
    for (const side of [-1, 1]) { // little arms
      g.beginPath();
      g.ellipse(ox + 256 + side * (rx - 10), 330 + Math.sin(ph + side) * 18, 42, 26, side * 0.6, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = colors[0];
    g.beginPath();
    g.ellipse(ox + 256, SRC - ry - 8, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3c3446';
    const blink = f === 9 || f === 10;
    for (const ex of [196, 316]) {
      g.beginPath();
      g.ellipse(ox + ex, 300 - squash * 60, 18, blink ? 3 : 26, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  const blob = await c.convertToBlob({ type: 'image/png' });
  // Mask: alpha at 1/4 resolution, then drop the full-res pixels.
  const small = new OffscreenCanvas(MASK * FRAMES, MASK);
  const sg = small.getContext('2d')!;
  sg.drawImage(c, 0, 0, MASK * FRAMES, MASK);
  const px = sg.getImageData(0, 0, MASK * FRAMES, MASK).data;
  const mask = new Uint8Array(MASK * FRAMES * MASK);
  for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3];
  return { url: URL.createObjectURL(blob), mask };
}

// ---------- pet state + motion layers ----------

type Pet = {
  id: number; gx: number; gy: number; sheet: number; phase: number;
  frame: number; bob: number; rot: number; sx: number; sy: number;
  spring: { x: number; v: number };
  el: HTMLDivElement; shownFrame: number;
};

type RenderPet = Pick<Pet, 'id' | 'gx' | 'gy' | 'sheet' | 'frame' | 'bob' | 'rot' | 'sx' | 'sy'>;

const pets: Pet[] = [];
let sheets: Sheet[] = [];
let anim = true;

function addPetEl(sheet: number) {
  const el = document.createElement('div');
  el.className = 'pet';
  el.style.backgroundImage = `url(${sheets[sheet].url})`;
  document.body.appendChild(el);
  return el;
}

function ensurePet(r: RenderPet): Pet {
  let p = pets.find(p => p.id === r.id);
  if (!p) {
    p = { ...r, phase: 0, spring: { x: 0, v: 0 }, el: addPetEl(r.sheet), shownFrame: -1 };
    pets.push(p);
  }
  return p;
}

// Global physical -> this stage's CSS px.
const toLocal = (gx: number, gy: number) => [(gx - SX) / SCALE, (gy - SY) / SCALE];

function draw(p: Pet) {
  const [lx, ly] = toLocal(p.gx, p.gy);
  const visible = lx > -CSS && lx < SW / SCALE + CSS && ly > -CSS && ly < SH / SCALE + CSS * 2;
  p.el.style.display = visible ? '' : 'none';
  if (!visible) return;
  if (p.frame !== p.shownFrame) {
    p.el.style.backgroundPosition = `${-p.frame * CSS}px 0`;
    p.shownFrame = p.frame;
  }
  p.el.style.transform =
    `translate(${lx - CSS / 2}px, ${ly - CSS + p.bob}px) rotate(${p.rot}rad) scale(${p.sx}, ${p.sy})`;
}

// Inverse of draw()'s transform, then sample the mask.
function hitPet(p: Pet, cx: number, cy: number): boolean {
  const [lx, ly] = toLocal(p.gx, p.gy);
  let dx = cx - lx, dy = cy - (ly + p.bob);
  const c = Math.cos(-p.rot), s = Math.sin(-p.rot);
  [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
  dx /= p.sx; dy /= p.sy;
  const u = dx + CSS / 2, v = dy + CSS;
  if (u < 0 || v < 0 || u >= CSS || v >= CSS) return false;
  const k = MASK / CSS;
  const mx = p.frame * MASK + Math.floor(u * k), my = Math.floor(v * k);
  return sheets[p.sheet].mask[my * MASK * FRAMES + mx] > 32;
}

// ---------- cursor + passthrough ----------

let cursor = { x: -1e9, y: -1e9 }; // global physical
let hit = false;
let drag: { pet: Pet; ox: number; oy: number } | null = null;

function petAt(gx: number, gy: number): Pet | null {
  const [cx, cy] = toLocal(gx, gy);
  for (let i = pets.length - 1; i >= 0; i--) if (pets[i].el.style.display !== 'none' && hitPet(pets[i], cx, cy)) return pets[i];
  return null;
}

function updateHit() {
  const h = drag !== null || petAt(cursor.x, cursor.y) !== null;
  if (h !== hit) {
    hit = h;
    invoke('set_hit', { hit });
  }
}

function startDrag(gx: number, gy: number) {
  const p = petAt(gx, gy);
  if (!p) return;
  drag = { pet: p, ox: gx - p.gx, oy: gy - p.gy };
  p.spring.v -= 6; // squash on grab
  pets.splice(pets.indexOf(p), 1); pets.push(p); // bring to front
  document.body.appendChild(p.el);
  wake();
}

function endDrag() {
  if (!drag) return;
  drag.pet.spring.v += 9;
  drag = null;
  wake();
}

// ---------- kernel loop (stage-0) ----------

let running = false, frames = 0, worst = 0, lastT = 0, statT = 0;

function step(t: number) {
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  if (lastT) worst = Math.max(worst, t - lastT);
  lastT = t;
  frames++;
  let active = anim || drag !== null;
  for (const p of pets) {
    if (anim) {
      p.frame = Math.floor((t / 1000) * FPS + p.phase * FRAMES) % FRAMES;
      p.bob = Math.sin(t / 1000 * 2.4 + p.phase * 6.28) * 6;                     // sine layer
      p.rot = (Math.sin(t / 370 + p.id) + Math.sin(t / 530 + p.id * 2)) * 0.012; // noise-ish layer
    }
    // spring layer (squash/stretch)
    const k = 260, d = 14;
    p.spring.v += (-k * p.spring.x - d * p.spring.v) * dt;
    p.spring.x += p.spring.v * dt;
    if (Math.abs(p.spring.x) > 1e-3 || Math.abs(p.spring.v) > 1e-2) active = true;
    else p.spring.x = p.spring.v = 0;
    p.sy = 1 + p.spring.x * 0.25;
    p.sx = 1 - p.spring.x * 0.15;
    draw(p);
  }
  updateHit();
  if (STAGES > 1) {
    const out: RenderPet[] = pets.map(({ id, gx, gy, sheet, frame, bob, rot, sx, sy }) => ({ id, gx, gy, sheet, frame, bob, rot, sx, sy }));
    for (let i = 1; i < STAGES; i++) emitTo(`stage-${i}`, 'render', out);
  }
  if (t - statT > 2000) {
    if (statT) {
      const fps = (frames * 1000) / (t - statT);
      const heap = (performance as any).memory?.usedJSHeapSize / 1048576;
      log(`fps=${fps.toFixed(1)} worstFrame=${worst.toFixed(1)}ms heap=${heap?.toFixed(1)}MB pets=${pets.length}`);
    }
    statT = t; frames = 0; worst = 0;
  }
  if (active) requestAnimationFrame(step);
  else { running = false; lastT = 0; statT = 0; }
}

function wake() {
  if (!KERNEL || running) return;
  running = true;
  requestAnimationFrame(step);
}

// ---------- bubble (hook visualisation) ----------

function bubble(text: string) {
  const p = pets[0];
  if (!p) return;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  const [lx, ly] = toLocal(p.gx, p.gy);
  b.style.transform = `translate(${lx - 60}px, ${ly - CSS - 40}px)`;
  document.body.appendChild(b);
  setTimeout(() => { b.style.opacity = '0'; }, 2500);
  setTimeout(() => b.remove(), 3000);
}

// ---------- plugins ----------

const PLUGIN_BASE = navigator.userAgent.includes('Windows') ? 'http://petplugin.localhost' : 'petplugin://localhost';
const plugins = new Map<string, () => void>();

async function loadPlugin(id: string) {
  plugins.get(id)?.();
  plugins.delete(id);
  const t0 = performance.now();
  try {
    const mod = await import(/* @vite-ignore */ `${PLUGIN_BASE}/${id}/index.js?v=${Date.now()}`);
    const badges: HTMLElement[] = [];
    const ctx = {
      log: (s: string) => log(`[plugin ${id}] ${s}`),
      addBadge(text: string) {
        const el = document.createElement('span');
        el.textContent = text;
        document.getElementById('badges')!.appendChild(el);
        badges.push(el);
        return () => el.remove();
      },
    };
    const dispose = mod.activate(ctx);
    plugins.set(id, () => { dispose?.(); badges.forEach(b => b.remove()); });
    log(`plugin ${id} loaded in ${(performance.now() - t0).toFixed(1)}ms`);
  } catch (e) {
    log(`plugin ${id} failed: ${e}`);
  }
}

// ---------- boot ----------

async function boot() {
  const cfg = await invoke<{ pets: number; anim: boolean; hook_port: number }>('get_config');
  anim = cfg.anim;
  sheets = await Promise.all(PALETTE.map(makeSheet));

  await listen<{ x: number; y: number }>('cursor', e => {
    cursor = e.payload;
    if (KERNEL && drag) {
      drag.pet.gx = cursor.x - drag.ox;
      drag.pet.gy = cursor.y - drag.oy;
      wake();
    }
    if (!running) updateHit();
  });

  addEventListener('contextmenu', e => { e.preventDefault(); if (hit) invoke('quit'); });
  addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const gx = SX + e.clientX * SCALE, gy = SY + e.clientY * SCALE;
    document.body.setPointerCapture(e.pointerId);
    if (KERNEL) startDrag(gx, gy);
    else emitTo('stage-0', 'remote-down', { gx, gy });
  });
  addEventListener('pointerup', () => {
    if (KERNEL) endDrag();
    else emitTo('stage-0', 'remote-up', null);
  });

  if (KERNEL) {
    for (let i = 0; i < cfg.pets; i++) {
      const p = ensurePet({ id: i, sheet: i % sheets.length, gx: SX + SW * (0.3 + 0.2 * i), gy: SY + SH * 0.75, frame: 0, bob: 0, rot: 0, sx: 1, sy: 1 });
      p.phase = i / Math.max(1, cfg.pets);
    }
    await listen<{ gx: number; gy: number }>('remote-down', e => startDrag(e.payload.gx, e.payload.gy));
    await listen('remote-up', () => endDrag());
    await listen<{ seq: number; connector: string; body: string }>('hook', e => {
      invoke('hook_ack', { seq: e.payload.seq });
      let name = '';
      try { name = JSON.parse(e.payload.body).hook_event_name ?? ''; } catch {}
      bubble(`${e.payload.connector} · ${name || 'event'}`);
    });
    let timer = 0;
    await listen<string>('plugin-changed', e => {
      clearTimeout(timer);
      timer = setTimeout(() => loadPlugin(e.payload), 150) as unknown as number;
    });
    await loadPlugin('hello');
    pets.forEach(draw);
    wake();
    log(`kernel up: ${pets.length} pets, anim=${anim}, stages=${STAGES}, scale=${SCALE}, hookPort=${cfg.hook_port}`);
  } else {
    // Dumb renderer: mirror whatever the kernel says.
    await listen<RenderPet[]>('render', e => {
      for (const r of e.payload) {
        const p = ensurePet(r);
        Object.assign(p, r);
        draw(p);
      }
      updateHit();
    });
    log(`renderer up: stage ${STAGE}, scale=${SCALE}`);
  }
}

boot();
