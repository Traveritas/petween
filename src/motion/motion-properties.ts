/**
 * motion/motion-properties.ts — the Motion Property whitelist (spec §8.2) and
 * the single place that maps logical properties to DOM layers and CSS.
 *
 * Tracks may only write these controlled channels; nothing ever writes a raw
 * CSS `transform`. WAAPI mapping (decided): each layer element is driven via
 * CSS individual transform properties —
 *   scaleX/scaleY → scale: "x y"
 *   x/y           → translate: "Xpx Ypx"
 *   rotation      → rotate: "Ndeg"
 *   opacity       → opacity: "0..1"
 */
export type MotionLayer = 'transition' | 'sway' | 'bounce' | 'breathe'

export const MOTION_LAYERS: readonly MotionLayer[] = ['transition', 'sway', 'bounce', 'breathe']

export type MotionProperty =
  | 'transition.scaleX'
  | 'transition.scaleY'
  | 'transition.x'
  | 'transition.y'
  | 'transition.rotation'
  | 'transition.opacity'
  | 'sway.rotation'
  | 'bounce.x'
  | 'bounce.y'
  | 'bounce.scaleX'
  | 'bounce.scaleY'
  | 'breathe.scaleX'
  | 'breathe.scaleY'

export interface MotionPropertyDescriptor {
  kind: 'scale' | 'px' | 'deg' | 'ratio'
  min?: number
  max?: number
  defaultValue: number
  targetLayer: MotionLayer
}

export const MOTION_PROPERTIES: Record<MotionProperty, MotionPropertyDescriptor> = {
  'transition.scaleX': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'transition' },
  'transition.scaleY': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'transition' },
  'transition.x': { kind: 'px', min: -4096, max: 4096, defaultValue: 0, targetLayer: 'transition' },
  'transition.y': { kind: 'px', min: -4096, max: 4096, defaultValue: 0, targetLayer: 'transition' },
  'transition.rotation': { kind: 'deg', min: -360, max: 360, defaultValue: 0, targetLayer: 'transition' },
  'transition.opacity': { kind: 'ratio', min: 0, max: 1, defaultValue: 1, targetLayer: 'transition' },
  'sway.rotation': { kind: 'deg', min: -360, max: 360, defaultValue: 0, targetLayer: 'sway' },
  'bounce.x': { kind: 'px', min: -4096, max: 4096, defaultValue: 0, targetLayer: 'bounce' },
  'bounce.y': { kind: 'px', min: -4096, max: 4096, defaultValue: 0, targetLayer: 'bounce' },
  'bounce.scaleX': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'bounce' },
  'bounce.scaleY': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'bounce' },
  'breathe.scaleX': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'breathe' },
  'breathe.scaleY': { kind: 'scale', min: 0, max: 10, defaultValue: 1, targetLayer: 'breathe' },
}

export function isMotionProperty(value: unknown): value is MotionProperty {
  return typeof value === 'string' && value in MOTION_PROPERTIES
}

export function motionPropertiesOfLayer(layer: MotionLayer): MotionProperty[] {
  return (Object.keys(MOTION_PROPERTIES) as MotionProperty[]).filter(
    (property) => MOTION_PROPERTIES[property].targetLayer === layer,
  )
}

/** Keep compiled CSS values readable (and diffs stable). */
function fmt(value: number): string {
  return String(Math.round(value * 10000) / 10000)
}

/**
 * Compose one WAAPI keyframe body for a layer from logical property values.
 * Every keyframe carries the full layer state so segments are self-contained
 * and deterministic.
 */
export function composeLayerCss(
  layer: MotionLayer,
  value: (property: MotionProperty) => number,
): Record<string, string> {
  switch (layer) {
    case 'transition':
      return {
        translate: `${fmt(value('transition.x'))}px ${fmt(value('transition.y'))}px`,
        scale: `${fmt(value('transition.scaleX'))} ${fmt(value('transition.scaleY'))}`,
        rotate: `${fmt(value('transition.rotation'))}deg`,
        opacity: fmt(value('transition.opacity')),
      }
    case 'sway':
      return { rotate: `${fmt(value('sway.rotation'))}deg` }
    case 'bounce':
      return {
        translate: `${fmt(value('bounce.x'))}px ${fmt(value('bounce.y'))}px`,
        scale: `${fmt(value('bounce.scaleX'))} ${fmt(value('bounce.scaleY'))}`,
      }
    case 'breathe':
      return { scale: `${fmt(value('breathe.scaleX'))} ${fmt(value('breathe.scaleY'))}` }
  }
}
