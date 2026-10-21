// Bubble skins and enter/exit animations, copied verbatim from v0 (petween-desktop
// src/renderer/companions/bubbles/styles.ts + animations.ts, as tuned by the author through v0.3.15).
// skins.ts maps v0's per-kind class names onto the generic bubble shape.

export interface CssPreset {
  id: string;
  label: string;
  className: string;
  css: string;
  /** Exit animations: how long until the element is removed. */
  durationMs?: number;
}

export const V0_SKINS: CssPreset[] = [
  {
    id: "glass",
    label: "玻璃",
    className: "pt-bubble--glass",
    css: `
.pt-bubble--glass {
  background: rgba(24, 28, 38, 0.62);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  color: #f4f6fb;
  font-size: 13px;
  line-height: 1;
  padding: 6px 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
}
.pt-bubble--glass .pt-bubble__label { opacity: 0.65; margin-right: 6px; }
.pt-bubble--glass .pt-bubble__timer { font-variant-numeric: tabular-nums; font-weight: 600; }
.pt-bubble--glass .pt-bubble__lines { font-variant-numeric: tabular-nums; font-weight: 600; }
.pt-bubble--glass .pt-bubble__files { opacity: 0.65; margin-left: 6px; font-weight: 400; }
/* Kind refinements: a pill suits short chips; paragraphs and summaries get
   card shapes (user feedback v0.3.7). */
.pt-bubble--glass.pt-bubble--kind-reply {
  border-radius: 14px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--glass.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.pt-bubble--glass.pt-bubble--kind-turn {
  border-radius: 16px;
  padding: 8px 16px;
}
`,
  },
  {
    id: "terminal",
    label: "终端",
    className: "pt-bubble--terminal",
    css: `
.pt-bubble--terminal {
  background: #101418;
  border: 1px solid #2f3b47;
  border-radius: 4px;
  color: #9fe8b5;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1;
  padding: 5px 9px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
}
.pt-bubble--terminal .pt-bubble__label { color: #5d7285; margin-right: 6px; }
.pt-bubble--terminal .pt-bubble__timer,
.pt-bubble--terminal .pt-bubble__lines { color: #ffd479; font-weight: 600; }
.pt-bubble--terminal .pt-bubble__files { color: #5d7285; margin-left: 6px; }
.pt-bubble--terminal.pt-bubble--kind-reply {
  padding: 9px 12px;
  line-height: 1.55;
  text-align: left;
  border-radius: 6px;
}
.pt-bubble--terminal.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--terminal.pt-bubble--kind-turn {
  padding: 7px 12px;
  border-radius: 6px;
}
`,
  },
  {
    id: "soft",
    label: "浅色",
    className: "pt-bubble--soft",
    css: `
.pt-bubble--soft {
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 10px;
  color: #2a3346;
  font-size: 13px;
  line-height: 1;
  padding: 6px 11px;
  box-shadow: 0 3px 12px rgba(20, 30, 60, 0.18);
}
.pt-bubble--soft .pt-bubble__label { color: #8a93a8; margin-right: 6px; }
.pt-bubble--soft .pt-bubble__timer,
.pt-bubble--soft .pt-bubble__lines { color: #3b7dd8; font-weight: 700; }
.pt-bubble--soft .pt-bubble__files { color: #8a93a8; margin-left: 6px; }
.pt-bubble--soft.pt-bubble--kind-reply {
  border-radius: 12px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--soft.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--soft.pt-bubble--kind-turn {
  border-radius: 12px;
  padding: 8px 14px;
}
`,
  },
  {
    id: "comic",
    label: "漫画",
    className: "pt-bubble--comic",
    css: `
/* The classic speech bubble: paper + ink outline + a tail pointing at the
   pet. The tail is a 45°-rotated square whose border-right/bottom form the
   pointer V (the top vertex stays open so it merges into the bubble; the
   opaque paper of the pseudo covers the parent's border seam behind it).
   It repositions per placement: columns hang above the pet (tail bottom),
   reply previews sit at the pet's left (tail right), turn summaries below
   (tail top). */
.pt-bubble--comic {
  background: #fffdf6;
  border: 2px solid #232a3d;
  border-radius: 13px;
  color: #232a3d;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  padding: 6px 13px;
  box-shadow: 2px 3px 0 rgba(35, 42, 61, 0.16);
}
.pt-bubble--comic::after {
  content: '';
  position: absolute;
  bottom: -7.5px;
  left: 50%;
  width: 12px;
  height: 12px;
  background: #fffdf6;
  border-right: 2px solid #232a3d;
  border-bottom: 2px solid #232a3d;
  transform: translateX(-50%) rotate(45deg);
}
/* At the pet's left the tail points right: the rotated square's RIGHT
   vertex is the pointer, so its two edges (top+right) carry the ink. */
.pt-bubble--at-left.pt-bubble--comic::after {
  bottom: auto;
  left: auto;
  right: -7.5px;
  top: 50%;
  border-right-width: 0;
  border-bottom-width: 0;
  border-top: 2px solid #232a3d;
  border-right: 2px solid #232a3d;
  transform: translateY(-50%) rotate(45deg);
}
/* Below the pet the tail points up: the TOP vertex is the pointer, edges
   left+top. */
.pt-bubble--at-below.pt-bubble--comic::after {
  bottom: auto;
  left: 50%;
  top: -7.5px;
  border-bottom-width: 0;
  border-top: 2px solid #232a3d;
  border-left: 2px solid #232a3d;
  transform: translateX(-50%) rotate(45deg);
}
.pt-bubble--comic .pt-bubble__label { color: #6b7694; margin-right: 6px; font-weight: 600; }
.pt-bubble--comic .pt-bubble__timer { font-variant-numeric: tabular-nums; font-weight: 700; }
.pt-bubble--comic .pt-bubble__lines { font-variant-numeric: tabular-nums; font-weight: 700; }
.pt-bubble--comic .pt-bubble__files { color: #6b7694; margin-left: 6px; font-weight: 400; }
.pt-bubble--comic.pt-bubble--kind-reply {
  border-radius: 15px;
  padding: 10px 15px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--comic.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.04em;
}
.pt-bubble--comic.pt-bubble--kind-turn {
  background: #fff6df;
  border-radius: 15px;
  padding: 8px 16px;
}
.pt-bubble--comic.pt-bubble--kind-turn::before { content: '\\2713  '; color: #2f9e63; }
`,
  },
  {
    id: "memo",
    label: "便签",
    className: "pt-bubble--memo",
    css: `
.pt-bubble--memo {
  rotate: -1.6deg;
  background: #fbf0c4;
  border: 1px solid rgba(122, 100, 44, 0.28);
  border-radius: 6px;
  color: #4d4433;
  font-family: 'Segoe Script', 'KaiTi', '楷体', cursive;
  font-size: 13px;
  line-height: 1.35;
  padding: 8px 12px 7px;
  box-shadow: 0 5px 14px rgba(120, 96, 40, 0.22);
}
.pt-bubble--memo::before {
  content: '';
  position: absolute;
  top: -7px;
  left: 50%;
  width: 46px;
  height: 15px;
  background: rgba(255, 255, 255, 0.5);
  box-shadow: 0 1px 3px rgba(120, 96, 40, 0.2);
  transform: translateX(-50%) rotate(-2.5deg);
}
.pt-bubble--memo .pt-bubble__label { color: #95834a; margin-right: 6px; }
.pt-bubble--memo .pt-bubble__timer,
.pt-bubble--memo .pt-bubble__lines { color: #a86e1f; font-weight: 700; font-variant-numeric: tabular-nums; }
.pt-bubble--memo .pt-bubble__files { color: #95834a; margin-left: 6px; }
.pt-bubble--memo.pt-bubble--kind-reply {
  border-radius: 8px;
  padding: 10px 14px;
  line-height: 1.6;
  text-align: left;
}
.pt-bubble--memo.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
}
.pt-bubble--memo.pt-bubble--kind-turn {
  border-radius: 8px;
  padding: 8px 14px;
}
.pt-bubble--memo.pt-bubble--kind-turn::before { content: '\\2714  '; color: #4e8d5b; }
`,
  },
  {
    id: "neon",
    label: "霓虹",
    className: "pt-bubble--neon",
    css: `
.pt-bubble--neon {
  background: rgba(7, 12, 24, 0.78);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(94, 230, 255, 0.5);
  border-radius: 10px;
  color: #e9fbff;
  font-size: 13px;
  line-height: 1;
  padding: 6px 12px;
  box-shadow:
    0 0 10px rgba(94, 230, 255, 0.22),
    inset 0 0 12px rgba(94, 230, 255, 0.1),
    0 4px 18px rgba(0, 0, 0, 0.4);
}
.pt-bubble--neon .pt-bubble__label { color: #66d9f2; margin-right: 6px; text-shadow: 0 0 6px rgba(94, 230, 255, 0.45); }
.pt-bubble--neon .pt-bubble__timer,
.pt-bubble--neon .pt-bubble__lines { color: #8ef1ff; font-weight: 600; font-variant-numeric: tabular-nums; text-shadow: 0 0 7px rgba(94, 230, 255, 0.55); }
.pt-bubble--neon .pt-bubble__files { color: #66d9f2; margin-left: 6px; opacity: 0.8; }
.pt-bubble--neon.pt-bubble--kind-reply {
  border-radius: 12px;
  padding: 10px 14px;
  line-height: 1.55;
  text-align: left;
}
.pt-bubble--neon.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
}
.pt-bubble--neon.pt-bubble--kind-turn {
  border-radius: 12px;
  padding: 8px 14px;
  border-color: rgba(94, 230, 255, 0.65);
}
`,
  },
  {
    id: "ink",
    label: "墨金",
    className: "pt-bubble--ink",
    css: `
.pt-bubble--ink {
  background: #17181d;
  border: 1px solid rgba(198, 162, 102, 0.3);
  border-radius: 7px;
  color: #efe8da;
  font-family: Georgia, 'Times New Roman', 'SimSun', '宋体', serif;
  font-size: 13px;
  line-height: 1;
  padding: 6px 13px;
  box-shadow: inset 3px 0 0 0 #b28c4e, 0 4px 14px rgba(0, 0, 0, 0.35);
}
.pt-bubble--ink .pt-bubble__label { color: #c9a45c; margin-right: 7px; letter-spacing: 0.12em; }
.pt-bubble--ink .pt-bubble__timer,
.pt-bubble--ink .pt-bubble__lines { color: #f6efdd; font-weight: 600; font-variant-numeric: tabular-nums; }
.pt-bubble--ink .pt-bubble__files { color: #c9a45c; margin-left: 7px; opacity: 0.75; }
.pt-bubble--ink.pt-bubble--kind-reply {
  border-radius: 9px;
  padding: 10px 15px;
  line-height: 1.6;
  text-align: left;
}
.pt-bubble--ink.pt-bubble--kind-reply .pt-bubble__label {
  display: block;
  margin: 0 0 4px;
  font-size: 11px;
  letter-spacing: 0.16em;
}
.pt-bubble--ink.pt-bubble--kind-turn {
  border-radius: 9px;
  padding: 8px 16px;
  box-shadow:
    inset 3px 0 0 0 #b28c4e,
    inset 0 1px 0 0 rgba(198, 162, 102, 0.5),
    inset 0 -1px 0 0 rgba(198, 162, 102, 0.5),
    0 4px 14px rgba(0, 0, 0, 0.35);
}
`,
  },
];

