// Particle effects, ported from v0 (petween/src/client/overlay/particles.ts). Every effect is one row
// of data; there is a single emitter path. One WAAPI animation per particle, no frame loop: an element
// removes itself when its animation settles.

export type ParticleShape = 'strip' | 'dot' | 'star' | 'cross' | 'heart' | 'ring' | 'petal';

export interface ParticleEffectSpec {
  /** Particles per burst (capped at MAX_PER_BURST). */
  count: number;
  shapes: readonly ParticleShape[];
  colors: readonly string[];
  /** px size range (strip: width, height follows; others: side). */
  size: readonly [number, number];
  /** px travel range from the burst origin. */
  distance: readonly [number, number];
  /** ms lifetime range. */
  duration: readonly [number, number];
  /** Extra downward drift in px; negative = floats up. */
  gravity: number;
  /** deg spin range, in a random direction. */
  spin: readonly [number, number];
}

export const MAX_PER_BURST = 48;
/** Backstop against burst spam: total live elements. */
export const MAX_LIVE = 160;

const CONFETTI = ['#ff5a5f', '#ffb400', '#3ec1d3', '#7c5cff', '#ff7ac8', '#59d98c'];
const STARS = ['#ffd23f', '#ffb400', '#fff3b0', '#ff8c42'];
const SPARKLES = ['#ffffff', '#fff3b0', '#cde7ff', '#ffe9a8'];
const HEARTS = ['#ff5a8a', '#ff8fab', '#ff2e63', '#ffc2d1'];
const PETALS = ['#ffb7c5', '#ffd1dc', '#ff8fab', '#ffe5ec'];
const FIREWORK = ['#ff5a5f', '#ffd23f', '#3ec1d3', '#7c5cff', '#ff7ac8'];

export const BUILTIN_EFFECTS: Record<string, ParticleEffectSpec> = {
  // Colourful paper bits tossed outward, tumbling, gravity pulling them down.
  confetti: { count: 22, shapes: ['strip', 'strip', 'dot'], colors: CONFETTI, size: [5, 8], distance: [46, 92], duration: [620, 980], gravity: 26, spin: [140, 320] },
  // Comic stars radiating with a light fall.
  'star-burst': { count: 12, shapes: ['star', 'cross'], colors: STARS, size: [7, 12], distance: [40, 84], duration: [480, 760], gravity: 10, spin: [90, 240] },
  // Small cross glints: short range, quick fade, no gravity.
  sparkle: { count: 10, shapes: ['cross', 'dot'], colors: SPARKLES, size: [4, 7], distance: [20, 44], duration: [420, 640], gravity: 0, spin: [0, 90] },
  // Hearts rising with a gentle tumble.
  'heart-burst': { count: 12, shapes: ['heart', 'heart', 'dot'], colors: HEARTS, size: [6, 10], distance: [34, 72], duration: [640, 940], gravity: -18, spin: [60, 180] },
  // Sakura petals: slow wide drift, strong fall, lazy spin.
  'petal-fall': { count: 14, shapes: ['petal', 'petal', 'strip'], colors: PETALS, size: [6, 10], distance: [26, 58], duration: [760, 1120], gravity: 32, spin: [150, 340] },
  // A loud radial burst: mixed silhouettes, long reach, hard fall.
  firework: { count: 24, shapes: ['dot', 'strip', 'ring'], colors: FIREWORK, size: [4, 7], distance: [58, 108], duration: [680, 1000], gravity: 42, spin: [100, 300] },
};

export const EFFECT_LABELS: Record<string, string> = {
  confetti: '撒花',
  'star-burst': '星星',
  sparkle: '闪光',
  'heart-burst': '爱心',
  'petal-fall': '落樱',
  firework: '烟花',
};

