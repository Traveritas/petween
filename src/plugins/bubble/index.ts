// `bubble` (docs/06 §6): draws whatever the kernel's bubble channel says is showing.
// The kernel decides WHO speaks and WHEN (queue + priority); this plugin only decides how it looks,
// so a third-party plugin can replace it with its own style.

import { definePlugin, type Disposable, type PetHandle, type PluginManifest } from '../../api/types';

export const manifest: PluginManifest = {
  id: 'bubble',
  name: '气泡',
  version: '0.1.0',
  apiVersion: 1,
  contributes: { channels: [] },
};

const CSS = `
.pw-bubble {
  position: absolute; left: 0; top: 0; max-width: 248px; box-sizing: border-box;
  padding: 8px 12px; border-radius: 12px;
  font: 13.5px/1.45 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; letter-spacing: 0.01em;
  color: #3a3442; background: rgba(248, 245, 240, 0.97);
  border: 1px solid rgba(70, 60, 90, 0.08);
  box-shadow: 0 6px 18px rgba(40, 30, 60, 0.14), 0 1px 3px rgba(40, 30, 60, 0.08);
  opacity: 0; transition: opacity 160ms ease-out, translate 180ms cubic-bezier(0.2, 0.8, 0.3, 1), scale 180ms cubic-bezier(0.2, 0.8, 0.3, 1);
  translate: 0 6px; scale: 0.96; transform-origin: 50% 100%; will-change: transform;
  word-break: break-word;
}
.pw-bubble.show { opacity: 1; translate: 0 0; scale: 1; }
.pw-bubble .t { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pw-bubble::after {
  content: ""; position: absolute; left: var(--tail, 50%); bottom: -5px; width: 10px; height: 10px; margin-left: -5px;
  background: inherit; border-right: inherit; border-bottom: inherit; rotate: 45deg; border-bottom-right-radius: 2px;
}
@media (prefers-color-scheme: dark) {
  .pw-bubble { color: #ece7f2; background: rgba(46, 42, 54, 0.96); border-color: rgba(255, 255, 255, 0.08); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35); }
}
@media (prefers-reduced-motion: reduce) { .pw-bubble { transition: opacity 120ms linear; translate: 0 0; scale: 1; } }
`;

/** Gap between the pet's visible top and the bubble's tail. */
const GAP = 12;
/** Keep bubbles this far inside the screen edges. */
const MARGIN = 8;

export default definePlugin({
  activate(ctx) {
    const layer = ctx.stage.addLayer({ z: 20 });
    const style = document.createElement('style');
    style.textContent = CSS;
    layer.el.appendChild(style);

    const attach = (pet: PetHandle) => {
      const el = document.createElement('div');
      el.className = 'pw-bubble';
      const text = document.createElement('div');
      text.className = 't';
      el.appendChild(text);
      layer.el.appendChild(el);
      let follow: Disposable | null = null;
      let hideTimer: Disposable | null = null;

      const place = () => {
        const b = pet.opaqueBounds;
        const screens = ctx.desktop.screens();
        const cx = b.x + b.width / 2;
        const s = screens.find((r) => cx >= r.x && cx <= r.x + r.width) ?? screens[0];
        const w = el.offsetWidth, h = el.offsetHeight;
        // Bubble positions are in global units; the primary stage's CSS px equal global px.
        let left = cx - w / 2;
        let top = b.y - GAP - h;
        if (s) {
          left = Math.max(s.x + MARGIN, Math.min(left, s.x + s.width - MARGIN - w));
          top = Math.max(s.y + MARGIN, top);
        }
        const local = layer.toLocal({ x: left, y: top });
        el.style.transform = `translate(${Math.round(local.x)}px, ${Math.round(local.y)}px)`;
        // The tail keeps pointing at the pet even when the bubble is pushed sideways.
        el.style.setProperty('--tail', `${Math.max(14, Math.min(w - 14, cx - left))}px`);
      };

      pet.on('bubble', (b) => {
        hideTimer?.dispose();
        hideTimer = null;
        if (b) {
          text.textContent = b.text;
          el.title = b.text;
          place();
          requestAnimationFrame(() => el.classList.add('show'));
          follow ??= ctx.requestFrame(place);
        } else {
          el.classList.remove('show');
          // Stop following once the fade-out is over, so the stage can idle.
          hideTimer = ctx.setTimeout(() => {
            follow?.dispose();
            follow = null;
          }, 220);
        }
      });
    };

    ctx.pets.list().forEach(attach);
    ctx.pets.on('added', attach);
  },
});