export const V0_ENTERS: CssPreset[] = [
  {
    id: "pop",
    label: "弹出",
    className: "pt-bubble-enter-pop",
    css: `
@keyframes pt-bubble-pop-in {
  0% { transform: translate(-50%, 0) scale(0.5); opacity: 0; }
  70% { transform: translate(-50%, 0) scale(1.08); opacity: 1; }
  100% { transform: translate(-50%, 0) scale(1); opacity: 1; }
}
.pt-bubble-enter-pop { animation: pt-bubble-pop-in 260ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }
`,
  },
  {
    id: "rise",
    label: "升起",
    className: "pt-bubble-enter-rise",
    css: `
@keyframes pt-bubble-rise-in {
  from { transform: translate(-50%, 14px); opacity: 0; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
.pt-bubble-enter-rise { animation: pt-bubble-rise-in 280ms ease-out both; }
`,
  },
  {
    id: "fade",
    label: "淡入",
    className: "pt-bubble-enter-fade",
    css: `
@keyframes pt-bubble-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pt-bubble-enter-fade { animation: pt-bubble-fade-in 240ms ease both; }
`,
  },
  {
    id: "drop",
    label: "坠落",
    className: "pt-bubble-enter-drop",
    css: `
@keyframes pt-bubble-drop-in {
  0% { transform: translate(-50%, -18px); opacity: 0; }
  60% { transform: translate(-50%, 3px); opacity: 1; }
  100% { transform: translate(-50%, 0); opacity: 1; }
}
.pt-bubble-enter-drop { animation: pt-bubble-drop-in 340ms cubic-bezier(0.3, 0.9, 0.4, 1.2) both; }
`,
  },
  {
    id: "drift-in",
    label: "飘落",
    className: "pt-bubble-enter-drift-in",
    css: `
.pt-bubble-enter-drift-in {
  transform-origin: 50% -80px;
  animation:
    pt-bubble-drift-fall 640ms cubic-bezier(0.3, 0.7, 0.4, 1) both,
    pt-bubble-drift-in-sway 640ms ease-in-out both;
}
@keyframes pt-bubble-drift-fall {
  from { transform: translate(-50%, -34px); opacity: 0; }
  60% { opacity: 0.9; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
@keyframes pt-bubble-drift-in-sway {
  0% { rotate: -2.4deg; }
  40% { rotate: 1.8deg; }
  75% { rotate: -0.8deg; }
  100% { rotate: 0deg; }
}
`,
  },
];

