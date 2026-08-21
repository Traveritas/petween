/**
 * Standalone dev preview entry (spec §2.1 Live Preview, §16.2, §17.6).
 *
 * Runs the FULL stack — PetStage → MotionDirector → Timeline Engine, driven
 * by ManualStateSource through the real PetStateResolver / state machine —
 * without DSH, a host, or imported assets. Pose images are SVG data URIs
 * generated at runtime (preview sample data; the host-side asset rules do
 * not apply here). Built as a self-contained IIFE (preview/preview.js).
 */
import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { createDefaultMotionPetConfig } from '../core/defaults'
import type { AssetMeta, MotionPetConfig, PoseKey, TransitionPreset } from '../core/types'
import { POSE_KEYS } from '../core/types'
import { assertValidAnimationDefinition } from '../motion/animation-definition'
import { ManualStateSource } from '../client/manual-state-source'
import { PetRenderer } from '../client/overlay/PetRenderer'
import type { PetStage } from '../client/overlay/pet-stage'
import { PreviewSession } from '../client/preview-session'

/* ------------------------------------------------------------------ poses */

const PREVIEW_IMAGE_SIZE = 240

interface PreviewPoseSpec {
  color: string
  eyes: 'dot' | 'happy' | 'cross' | 'sleepy'
  mouth: 'smile' | 'flat' | 'open' | 'frown'
  /** Drawn baseline (feet) as a 0..1 fraction of the canvas; also the pose anchor. */
  anchorY: number
  badge?: string
}

/** Distinct face + baseline per state so anchor alignment is visible. */
const PREVIEW_POSE_SPECS: Record<PoseKey, PreviewPoseSpec> = {
  idle: { color: '#7aa2f7', eyes: 'dot', mouth: 'smile', anchorY: 0.96 },
  thinking: { color: '#e0af68', eyes: 'dot', mouth: 'flat', anchorY: 0.9, badge: '?' },
  working: { color: '#9ece6a', eyes: 'dot', mouth: 'open', anchorY: 0.96 },
  waiting: { color: '#9aa5ce', eyes: 'sleepy', mouth: 'flat', anchorY: 0.93 },
  success: { color: '#ffc777', eyes: 'happy', mouth: 'smile', anchorY: 0.88, badge: '★' },
  error: { color: '#f7768e', eyes: 'cross', mouth: 'frown', anchorY: 0.96 },
}

function eyesSvg(spec: PreviewPoseSpec, cx1: number, cx2: number, cy: number): string {
  switch (spec.eyes) {
    case 'dot':
      return `<circle cx="${cx1}" cy="${cy}" r="7" fill="#2a2a3c"/><circle cx="${cx2}" cy="${cy}" r="7" fill="#2a2a3c"/>`
    case 'happy':
      return `<path d="M${cx1 - 8} ${cy} q8 -10 16 0" stroke="#2a2a3c" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M${cx2 - 8} ${cy} q8 -10 16 0" stroke="#2a2a3c" stroke-width="5" fill="none" stroke-linecap="round"/>`
    case 'cross':
      return [cx1, cx2]
        .map(
          (cx) =>
            `<path d="M${cx - 6} ${cy - 6} l12 12 M${cx + 6} ${cy - 6} l-12 12" stroke="#2a2a3c" stroke-width="5" stroke-linecap="round"/>`,
        )
        .join('')
    case 'sleepy':
      return `<path d="M${cx1 - 8} ${cy} h16" stroke="#2a2a3c" stroke-width="5" stroke-linecap="round"/><path d="M${cx2 - 8} ${cy} h16" stroke="#2a2a3c" stroke-width="5" stroke-linecap="round"/>`
  }
}

function mouthSvg(spec: PreviewPoseSpec, cx: number, cy: number): string {
  switch (spec.mouth) {
    case 'smile':
      return `<path d="M${cx - 16} ${cy} q16 14 32 0" stroke="#2a2a3c" stroke-width="5" fill="none" stroke-linecap="round"/>`
    case 'flat':
      return `<path d="M${cx - 12} ${cy + 4} h24" stroke="#2a2a3c" stroke-width="5" stroke-linecap="round"/>`
    case 'open':
      return `<ellipse cx="${cx}" cy="${cy + 6}" rx="9" ry="11" fill="#2a2a3c"/>`
    case 'frown':
      return `<path d="M${cx - 16} ${cy + 10} q16 -14 32 0" stroke="#2a2a3c" stroke-width="5" fill="none" stroke-linecap="round"/>`
  }
}