const STAR_CLIP = 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)';
const CROSS_CLIP = 'polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%)';
const HEART_CLIP =
  'polygon(50% 88%, 38% 79%, 24% 66%, 13% 50%, 10% 34%, 16% 20%, 29% 14%, 41% 18%, 50% 28%, 59% 18%, 71% 14%, 84% 20%, 90% 34%, 87% 50%, 76% 66%, 62% 79%)';

const randomIn = ([min, max]: readonly [number, number]) => min + Math.random() * (max - min);
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
const r2 = (v: number) => Math.round(v * 100) / 100;

/** How many particles one burst spawns, after the amount multiplier and both caps. */
export function burstCount(spec: ParticleEffectSpec, amount: number, live: number): number {
  const want = Math.round(spec.count * Math.max(0, amount));
  return Math.max(0, Math.min(want, MAX_PER_BURST, MAX_LIVE - live));
}

export class ParticleEmitter {
  private readonly live = new Set<{ el: HTMLElement; anim: Animation }>();

  constructor(private readonly layer: HTMLElement) {}

  get liveCount() {
    return this.live.size;
  }

  /** One burst centred on (x, y) in the layer's local px. */
  burst(spec: ParticleEffectSpec, x: number, y: number, amount = 1) {
    const n = burstCount(spec, amount, this.live.size);
    for (let i = 0; i < n; i++) this.spawn(spec, x, y);
  }

  dispose() {
    for (const p of this.live) {
      try {
        p.anim.cancel();
      } catch {
        /* already settled */
      }
      p.el.remove();
    }
    this.live.clear();
  }

  private spawn(spec: ParticleEffectSpec, x: number, y: number) {
    const el = document.createElement('div');
    el.className = 'pw-particle';
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
    shape(el, spec);

    const angle = Math.random() * Math.PI * 2;
    const dist = randomIn(spec.distance);
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const spin = randomIn(spec.spin) * (Math.random() < 0.5 ? -1 : 1);
    const anim = el.animate(
      [
        { transform: 'translate(-50%, -50%) translate(0px, 0px) rotate(0deg)', opacity: 1 },
        { transform: `translate(-50%, -50%) translate(${r2(dx * 0.7)}px, ${r2(dy * 0.7)}px) rotate(${r2(spin * 0.7)}deg)`, opacity: 1, offset: 0.7 },
        { transform: `translate(-50%, -50%) translate(${r2(dx)}px, ${r2(dy + spec.gravity)}px) rotate(${r2(spin)}deg)`, opacity: 0 },
      ],
      { duration: randomIn(spec.duration), easing: 'cubic-bezier(0.15, 0.6, 0.35, 1)', fill: 'forwards' },
    );
    const p = { el, anim };
    this.live.add(p);
    const settle = () => {
      el.remove();
      this.live.delete(p);
    };
    // Settles on finish and on cancel, so an element never lingers.
    anim.finished.then(settle, settle);
    this.layer.appendChild(el);
  }
}

function shape(el: HTMLElement, spec: ParticleEffectSpec) {
  const s = el.style;
  const color = pick(spec.colors);
  const size = randomIn(spec.size);
  const kind = pick(spec.shapes);
  const px = (v: number) => `${Math.round(v)}px`;
  if (kind === 'ring') {
    // Hollow circle: a border instead of a fill.
    s.width = s.height = px(size);
    s.border = `${Math.max(2, Math.round(size * 0.3))}px solid ${color}`;
    s.borderRadius = '50%';
    return;
  }
  s.background = color;
  if (kind === 'strip') {
    s.width = px(size);
    s.height = px(size * 1.9);
    s.borderRadius = '1.5px';
  } else if (kind === 'dot') {
    s.width = s.height = px(size);
    s.borderRadius = '50%';
  } else if (kind === 'petal') {
    s.width = px(size * 0.75);
    s.height = px(size * 1.7);
    s.borderRadius = '50%';
  } else {
    s.width = s.height = px(size);
    s.clipPath = kind === 'star' ? STAR_CLIP : kind === 'heart' ? HEART_CLIP : CROSS_CLIP;
  }
}
