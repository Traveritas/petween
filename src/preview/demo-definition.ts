/**
 * The demo custom AnimationDefinition shown in the standalone preview's
 * "自定义 AnimationDefinition" textarea — the motion-format.md §10 example
 * verbatim ("校验 → 注册 → 播放" must succeed out of the box).
 *
 * Kept in its own module (not the UI entry) so a test can import and verify
 * it against the validator AND the doc without pulling in React: the
 * 2026-08-27 same-layer easing tightening updated the doc example but missed
 * this copy, breaking the preview's headline demo button (2026-08-28 BUG 3).
 */
export const DEMO_CUSTOM_DEFINITION_TEXT = `{
  "version": 1,
  "id": "user:slam-land",
  "name": "Slam Land",
  "kind": "transition",
  "durationMs": 320,
  "repeat": { "mode": "once" },
  "tracks": [
    {
      "property": "transition.scaleX",
      "keyframes": [
        { "at": 0,    "value": 1 },
        { "at": 0.3,  "value": { "base": 1, "parameter": "strength", "amount": 0.22 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 1, "parameter": "strength", "amount": -0.14 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 1, "parameter": "strength", "amount": 0.05 } },
        { "at": 1,    "value": 1 }
      ]
    },
    {
      "property": "transition.scaleY",
      "keyframes": [
        { "at": 0,    "value": 1 },
        { "at": 0.3,  "value": { "base": 1, "parameter": "strength", "amount": -0.24 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 1, "parameter": "strength", "amount": 0.18 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 1, "parameter": "strength", "amount": -0.04 } },
        { "at": 1,    "value": 1 }
      ]
    },
    {
      "property": "transition.y",
      "keyframes": [
        { "at": 0,    "value": 0 },
        { "at": 0.3,  "value": { "base": 0, "parameter": "strength", "amount": 6 }, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 0, "parameter": "strength", "amount": -12 }, "easing": "overshoot" },
        { "at": 0.8,  "value": 0 },
        { "at": 1,    "value": 0 }
      ]
    },
    {
      "property": "transition.rotation",
      "keyframes": [
        { "at": 0,    "value": 0 },
        { "at": 0.3,  "value": 0, "easing": "anticipate" },
        { "at": 0.55, "value": { "base": 0, "parameter": "strength", "amount": -4 }, "easing": "overshoot" },
        { "at": 0.8,  "value": { "base": 0, "parameter": "strength", "amount": 1.5 } },
        { "at": 1,    "value": 0 }
      ]
    }
  ],
  "events": [ { "at": 0.42, "type": "pose-swap" } ],
  "parameters": { "strength": { "default": 1, "min": 0, "max": 1.8 } }
}`
