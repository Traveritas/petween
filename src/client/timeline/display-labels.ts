/**
 * client/timeline/display-labels.ts — Chinese display names for the raw
 * AnimationDefinition identifiers (motion property whitelist + timeline
 * event types). Display layer ONLY: the raw values stay the contract
 * (config fields, dropdown `value`s, JSON view, aria-labels used as stable
 * hooks by the tests); this module just annotates what the user SEES, e.g.
 * 「transition.scaleY（纵向挤压）」 and 「pose-swap（换图）」, so Motion Pack
 * authors can read the format fields without flipping back to
 * docs/motion-format.md. Unknown values fall back to the raw string.
 */
import type { MotionProperty } from '../../motion/motion-properties'

/** Human glosses for every whitelisted motion property (spec §8.2). */
export const MOTION_PROPERTY_LABELS: Record<MotionProperty, string> = {
  'transition.scaleX': '横向伸缩',
  'transition.scaleY': '纵向挤压',
  'transition.x': '水平位移',
  'transition.y': '垂直位移',
  'transition.rotation': '旋转',
  'transition.opacity': '不透明度',
  'sway.rotation': '摇摆旋转',
  'bounce.x': '弹跳水平位移',
  'bounce.y': '弹跳垂直位移',
  'bounce.scaleX': '弹跳横向伸缩',
  'bounce.scaleY': '弹跳纵向挤压',
  'breathe.scaleX': '呼吸横向伸缩',
  'breathe.scaleY': '呼吸纵向挤压',
}

/** 「transition.scaleY（纵向挤压）」; unknown properties pass through raw. */
export function motionPropertyDisplayName(property: string): string {
  const label = MOTION_PROPERTY_LABELS[property as MotionProperty]
  return label === undefined ? property : `${property}（${label}）`
}

/** Human glosses for the timeline event types. */
export const EVENT_TYPE_LABELS = {
  'pose-swap': '换图',
  particle: '粒子',
} as const

/** 「pose-swap（换图）」; unknown types pass through raw. */
export function eventTypeDisplayName(type: string): string {
  const label = EVENT_TYPE_LABELS[type as keyof typeof EVENT_TYPE_LABELS]
  return label === undefined ? type : `${type}（${label}）`
}