export const V0_EXITS: CssPreset[] = [
  {
    id: "fade",
    label: "淡出",
    className: "pt-bubble-exit-fade",
    css: `
@keyframes pt-bubble-fade-out {
  to { opacity: 0; }
}
.pt-bubble-exit-fade { animation: pt-bubble-fade-out 400ms ease both; }
`,
  },
  {
    id: "sink",
    label: "沉落",
    className: "pt-bubble-exit-sink",
    css: `
@keyframes pt-bubble-sink-out {
  to { transform: translate(-50%, 10px); opacity: 0; }
}
.pt-bubble-exit-sink { animation: pt-bubble-sink-out 400ms ease-in both; }
`,
  },
  {
    id: "shrink",
    label: "缩小",
    className: "pt-bubble-exit-shrink",
    css: `
@keyframes pt-bubble-shrink-out {
  to { transform: translate(-50%, 0) scale(0.6); opacity: 0; }
}
.pt-bubble-exit-shrink { animation: pt-bubble-shrink-out 380ms ease-in both; }
`,
  },
  {
    id: "drift",
    label: "随风",
    className: "pt-bubble-exit-drift",
    durationMs: 1050,
    css: `
.pt-bubble-exit-drift {
  transform-origin: 50% -80px;
  animation:
    pt-bubble-drift-rise 1000ms cubic-bezier(0.3, 0.4, 0.5, 1) both,
    pt-bubble-drift-out-sway 1000ms ease-in-out both;
}
@keyframes pt-bubble-drift-rise {
  0% { transform: translate(-50%, 0); opacity: 1; }
  40% { opacity: 0.88; }
  100% { transform: translate(-50%, -46px); opacity: 0; }
}
@keyframes pt-bubble-drift-out-sway {
  0% { rotate: 0deg; }
  25% { rotate: 2.2deg; }
  50% { rotate: -1.8deg; }
  75% { rotate: 1.4deg; }
  100% { rotate: 0.6deg; }
}
`,
  },
];