function poseSvgDataUri(spec: PreviewPoseSpec): string {
  const baseline = Math.round(spec.anchorY * PREVIEW_IMAGE_SIZE)
  const bodyY = baseline - 120
  const badge =
    spec.badge === undefined
      ? ''
      : `<circle cx="182" cy="${bodyY + 16}" r="18" fill="#ffffff" opacity="0.95"/><text x="182" y="${bodyY + 23}" font-size="22" text-anchor="middle" fill="#2a2a3c" font-family="system-ui, sans-serif">${spec.badge}</text>`
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PREVIEW_IMAGE_SIZE}" height="${PREVIEW_IMAGE_SIZE}" viewBox="0 0 ${PREVIEW_IMAGE_SIZE} ${PREVIEW_IMAGE_SIZE}">` +
    `<rect x="58" y="${bodyY}" width="124" height="120" rx="38" fill="${spec.color}"/>` +
    eyesSvg(spec, 100, 140, bodyY + 46) +
    mouthSvg(spec, 120, bodyY + 78) +
    badge +
    `</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

function createPreviewState(): { config: MotionPetConfig; assets: Record<string, AssetMeta> } {
  const config = createDefaultMotionPetConfig()
  const assets: Record<string, AssetMeta> = {}
  for (const key of POSE_KEYS) {
    const spec = PREVIEW_POSE_SPECS[key]
    const id = `preview-${key}`
    config.poses[key].assetId = id
    config.poses[key].anchor = { x: 0.5, y: spec.anchorY }
    assets[id] = {
      id,
      fileName: `${key}.placeholder`,
      // The url carries the actual (inline SVG) image; only url/width/height
      // are consumed by the pose resolver and the stage.
      mimeType: 'image/png',
      width: PREVIEW_IMAGE_SIZE,
      height: PREVIEW_IMAGE_SIZE,
      sizeBytes: 0,
      sha256: `preview-${key}`,
      url: poseSvgDataUri(spec),
    }
  }
  return { config, assets }
}

/* ------------------------------------------------------- custom definition */

/** The docs/motion-format.md §9 example: proof that custom definitions run. */
const DEFAULT_CUSTOM_DEFINITION = `{
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
        { "at": 1,    "value": 0 }
      ]
    },
    {
      "property": "transition.rotation",
      "keyframes": [
        { "at": 0,    "value": 0 },
        { "at": 0.55, "value": { "base": 0, "parameter": "strength", "amount": -4 } },
        { "at": 0.8,  "value": { "base": 0, "parameter": "strength", "amount": 1.5 } },
        { "at": 1,    "value": 0 }
      ]
    }
  ],
  "events": [ { "at": 0.42, "type": "pose-swap" } ],
  "parameters": { "strength": { "default": 1, "min": 0, "max": 1.8 } }
}`

/* ------------------------------------------------------------------- UI --- */

const STATE_BUTTONS: Array<{ label: string; slot: PoseKey; send: (source: ManualStateSource) => void }> = [
  { label: 'Idle', slot: 'idle', send: (source) => source.sendState('idle') },
  { label: 'Thinking', slot: 'thinking', send: (source) => source.sendState('active', 'thinking') },
  { label: 'Working', slot: 'working', send: (source) => source.sendState('active', 'working') },
  { label: 'Waiting', slot: 'waiting', send: (source) => source.sendState('waiting') },
  { label: 'Success', slot: 'success', send: (source) => source.sendState('success') },
  { label: 'Error', slot: 'error', send: (source) => source.sendState('error') },
]

const TRANSITION_PRESETS: readonly TransitionPreset[] = [
  'global',
  'none',
  'soft',
  'comic-pop',
  'jelly',
  'jump',
  'snap',
  'flip',
  'celebrate',
  'deflate',
]

function Slider(props: {
  label: string
  min: number
  max: number
  step: number
  value: number
  unit?: string
  disabled?: boolean
  onChange: (value: number) => void
}): JSX.Element {
  return (
    <label className={props.disabled === true ? 'row slider disabled' : 'row slider'}>
      <span className="label">{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <span className="value">
        {props.value}
        {props.unit ?? ''}
      </span>
    </label>
  )
}

function Toggle(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return (
    <label className="row toggle">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      <span>{props.label}</span>
    </label>
  )
}

function App(): JSX.Element {
  const [{ config, assets}] = useState(createPreviewState)
  const [revision, bumpRevision] = useReducer((n: number) => n + 1, 0)
  void revision // the mutable config is re-read on every render
  const [selected, setSelected] = useState<PoseKey>('idle')
  const [showAnchor, setShowAnchor] = useState(false)
  const [customText, setCustomText] = useState(DEFAULT_CUSTOM_DEFINITION)
  const [customMessage, setCustomMessage] = useState<string | null>(null)
  const sessionRef = useRef<PreviewSession | null>(null)

  const handleStage = useCallback(
    (stage: PetStage | null) => {
      if (stage === null) {
        sessionRef.current?.dispose()
        sessionRef.current = null
        return
      }
      const session = new PreviewSession({ stage, config, assets })
      sessionRef.current = session
      void session.start()
    },
    [config, assets],
  )

  // Backstop cleanup (PetRenderer's onStage(null) normally covers it).
  useEffect(
    () => () => {
      sessionRef.current?.dispose()
      sessionRef.current = null
    },
    [],
  )

  const bump = (): void => bumpRevision()
  const appearance = config.states[selected]
  const inherited = appearance.enter.preset === 'global'
  const globalTransition = config.global.transition
  const ambient = appearance.ambient

  const ambientChanged = (): void => {
    sessionRef.current?.applyAmbientProfile()
    bump()
  }

  const registerAndPlayCustom = (): void => {
    const session = sessionRef.current
    if (session === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(customText)
    } catch (error) {
      setCustomMessage(`JSON parse error: ${(error as Error).message}`)
      return
    }
    try {
      assertValidAnimationDefinition(parsed)
      if (session.registry.get(parsed.id) === undefined) session.registry.register(parsed)
      session.playCustom(parsed.id)
      setCustomMessage(`playing "${parsed.id}" — registered + executed with zero dedicated branches (§36)`)
    } catch (error) {
      setCustomMessage((error as Error).message)
    }
  }

  return (
    <div className="app">
      <aside className="controls">
        <h1>motion-pet preview</h1>

        <section>
          <h2>State (ManualStateSource → StateMachine → MotionDirector)</h2>
          <div className="state-buttons">
            {STATE_BUTTONS.map((button) => (
              <button
                key={button.slot}
                type="button"
                className={selected === button.slot ? 'state active' : 'state'}
                onClick={() => {
                  setSelected(button.slot)
                  const session = sessionRef.current
                  if (session !== null) button.send(session.source)
                }}
              >
                {button.label}
              </button>
            ))}
          </div>
          <div className="row">
            <button type="button" onClick={() => void sessionRef.current?.director.replayEnter()}>
              ▶ Replay Enter
            </button>
            <Toggle label="Anchor marker" checked={showAnchor} onChange={setShowAnchor} />
          </div>
        </section>

        <section>
          <h2>
            Slot: <code>{selected}</code>
          </h2>
          <h3>Enter transition</h3>
          <label className="row">
            <span className="label">Preset</span>
            <select
              value={appearance.enter.preset}
              onChange={(event) => {
                appearance.enter.preset = event.target.value as TransitionPreset
                bump()
              }}
            >
              {TRANSITION_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </label>
          {inherited ? <p className="hint">inherits the global transition below</p> : null}
          <Slider
            label="Strength"
            min={0}
            max={1.8}
            step={0.05}
            value={inherited ? globalTransition.strength : appearance.enter.strength}
            disabled={inherited}
            onChange={(value) => {
              appearance.enter.strength = value
              bump()
            }}
          />
          <Slider
            label="Duration"
            min={80}
            max={650}
            step={10}
            unit="ms"
            value={inherited ? globalTransition.durationMs : appearance.enter.durationMs}
            disabled={inherited}
            onChange={(value) => {
              appearance.enter.durationMs = value
              bump()
            }}
          />

          <h3>Global transition</h3>
          <label className="row">
            <span className="label">Preset</span>
            <select
              value={globalTransition.preset}
              onChange={(event) => {
                globalTransition.preset = event.target.value as Exclude<TransitionPreset, 'global'>
                bump()
              }}
            >
              {TRANSITION_PRESETS.filter((preset) => preset !== 'global').map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Strength"
            min={0}
            max={1.8}
            step={0.05}
            value={globalTransition.strength}
            onChange={(value) => {
              globalTransition.strength = value
              bump()
            }}
          />
          <Slider
            label="Duration"
            min={80}
            max={650}
            step={10}
            unit="ms"
            value={globalTransition.durationMs}
            onChange={(value) => {
              globalTransition.durationMs = value
              bump()
            }}
          />
        </section>

        <section>
          <h2>Ambient (slot: {selected})</h2>
          <Toggle
            label="Bounce"
            checked={ambient.bounce.enabled}
            onChange={(checked) => {
              ambient.bounce.enabled = checked
              ambientChanged()
            }}
          />
          <Slider
            label="Strength"
            min={0}
            max={1.8}
            step={0.05}
            value={ambient.bounce.strength}
            onChange={(value) => {
              ambient.bounce.strength = value
              ambientChanged()
            }}
          />
          <Slider
            label="Min interval"
            min={200}
            max={3000}
            step={50}
            unit="ms"
            value={ambient.bounce.intervalMinMs}
            onChange={(value) => {
              ambient.bounce.intervalMinMs = value
              if (ambient.bounce.intervalMaxMs < value) ambient.bounce.intervalMaxMs = value
              ambientChanged()
            }}
          />
          <Slider
            label="Max interval"
            min={200}
            max={3000}
            step={50}
            unit="ms"
            value={ambient.bounce.intervalMaxMs}
            onChange={(value) => {
              ambient.bounce.intervalMaxMs = Math.max(value, ambient.bounce.intervalMinMs)
              ambientChanged()
            }}
          />
          <Toggle
            label="Sway"
            checked={ambient.sway.enabled}
            onChange={(checked) => {
              ambient.sway.enabled = checked
              ambientChanged()
            }}
          />
          <Slider
            label="Angle"
            min={0}
            max={15}
            step={0.1}
            unit="°"
            value={ambient.sway.angleDeg}
            onChange={(value) => {
              ambient.sway.angleDeg = value
              ambientChanged()
            }}
          />
          <Slider
            label="Period"
            min={800}
            max={8000}
            step={100}
            unit="ms"
            value={ambient.sway.periodMs}
            onChange={(value) => {
              ambient.sway.periodMs = value
              ambientChanged()
            }}
          />
          <Toggle
            label="Breathing"
            checked={ambient.breathe.enabled}
            onChange={(checked) => {
              ambient.breathe.enabled = checked
              ambientChanged()
            }}
          />
          <Slider
            label="Strength"
            min={0}
            max={1}
            step={0.02}
            value={ambient.breathe.strength}
            onChange={(value) => {
              ambient.breathe.strength = value
              ambientChanged()
            }}
          />
          <Slider
            label="Period"
            min={800}
            max={6000}
            step={100}
            unit="ms"
            value={ambient.breathe.periodMs}
            onChange={(value) => {
              ambient.breathe.periodMs = value
              ambientChanged()
            }}
          />
        </section>

        <section>
          <h2>Reduced motion</h2>
          <div className="row">
            {(['system', 'always', 'never'] as const).map((mode) => (
              <label key={mode} className="radio">
                <input
                  type="radio"
                  name="reduced-motion"
                  checked={config.global.reducedMotion === mode}
                  onChange={() => {
                    config.global.reducedMotion = mode
                    sessionRef.current?.applyReducedMotion()
                    bump()
                  }}
                />
                <span>{mode}</span>
              </label>
            ))}
          </div>
        </section>

        <section>
          <h2>Custom AnimationDefinition (§36)</h2>
          <textarea
            className="custom-definition"
            spellCheck={false}
            value={customText}
            onChange={(event) => setCustomText(event.target.value)}
          />
          <div className="row">
            <button type="button" onClick={registerAndPlayCustom}>
              Validate → register → play
            </button>
          </div>
          {customMessage !== null ? <pre className="custom-message">{customMessage}</pre> : null}
        </section>
      </aside>

      <main className="stage-area">
        <div className="stage-box">
          <PetRenderer onStage={handleStage} showAnchorMarker={showAnchor} />
        </div>
        <p className="hint">hidden tab? ambient + transitions pause via visibilitychange (§23)</p>
      </main>
    </div>
  )
}

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(<App />)
}
