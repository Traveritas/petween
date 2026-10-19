// A non-primary stage: renders what the kernel sends and reports pointer input back (docs/01 §2).

import { AssetCache } from '../render/assets';
import { Coords, type StageInfo } from '../render/coords';
import { Dom2dRenderer } from '../render/dom2d';
import type { Host, RemoteInput } from '../kernel/host';

const KERNEL = 'stage-0';
const HOVER_PAD = 6;

export async function startMirror(host: Host, label: string, root: HTMLElement) {
  const coordsFor = (layout: StageInfo[]) => new Coords(layout, layout.find((s) => s.label === label) ?? layout[0]);
  const assets = new AssetCache();
  const renderer = new Dom2dRenderer(root, assets, coordsFor(await host.layout()));
  let cursor = { x: -1e6, y: -1e6 };
  let hover: string | null = null;
  let hit = false;
  let pressed = false;

  const send = (r: Omit<RemoteInput, 'stage'>) => void host.emitTo(KERNEL, 'remote-input', { ...r, stage: label });

  const update = () => {
    const id = renderer.hitTest(renderer.coords.toLocal(cursor), HOVER_PAD, hover);
    if (id !== hover) {
      hover = id;
      send({ type: 'hover', petId: id, x: cursor.x, y: cursor.y, button: 0 });
    }
    const h = pressed || id !== null;
    if (h !== hit) {
      hit = h;
      void host.setHit(h);
    }
  };

  let last: Parameters<Dom2dRenderer['render']>[0] = [];
  assets.onLoaded = () => renderer.render(last);
  await host.on('frame', (pets) => {
    last = pets;
    renderer.render(pets);
    update();
  });
  await host.on('layout', (l) => {
    renderer.coords = coordsFor(l);
  });
  await host.on('cursor', (c) => {
    cursor = renderer.coords.physToGlobal(c.x, c.y);
    update();
  });

  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('pointerdown', (e) => {
    const g = renderer.coords.toGlobal({ x: e.clientX, y: e.clientY });
    const id = renderer.hitTest({ x: e.clientX, y: e.clientY }, HOVER_PAD, hover);
    if (!id) return;
    pressed = true;
    document.body.setPointerCapture(e.pointerId);
    send({ type: 'down', petId: id, x: g.x, y: g.y, button: e.button });
  });
  const up = (e: PointerEvent) => {
    if (!pressed) return;
    pressed = false;
    const g = renderer.coords.toGlobal({ x: e.clientX, y: e.clientY });
    send({ type: 'up', petId: hover, x: g.x, y: g.y, button: e.button });
    update();
  };
  addEventListener('pointerup', up);
  addEventListener('lostpointercapture', (e) => up(e as PointerEvent));
  host.log('info', `mirror ${label} up`);
}
