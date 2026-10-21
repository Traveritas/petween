// Skins + enter/exit animations for the bubble renderer. The CSS is v0's, unchanged (v0-presets.ts);
// v0 had one renderer per content type, this one has a generic shape, so v0's class names are mapped:
//
//   v0 .pt-bubble__timer / __lines  →  .pt-bubble__value   (the emphasised figure)
//   v0 .pt-bubble__files            →  .pt-bubble__note    (secondary detail)
//   v0 .pt-bubble__reply / __turn   →  .pt-bubble__text    (a paragraph / a sentence)
//   v0 kind-thinking / kind-edit    →  kind-status
//   v0 kind-turn                    →  kind-summary
//   plain speech (new)              →  shaped like a reply (a card), without the caption

import type { BubbleKind, ShownBubble } from '../../api/types';
import { V0_ENTERS, V0_EXITS, V0_SKINS, type CssPreset } from './v0-presets';

export type { CssPreset };

const adapt = (css: string) =>
  css
    .replace(/\.pt-bubble__(timer|lines)/g, '.pt-bubble__value')
    .replace(/\.pt-bubble__files/g, '.pt-bubble__note')
    .replace(/\.pt-bubble--kind-turn/g, '.pt-bubble--kind-summary')
    .replace(/\.pt-bubble--kind-reply/g, ':is(.pt-bubble--kind-reply, .pt-bubble--kind-speech)');

export const SKINS: CssPreset[] = V0_SKINS.map((s) => ({ ...s, css: adapt(s.css) }));
export const ENTERS: CssPreset[] = V0_ENTERS;
export const EXITS: CssPreset[] = V0_EXITS;

/** Must cover the longest exit keyframe that declares no duration (v0 BUBBLE_EXIT_MS). */
export const DEFAULT_EXIT_MS = 450;

export const skin = (id: string | undefined) => SKINS.find((s) => s.id === id) ?? SKINS.find((s) => s.id === 'soft')!;
export const enter = (id: string | undefined) => ENTERS.find((s) => s.id === id) ?? ENTERS[0];
export const exit = (id: string | undefined) => EXITS.find((s) => s.id === id) ?? EXITS[0];

/** Layout + shared rules (v0 BASE_CSS, adapted to stage layers and the generic shape). */
export const BASE_CSS = `
.pt-bubble { position: absolute; left: 0; top: 0; transform: translate(-50%, 0); white-space: nowrap; max-width: 340px; box-sizing: border-box; pointer-events: none; }
.pt-bubble--kind-reply, .pt-bubble--kind-speech { white-space: normal; width: max-content; max-width: 300px; overflow-wrap: anywhere; }
/* Repositioning glides instead of jumping; the first placement skips the transition. */
.pt-bubble--placed { transition: left 260ms ease, top 260ms ease; }
/* Reply previews at the pet's left: three lines at most. */
.pt-bubble--at-left .pt-bubble__text { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pt-bubble--kind-speech .pt-bubble__text { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
@keyframes pt-bubble-bump {
  0% { transform: translate(-50%, 0) scale(1); }
  40% { transform: translate(-50%, 0) scale(1.12); }
  100% { transform: translate(-50%, 0) scale(1); }
}
.pt-bubble--bump { animation: pt-bubble-bump 220ms ease both; }
@media (prefers-reduced-motion: reduce) {
  .pt-bubble, .pt-bubble * { animation-duration: 1ms !important; transition: none !important; }
}
`;

export const ALL_CSS = [BASE_CSS, ...SKINS.map((s) => s.css), ...ENTERS.map((s) => s.css), ...EXITS.map((s) => s.css)].join('\n');

/** The class a skin refines per kind; anything unknown is drawn as speech. */
export const kindClass = (kind: BubbleKind) => `pt-bubble--kind-${['status', 'reply', 'summary'].includes(kind) ? kind : 'speech'}`;

const part = (el: HTMLElement, cls: string, text: string | undefined) => {
  let node = el.querySelector<HTMLElement>(`:scope > .${cls}`);
  if (!text) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement('span');
    node.className = cls;
    // Keep a stable order: label, value, note, text.
    const order = ['pt-bubble__label', 'pt-bubble__value', 'pt-bubble__note', 'pt-bubble__text'];
    const after = [...el.children].find((c) => order.indexOf(c.classList[0]) > order.indexOf(cls));
    el.insertBefore(node, after ?? null);
  }
  if (node.textContent !== text) node.textContent = text;
};

/** Fill a bubble element. textContent only — nothing from a plugin is parsed as markup. */
export function render(el: HTMLElement, b: ShownBubble) {
  part(el, 'pt-bubble__label', b.label);
  const hasValue = !!b.value;
  part(el, 'pt-bubble__value', b.value);
  part(el, 'pt-bubble__note', hasValue ? b.note : undefined);
  part(el, 'pt-bubble__text', hasValue ? undefined : b.text);
  el.title = b.text;
}
