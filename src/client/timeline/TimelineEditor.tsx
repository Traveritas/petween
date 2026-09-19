/**
 * client/timeline/TimelineEditor.tsx — the visual timeline editor: toolbar
 * (add-track grouped by layer, add-particle, heal a missing pose-swap) +
 * ruler + event markers + keyframe lanes + inspector. Purely controlled:
 * every edit produces new tracks/events through onChange and nothing is
 * persisted here.
 *
 * V1.1 (P1) mode is the default: a fit-width normalized timeline, single
 * selection, 0.01 grid snapping. The optional `advanced` mode (V1.2, the
 * /petween-animator/ workbench) layers the game-engine feel on top:
 * - P12: interactive playhead with scrub, Ctrl+wheel zoom around the cursor +
 *   wheel panning (sticky track labels), adaptive ms ruler, target snapping
 *   (frames/events/playhead, Alt-hold to bypass).
 * - P13: multi-selection (shift = range within a track, ctrl = toggle, plain
 *   click re-selects single), time-band marquee on empty lanes, batch drag
 *   (the whole selection follows the anchor, collisions drop silently),
 *   Ctrl+D duplicate, Delete/Esc/arrows for the selection, and a context
 *   menu on diamonds / markers / lanes / the ruler / track labels.
 *
 * The selection lives INSIDE the editor as string keys (see timeline-model)
 * with a last-clicked anchor for the inspector; indices shift on every
 * mutation, so the keys are re-derived after each edit. All advanced props
 * are opt-in; the settings-page AnimationLibrary keeps its frozen V1.1 UX.
 *
 * Every change is re-validated against the real schema
 * (validateTimelineDraft — a synthetic known-valid definition around
 * kind/tracks/events). The errors are listed inline AND reported through
 * onValidationChange, so the host panel disables its 保存 button while the
 * list is non-empty.
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
} from 'react'
import { createPortal } from 'react-dom'
import type {
  AnimationKind,
  MotionEasing,
  MotionKeyframe,
  MotionTrack,
  ParticleEffectId,
  TimelineEvent,
} from '../../motion/animation-definition'
import {
  MOTION_LAYERS,
  isMotionProperty,
  motionPropertiesOfLayer,
  type MotionLayer,
  type MotionProperty,
} from '../../motion/motion-properties'
import settingsStyles from '../settings/settings.module.css'
import { motionPropertyDisplayName } from './display-labels'
import { EventInspector, EventTrack, PARTICLE_EFFECT_OPTIONS } from './EventTrack'
import { KeyframeInspector } from './KeyframeInspector'
import { ScrubRuler, TimelineRuler } from './TimelineRuler'
import { TrackLane, type SelectModifiers } from './TrackLane'
import {
  addKeyframe,
  addParticleEvent,
  addPoseSwapEvent,
  addTrack,
  adaptiveGridStep,
  duplicateSelectedKeyframes,
  eventKey,
  keyframeKey,
  moveEvent,
  moveKeyframe,
  moveSelectionBatch,
  parseSelectionKey,
  removeEvent,
  removeKeyframe,
  removeTrack,
  setEventPose,
  setKeyframeEasing,
  setKeyframeValue,
  setParticleEffect,
  snapAtWithTargets,
  validateTimelineDraft,
  type SelectionKey,
} from './timeline-model'
import styles from './timeline.module.css'

export interface TimelineEditorProps {
  kind: AnimationKind
  tracks: MotionTrack[]
  events: TimelineEvent[]
  onChange: (next: { tracks: MotionTrack[]; events: TimelineEvent[] }) => void
  /** Fires with the current validation error list after every change (and on mount). */
  onValidationChange?: (errors: string[]) => void
  /** V1.2 workbench mode: playhead/scrub + zoom/pan + ms ruler + target snap + multi-select. */
  advanced?: boolean
  /** Parked playhead position (normalized); null hides it. */
  playheadAt?: number | null
  onPlayheadChange?: (at: number) => void
  /** Timeline zoom: 1 = the full duration fills the lane width. */
  zoom?: number
  onZoomChange?: (zoom: number) => void
  /** Needed for the ms ruler + adaptive grid; defaults to 300. */
  durationMs?: number
  snapEnabled?: boolean
  onSnapEnabledChange?: (enabled: boolean) => void
  /**
   * V1.2: dock the inspector into this element (the workbench's right rail)
   * instead of rendering inline below the lanes — the saveIndicatorTarget
   * portal pattern. Unset = the V1.1 inline placement.
   */
  inspectorTarget?: HTMLElement | null
}

type LAYER_LABELS_RECORD = Record<MotionLayer, string>

const LAYER_LABELS: LAYER_LABELS_RECORD = {
  transition: '过渡层',
  sway: '摇摆层',
  bounce: '弹跳层',
  breathe: '呼吸层',
}

/** Snap capture radius in px — converted to normalized units per lane width. */
const SNAP_THRESHOLD_PX = 6

type ContextMenuState =
  | { kind: 'keyframe'; trackIndex: number; keyframeIndex: number; x: number; y: number }
  | { kind: 'event'; eventIndex: number; x: number; y: number }
  | { kind: 'lane'; trackIndex: number; at: number; x: number; y: number }
  | { kind: 'ruler'; at: number; x: number; y: number }
  | { kind: 'track'; trackIndex: number; x: number; y: number }

export function TimelineEditor(props: TimelineEditorProps): JSX.Element {
  const { kind, tracks, events } = props
  const advanced = props.advanced === true
  const zoom = props.zoom ?? 1
  const durationMs = props.durationMs ?? 300

  // --- selection (string keys; lastSelected drives the inspector) ---------

  const [selectionKeys, setSelectionKeys] = useState<ReadonlySet<SelectionKey>>(new Set())
  const [lastSelected, setLastSelected] = useState<SelectionKey | null>(null)

  const errors = useMemo(() => validateTimelineDraft(kind, tracks, events), [kind, tracks, events])
  useEffect(() => {
    props.onValidationChange?.(errors)
  }, [props.onValidationChange, errors])

  const poseSwapCount = events.filter((event) => event.type === 'pose-swap').length
  const showEvents = kind !== 'ambient'

  const selectSingle = (key: SelectionKey | null): void => {
    setSelectionKeys(key === null ? new Set() : new Set([key]))
    setLastSelected(key)
  }

  /** Drop selection keys that no longer resolve after an external reshuffle
   *  (kind switches / JSON applies replace the draft wholesale). */
  useEffect(() => {
    setSelectionKeys((current) => {
      if (current.size === 0) return current
      const kept = new Set<SelectionKey>()
      for (const key of current) {
        const parsed = parseSelectionKey(key)
        if (parsed === null) continue
        if (parsed.kind === 'keyframe') {
          if (tracks[parsed.trackIndex]?.keyframes[parsed.keyframeIndex] !== undefined) kept.add(key)
        } else if (events[parsed.eventIndex] !== undefined) {
          kept.add(key)
        }
      }
      if (kept.size === current.size) return current
      setLastSelected((last) => (last !== null && kept.has(last) ? last : [...kept][kept.size - 1] ?? null))
      return kept
    })
  }, [tracks, events])

  const selectKeyframe = (trackIndex: number, keyframeIndex: number, modifiers?: SelectModifiers): void => {
    const key = keyframeKey(trackIndex, keyframeIndex)
    if (!advanced || modifiers === undefined || (!modifiers.shift && !modifiers.toggle)) {
      selectSingle(key)
      return
    }
    if (modifiers.toggle) {
      setSelectionKeys((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setLastSelected(key)
        return next
      })
      return
    }
    // shift = range within the clicked track, from the last keyframe selection
    setSelectionKeys((current) => {
      const next = new Set<SelectionKey>(current)
      const track = tracks[trackIndex]
      if (track !== undefined) {
        let fromAt = track.keyframes[keyframeIndex]?.at ?? 0
        const anchorParsed = lastSelected === null ? null : parseSelectionKey(lastSelected)
        if (anchorParsed !== null && anchorParsed.kind === 'keyframe') {
          fromAt = tracks[anchorParsed.trackIndex]?.keyframes[anchorParsed.keyframeIndex]?.at ?? fromAt
        }
        const toAt = track.keyframes[keyframeIndex]?.at ?? fromAt
        const [lo, hi] = fromAt <= toAt ? [fromAt, toAt] : [toAt, fromAt]
        track.keyframes.forEach((keyframe, index) => {
          if (keyframe.at >= lo && keyframe.at <= hi) next.add(keyframeKey(trackIndex, index))
        })
      }
      setLastSelected(key)
      return next
    })
  }

  const selectEventIndex = (eventIndex: number, modifiers?: { shift: boolean; toggle: boolean }): void => {
    const key = eventKey(eventIndex)
    if (!advanced || modifiers === undefined || !modifiers.toggle) {
      selectSingle(key)
      return
    }
    setSelectionKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      setLastSelected(key)
      return next
    })
  }

  // --- advanced mode plumbing: measured lane width + Alt bypass ----------

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [laneWidthPx, setLaneWidthPx] = useState(0)
  const [altHeld, setAltHeld] = useState(false)
  /** Zoom anchor: keep the timeline time under the cursor stationary. */
  const zoomAnchorRef = useRef<{ clientX: number; anchorAt: number } | null>(null)
  const [marquee, setMarquee] = useState<{ from: number; to: number } | null>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  useEffect(() => {
    if (!advanced) return
    const trackAlt = (down: boolean) => (event: KeyboardEvent): void => {
      if (event.key === 'Alt') {
        event.preventDefault()
        setAltHeld(down)
      }
    }
    const onKeyDown = trackAlt(true)
    const onKeyUp = trackAlt(false)
    const onBlur = (): void => setAltHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [advanced])

  useEffect(() => {
    if (!advanced) return
    const element = contentRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      setLaneWidthPx(element.getBoundingClientRect().width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [advanced])

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current
    if (anchor === null) return
    zoomAnchorRef.current = null
    const scrollEl = scrollRef.current
    const content = contentRef.current
    if (scrollEl === null || content === null) return
    const rect = content.getBoundingClientRect()
    const localX = anchor.clientX - scrollEl.getBoundingClientRect().left
    scrollEl.scrollLeft = Math.max(0, anchor.anchorAt * rect.width - localX)
  }, [zoom])

  useEffect(() => {
    if (!advanced) return
    const scrollEl = scrollRef.current
    if (scrollEl === null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) {
        // Ctrl+wheel zooms around the cursor.
        event.preventDefault()
        const content = contentRef.current
        if (content === null || props.onZoomChange === undefined) return
        const rect = content.getBoundingClientRect()
        zoomAnchorRef.current = {
          clientX: event.clientX,
          anchorAt: (event.clientX - rect.left) / Math.max(rect.width, 1),
        }
        props.onZoomChange(zoom * Math.exp(-event.deltaY * 0.002))
        return
      }
      // Wheel/trackpad pans the timeline horizontally (engine convention).
      if (scrollEl.scrollWidth > scrollEl.clientWidth) event.preventDefault()
      scrollEl.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX
    }
    scrollEl.addEventListener('wheel', onWheel, { passive: false })
    return () => scrollEl.removeEventListener('wheel', onWheel)
  }, [advanced, zoom, props.onZoomChange])

  // Close the context menu on any outside press / Escape.
  useEffect(() => {
    if (menu === null) return
    const close = (): void => setMenu(null)
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const frameEventTargets = useMemo(() => {
    if (!advanced) return []
    const targets: number[] = []
    for (const track of tracks) {
      for (const keyframe of track.keyframes) targets.push(keyframe.at)
    }
    for (const event of events) targets.push(event.at)
    return targets
  }, [advanced, tracks, events])

  const grid = useMemo(
    () => adaptiveGridStep(durationMs, laneWidthPx > 0 ? laneWidthPx : 800, zoom).grid,
    [durationMs, laneWidthPx, zoom],
  )

  /** Frame/event drags snap to grid + siblings + the playhead. */
  const snapEdit = useMemo(() => {
    if (!advanced) return null
    const enabled = (props.snapEnabled ?? true) && !altHeld
    const threshold = SNAP_THRESHOLD_PX / Math.max(laneWidthPx, 1)
    const targets = props.playheadAt != null ? [...frameEventTargets, props.playheadAt] : frameEventTargets
    return (at: number): number => snapAtWithTargets(at, { enabled, grid, targets, threshold })
  }, [advanced, props.snapEnabled, props.playheadAt, altHeld, grid, frameEventTargets, laneWidthPx])

  /** Playhead scrubbing snaps to grid + frames/events — never to itself. */
  const snapScrub = useMemo(() => {
    if (!advanced) return null
    const enabled = (props.snapEnabled ?? true) && !altHeld
    const threshold = SNAP_THRESHOLD_PX / Math.max(laneWidthPx, 1)
    return (at: number): number => snapAtWithTargets(at, { enabled, grid, targets: frameEventTargets, threshold })
  }, [advanced, props.snapEnabled, altHeld, grid, frameEventTargets, laneWidthPx])

  const handleScrub = (at: number): void => {
    props.onPlayheadChange?.(snapScrub !== null ? snapScrub(at) : at)
  }

  // --- track-level ops -----------------------------------------------------

  const updateTracks = (nextTracks: MotionTrack[]): void => {
    props.onChange({ tracks: nextTracks, events })
  }
  const updateEvents = (nextEvents: TimelineEvent[]): void => {
    props.onChange({ tracks, events: nextEvents })
  }
  const updateBoth = (next: { tracks: MotionTrack[]; events: TimelineEvent[] }): void => {
    props.onChange(next)
  }

  const replaceTrack = (trackIndex: number, track: MotionTrack): void =>
    updateTracks(tracks.map((current, index) => (index === trackIndex ? track : current)))

  /** Re-key a track's keyframe selection after an index shift at `removedIndex`. */
  const shiftKeyframeSelection = (trackIndex: number, removedIndex: number): void => {
    setSelectionKeys((current) => {
      const next = new Set<SelectionKey>()
      for (const key of current) {
        const parsed = parseSelectionKey(key)
        if (parsed === null || parsed.kind !== 'keyframe' || parsed.trackIndex !== trackIndex) {
          next.add(key)
          continue
        }
        if (parsed.keyframeIndex === removedIndex) continue // the deleted frame itself
        next.add(
          keyframeKey(
            trackIndex,
            parsed.keyframeIndex > removedIndex ? parsed.keyframeIndex - 1 : parsed.keyframeIndex,
          ),
        )
      }
      return next
    })
    setLastSelected((last) => {
      const parsed = last === null ? null : parseSelectionKey(last)
      if (parsed === null || parsed.kind !== 'keyframe' || parsed.trackIndex !== trackIndex) return last
      if (parsed.keyframeIndex === removedIndex) return null
      return keyframeKey(trackIndex, parsed.keyframeIndex > removedIndex ? parsed.keyframeIndex - 1 : parsed.keyframeIndex)
    })
  }

  const handleAddTrack = (property: MotionProperty): void => {
    const edit = addTrack(tracks, property)
    updateTracks(edit.tracks)
    selectSingle(keyframeKey(edit.index, 0))
  }

  const handleRemoveTrack = (trackIndex: number): void => {
    updateTracks(removeTrack(tracks, trackIndex))
    // Re-key: that track's selection dies; later tracks shift down.
    setSelectionKeys((current) => {
      const next = new Set<SelectionKey>()
      for (const key of current) {
        const parsed = parseSelectionKey(key)
        if (parsed === null || parsed.kind !== 'keyframe') {
          next.add(key)
          continue
        }
        if (parsed.trackIndex === trackIndex) continue
        next.add(keyframeKey(parsed.trackIndex > trackIndex ? parsed.trackIndex - 1 : parsed.trackIndex, parsed.keyframeIndex))
      }
      return next
    })
    setLastSelected((last) => {
      const parsed = last === null ? null : parseSelectionKey(last)
      if (parsed === null || parsed.kind !== 'keyframe') return last
      if (parsed.trackIndex === trackIndex) return null
      return keyframeKey(parsed.trackIndex > trackIndex ? parsed.trackIndex - 1 : parsed.trackIndex, parsed.keyframeIndex)
    })
    setMenu(null)
  }

  // --- keyframe ops --------------------------------------------------------

  const handleAddKeyframe = (trackIndex: number, at: number): void => {
    const edit = addKeyframe(tracks[trackIndex], at)
    if (edit.created) replaceTrack(trackIndex, edit.track)
    selectSingle(keyframeKey(trackIndex, edit.index))
  }

  const handleMoveKeyframe = (trackIndex: number, keyframeIndex: number, at: number): void => {
    // P13 batch drag: an anchor inside a multi-selection carries the group.
    if (
      advanced &&
      selectionKeys.size > 1 &&
      selectionKeys.has(keyframeKey(trackIndex, keyframeIndex))
    ) {
      const anchorAt = tracks[trackIndex]?.keyframes[keyframeIndex]?.at
      if (anchorAt === undefined) return
      const target = snapEdit !== null ? snapEdit(at) : at
      const delta = target - anchorAt
      if (delta === 0) return
      updateBoth(moveSelectionBatch(tracks, events, selectionKeys, delta))
      return
    }
    const edit = moveKeyframe(tracks[trackIndex], keyframeIndex, at)
    if (edit.moved) replaceTrack(trackIndex, edit.track)
  }

  const handleSetValue = (trackIndex: number, keyframeIndex: number, value: MotionKeyframe['value']): void => {
    replaceTrack(trackIndex, setKeyframeValue(tracks[trackIndex], keyframeIndex, value))
  }

  const handleSetEasing = (trackIndex: number, keyframeIndex: number, easing: MotionEasing | undefined): void => {
    updateTracks(setKeyframeEasing(tracks, trackIndex, keyframeIndex, easing))
  }

  const handleDeleteKeyframe = (trackIndex: number, keyframeIndex: number): void => {
    replaceTrack(trackIndex, removeKeyframe(tracks[trackIndex], keyframeIndex))
    shiftKeyframeSelection(trackIndex, keyframeIndex)
  }

  /** P13: delete every selected keyframe/event (descending so indices hold). */
  const handleDeleteSelection = (): void => {
    if (selectionKeys.size === 0) return
    let nextTracks = tracks
    let nextEvents = events
    const keyframeDeletes = new Map<number, number[]>()
    const eventDeletes: number[] = []
    for (const key of selectionKeys) {
      const parsed = parseSelectionKey(key)
      if (parsed === null) continue
      if (parsed.kind === 'keyframe') {
        const list = keyframeDeletes.get(parsed.trackIndex) ?? []
        list.push(parsed.keyframeIndex)
        keyframeDeletes.set(parsed.trackIndex, list)
      } else {
        eventDeletes.push(parsed.eventIndex)
      }
    }
    // Schema guard: a lone transition pose-swap is never deletable.
    const protectedEvents =
      kind === 'transition'
        ? nextEvents.filter((event) => event.type === 'pose-swap').length <= 1
          ? nextEvents.findIndex((event) => event.type === 'pose-swap')
          : -1
        : -1
    for (const [trackIndex, indices] of keyframeDeletes) {
      for (const index of indices.sort((a, b) => b - a)) {
        const track = nextTracks[trackIndex]
        if (track !== undefined && track.keyframes.length > 1) {
          nextTracks = nextTracks.map((current, i) => (i === trackIndex ? removeKeyframe(current, index) : current))
        }
      }
    }
    for (const index of eventDeletes.sort((a, b) => b - a)) {
      if (index === protectedEvents) continue
      const deletable = nextEvents[index] !== undefined && (kind !== 'transition' || nextEvents.filter((e) => e.type === 'pose-swap').length > 1 || nextEvents[index].type !== 'pose-swap')
      if (deletable) nextEvents = removeEvent(nextEvents, index)
    }
    updateBoth({ tracks: nextTracks, events: nextEvents })
    selectSingle(null)
  }

  /** P13: duplicate the selected keyframes at +0.05; the copies get selected. */
  const handleDuplicateSelection = (): void => {
    if (selectionKeys.size === 0) return
    const edit = duplicateSelectedKeyframes(tracks, selectionKeys)
    updateBoth({ tracks: edit.tracks, events })
    if (edit.selection.length > 0) {
      setSelectionKeys(new Set(edit.selection))
      setLastSelected(edit.selection[edit.selection.length - 1] ?? null)
    }
  }

  // --- event ops -----------------------------------------------------------

  /** Re-key the event selection after a deletion at `removedIndex`. */
  const shiftEventSelection = (removedIndex: number): void => {
    setSelectionKeys((current) => {
      const next = new Set<SelectionKey>()
      for (const key of current) {
        const parsed = parseSelectionKey(key)
        if (parsed === null || parsed.kind !== 'event') {
          next.add(key)
          continue
        }
        if (parsed.eventIndex === removedIndex) continue
        next.add(eventKey(parsed.eventIndex > removedIndex ? parsed.eventIndex - 1 : parsed.eventIndex))
      }
      return next
    })
    setLastSelected((last) => {
      const parsed = last === null ? null : parseSelectionKey(last)
      if (parsed === null || parsed.kind !== 'event') return last
      if (parsed.eventIndex === removedIndex) return null
      return eventKey(parsed.eventIndex > removedIndex ? parsed.eventIndex - 1 : parsed.eventIndex)
    })
  }

  const handleDeleteEvent = (eventIndex: number): void => {
    updateEvents(removeEvent(events, eventIndex))
    shiftEventSelection(eventIndex)
  }

  const handleMoveEvent = (eventIndex: number, at: number): void => {
    if (
      advanced &&
      selectionKeys.size > 1 &&
      selectionKeys.has(eventKey(eventIndex))
    ) {
      const anchorAt = events[eventIndex]?.at
      if (anchorAt === undefined) return
      const target = snapEdit !== null ? snapEdit(at) : at
      const delta = target - anchorAt
      if (delta === 0) return
      updateBoth(moveSelectionBatch(tracks, events, selectionKeys, delta))
      return
    }
    updateEvents(moveEvent(events, eventIndex, at))
  }

  const handleAddParticle = (effect: ParticleEffectId): void => {
    const edit = addParticleEvent(events, effect)
    updateEvents(edit.events)
    selectSingle(eventKey(edit.index))
  }

  const handleAddPoseSwap = (): void => {
    // Interaction additions name the idle slot so the draft stays valid
    // (every interaction pose-swap must declare a target); the author
    // retargets in the inspector. A transition addition stays anonymous —
    // its pose is state-machine-owned (schema forbids the field).
    const edit = addPoseSwapEvent(events, 0.5, kind === 'interaction' ? 'idle' : undefined)
    updateEvents(edit.events)
    selectSingle(eventKey(edit.index))
  }

  // --- marquee + selection keyboard ----------------------------------------

  const handleMarquee = (phase: 'start' | 'move' | 'end', fromAt: number, toAt: number, shift: boolean): void => {
    if (phase === 'move') {
      setMarquee({ from: Math.min(fromAt, toAt), to: Math.max(fromAt, toAt) })
      return
    }
    // end: commit the last band across ALL tracks (time-slice selection).
    const band = marquee ?? { from: Math.min(fromAt, toAt), to: Math.max(fromAt, toAt) }
    const picked = new Set<SelectionKey>()
    tracks.forEach((track, trackIndex) => {
      track.keyframes.forEach((keyframe, keyframeIndex) => {
        if (keyframe.at >= band.from && keyframe.at <= band.to) picked.add(keyframeKey(trackIndex, keyframeIndex))
      })
    })
    events.forEach((event, eventIndex) => {
      if (event.at >= band.from && event.at <= band.to) picked.add(eventKey(eventIndex))
    })
    setMarquee(null)
    setSelectionKeys((current) => (shift ? new Set([...current, ...picked]) : picked))
    setLastSelected([...picked][picked.size - 1] ?? null)
  }

  useEffect(() => {
    if (!advanced) return
    const isEditableTarget = (target: EventTarget | null): boolean => {
      const el = target
      return (
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
      )
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target)) return
      const onButton = event.target instanceof HTMLElement && event.target.tagName === 'BUTTON'
      if (event.key === 'Escape') {
        setMenu(null)
        if (!onButton) selectSingle(null)
        return
      }
      if (selectionKeys.size === 0) return
      if ((event.key === 'Delete' || event.key === 'Backspace') && !onButton) {
        event.preventDefault()
        handleDeleteSelection()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyD') {
        event.preventDefault()
        handleDuplicateSelection()
        return
      }
      if (!onButton && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        const step = (event.shiftKey ? 0.1 : 0.01) * (event.key === 'ArrowLeft' ? -1 : 1)
        updateBoth(moveSelectionBatch(tracks, events, selectionKeys, step))
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  // --- toolbar selects -----------------------------------------------------

  const handleTrackSelect = (event: ChangeEvent<HTMLSelectElement>): void => {
    const property = event.target.value
    if (isMotionProperty(property)) handleAddTrack(property)
  }

  const handleParticleSelect = (event: ChangeEvent<HTMLSelectElement>): void => {
    const effect = event.target.value
    if (PARTICLE_EFFECT_OPTIONS.some((option) => option.value === effect)) {
      handleAddParticle(effect as ParticleEffectId)
    }
  }

  // --- inspector target ----------------------------------------------------

  const lastParsed = lastSelected === null ? null : parseSelectionKey(lastSelected)
  const keyframeSelection =
    lastParsed !== null && lastParsed.kind === 'keyframe'
      ? tracks[lastParsed.trackIndex]?.keyframes[lastParsed.keyframeIndex] !== undefined
        ? lastParsed
        : null
      : null
  const eventSelection =
    lastParsed !== null && lastParsed.kind === 'event' && events[lastParsed.eventIndex] !== undefined
      ? lastParsed
      : null
  const selectedTrack = keyframeSelection === null ? undefined : tracks[keyframeSelection.trackIndex]
  const selectedEvent = eventSelection === null ? undefined : events[eventSelection.eventIndex]

  let inspector: JSX.Element
  if (keyframeSelection !== null && selectedTrack !== undefined) {
    inspector = (
      <KeyframeInspector
        track={selectedTrack}
        keyframeIndex={keyframeSelection.keyframeIndex}
        onSetAt={(keyframeIndex, at) => handleMoveKeyframe(keyframeSelection.trackIndex, keyframeIndex, at)}
        onSetValue={(keyframeIndex, value) => handleSetValue(keyframeSelection.trackIndex, keyframeIndex, value)}
        onSetEasing={(keyframeIndex, easing) => handleSetEasing(keyframeSelection.trackIndex, keyframeIndex, easing)}
        onDelete={(keyframeIndex) => handleDeleteKeyframe(keyframeSelection.trackIndex, keyframeIndex)}
      />
    )
  } else if (eventSelection !== null && selectedEvent !== undefined) {
    inspector = (
      <EventInspector
        kind={kind}
        event={selectedEvent}
        poseSwapCount={poseSwapCount}
        onSetAt={(at) => handleMoveEvent(eventSelection.eventIndex, at)}
        onSetEffect={(effect) => updateEvents(setParticleEffect(events, eventSelection.eventIndex, effect))}
        onSetPose={(pose) => updateEvents(setEventPose(events, eventSelection.eventIndex, pose))}
        onDelete={() => handleDeleteEvent(eventSelection.eventIndex)}
      />
    )
  } else {
    inspector = <p className={styles.hint}>选中关键帧或事件标记进行编辑；同层轨道的缓动按区间自动保持一致。</p>
  }
  // Docked placement (the workbench's right rail): portal through, keeping
  // the rail's slot stably mounted across selection changes.
  const inspectorNode =
    props.inspectorTarget != null ? createPortal(inspector, props.inspectorTarget) : inspector

  const playhead = advanced ? (props.playheadAt ?? null) : null

  const trackSelectedIndices = (trackIndex: number): ReadonlySet<number> => {
    const indices = new Set<number>()
    for (const key of selectionKeys) {
      const parsed = parseSelectionKey(key)
      if (parsed !== null && parsed.kind === 'keyframe' && parsed.trackIndex === trackIndex) {
        indices.add(parsed.keyframeIndex)
      }
    }
    return indices
  }

  const eventSelectedIndices = (): ReadonlySet<number> => {
    const indices = new Set<number>()
    for (const key of selectionKeys) {
      const parsed = parseSelectionKey(key)
      if (parsed !== null && parsed.kind === 'event') indices.add(parsed.eventIndex)
    }
    return indices
  }

  const openMenu = (
    target:
      | { kind: 'keyframe'; trackIndex: number; keyframeIndex: number }
      | { kind: 'event'; eventIndex: number }
      | { kind: 'lane'; at: number }
      | { kind: 'track' },
    trackIndex: number,
    x: number,
    y: number,
  ): void => {
    if (!advanced) return
    if (target.kind === 'keyframe') {
      selectSingle(keyframeKey(target.trackIndex, target.keyframeIndex))
      setMenu({ ...target, x, y })
    } else if (target.kind === 'event') {
      selectSingle(eventKey(target.eventIndex))
      setMenu({ ...target, x, y })
    } else if (target.kind === 'lane') {
      setMenu({ kind: 'lane', trackIndex, at: target.at, x, y })
    } else {
      setMenu({ kind: 'track', trackIndex, x, y })
    }
  }

  return (
    <div className={styles.timeline} aria-label="时间轴编辑器">
      <div className={styles.timelineToolbar}>
        <select
          className={settingsStyles.select}
          aria-label="添加轨道"
          value=""
          onChange={handleTrackSelect}
        >
          <option value="" disabled>
            ＋ 添加轨道…
          </option>
          {MOTION_LAYERS.map((layer) => {
            const available = motionPropertiesOfLayer(layer).filter(
              (property) => !tracks.some((track) => track.property === property),
            )
            if (available.length === 0) return null
            return (
              <optgroup key={layer} label={LAYER_LABELS[layer]}>
                {available.map((property) => (
                  <option key={property} value={property}>
                    {motionPropertyDisplayName(property)}
                  </option>
                ))}
              </optgroup>
            )
          })}
        </select>
        {showEvents ? (
          <select
            className={settingsStyles.select}
            aria-label="添加粒子事件"
            value=""
            onChange={handleParticleSelect}
          >
            <option value="" disabled>
              ＋ 粒子事件…
            </option>
            {PARTICLE_EFFECT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : null}
        {(kind === 'transition' && poseSwapCount === 0) || kind === 'interaction' ? (
          <button type="button" className={settingsStyles.button} onClick={handleAddPoseSwap}>
            ＋ 添加 pose-swap（换图）
          </button>
        ) : null}
        {advanced ? (
          <>
            <button
              type="button"
              className={
                (props.snapEnabled ?? true)
                  ? `${settingsStyles.button} ${styles.toolbarToggleOn}`
                  : settingsStyles.button
              }
              aria-pressed={props.snapEnabled ?? true}
              data-tooltip="吸附到网格、其他关键帧/事件与播放头；按住 Alt 临时禁用。"
              onClick={() => props.onSnapEnabledChange?.(!(props.snapEnabled ?? true))}
            >
              ⌗ 吸附
            </button>
            <button
              type="button"
              className={settingsStyles.button}
              disabled={zoom === 1}
              data-tooltip="缩放复位（Ctrl+滚轮以光标为中心缩放，滚轮平移）。"
              onClick={() => props.onZoomChange?.(1)}
            >
              ⤢ {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className={helpOpen ? `${settingsStyles.button} ${styles.toolbarToggleOn}` : settingsStyles.button}
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((open) => !open)}
            >
              ? 快捷键
            </button>
          </>
        ) : null}
        <span className={styles.timelineHint}>
          {advanced
            ? '拖标尺移动播放头（预览实时定格）；Ctrl+滚轮缩放、滚轮平移；拖空白框选，Shift/Ctrl 多选，拖动所选批量移动。'
            : '单击轨道空白添加关键帧；拖动或选中菱形/事件标记后用 ←→ 微调、Delete 删除；同层轨道共享缓动'}
        </span>
      </div>
      {advanced && helpOpen ? (
        <div className={styles.helpCard} aria-label="快捷键速查">
          <b>播放头</b>：拖标尺 / 点击标尺定位；←→ 步进（Shift ×10）；空格 试播/停止
          <br />
          <b>缩放平移</b>：Ctrl+滚轮 以光标缩放；滚轮 / Shift+滚轮 平移；工具条复位
          <br />
          <b>选择</b>：Shift 点选 同轨区间；Ctrl 点选 增减；空白拖动 框选时间段（跨全部轨道）；Esc 清空
          <br />
          <b>编辑</b>：拖动所选 批量移动；Ctrl+D 复制所选帧（+0.05）；Delete 删除所选；←→ 微调所选
          <br />
          <b>吸附</b>：网格/其他帧/事件/播放头自动吸附；Alt 临时禁用
        </div>
      ) : null}
      <div className={styles.timelineLanes}>
        <div ref={scrollRef} className={styles.timelineScroll}>
          <div
            ref={contentRef}
            className={styles.timelineContent}
            style={zoom !== 1 ? { width: `${zoom * 100}%` } : undefined}
          >
            <div className={styles.timelineRow}>
              <div className={styles.trackLabel} aria-hidden="true" />
              {advanced ? (
                <ScrubRuler
                  durationMs={durationMs}
                  laneWidthPx={laneWidthPx}
                  zoom={zoom}
                  playheadAt={playhead}
                  onScrub={handleScrub}
                  onContextMenu={
                    menu === null
                      ? (at, x, y) => setMenu({ kind: 'ruler', at, x, y })
                      : undefined
                  }
                />
              ) : (
                <TimelineRuler />
              )}
            </div>
            {tracks.map((track, trackIndex) => (
              <TrackLane
                key={track.property}
                track={track}
                trackIndex={trackIndex}
                selectedKeyframeIndices={trackSelectedIndices(trackIndex)}
                onSelectKeyframe={(keyframeIndex, modifiers) => selectKeyframe(trackIndex, keyframeIndex, modifiers)}
                onAddKeyframe={(at) => handleAddKeyframe(trackIndex, at)}
                onMoveKeyframe={(keyframeIndex, at) => handleMoveKeyframe(trackIndex, keyframeIndex, at)}
                onRemoveKeyframe={(keyframeIndex) => handleDeleteKeyframe(trackIndex, keyframeIndex)}
                onRemoveTrack={() => handleRemoveTrack(trackIndex)}
                snapAt={snapEdit ?? undefined}
                onMarquee={advanced ? handleMarquee : undefined}
                onContextMenu={
                  advanced
                    ? (target, x, y) => openMenu(target, trackIndex, x, y)
                    : undefined
                }
              />
            ))}
            {showEvents ? (
              <EventTrack
                kind={kind}
                poseSwapCount={poseSwapCount}
                events={events}
                selectedIndices={eventSelectedIndices()}
                onSelectEvent={selectEventIndex}
                onMoveEvent={handleMoveEvent}
                onDeleteEvent={handleDeleteEvent}
                snapAt={snapEdit ?? undefined}
                onContextMenu={
                  advanced
                    ? (eventIndex, x, y) => openMenu({ kind: 'event', eventIndex }, -1, x, y)
                    : undefined
                }
              />
            ) : null}
            {playhead !== null ? (
              <div className={styles.playhead} style={{ left: `${playhead * 100}%` }} aria-hidden="true">
                <span className={styles.playheadHead} />
              </div>
            ) : null}
            {marquee !== null ? (
              <div
                className={styles.marqueeBand}
                style={{ left: `${marquee.from * 100}%`, width: `${(marquee.to - marquee.from) * 100}%` }}
                aria-hidden="true"
              />
            ) : null}
          </div>
        </div>
      </div>
      {inspectorNode}
      {errors.length > 0 ? (
        <ul className={settingsStyles.animationErrors} aria-label="时间轴校验错误">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {menu !== null ? (
        <div className={styles.contextMenu} style={{ left: menu.x, top: menu.y }} role="menu" aria-label="时间轴菜单">
          {menu.kind === 'keyframe' ? (
            <>
              <button type="button" role="menuitem" onClick={() => { handleDuplicateSelection(); setMenu(null) }}>
                复制关键帧（Ctrl+D）
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handleDeleteKeyframe(menu.kind === 'keyframe' ? menu.trackIndex : 0, menu.kind === 'keyframe' ? menu.keyframeIndex : 0)
                  setMenu(null)
                }}
              >
                删除关键帧
              </button>
            </>
          ) : menu.kind === 'event' ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (menu.kind === 'event') handleDeleteEvent(menu.eventIndex)
                setMenu(null)
              }}
            >
              删除事件
            </button>
          ) : menu.kind === 'lane' ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (menu.kind === 'lane') handleAddKeyframe(menu.trackIndex, menu.at)
                setMenu(null)
              }}
            >
              在此添加关键帧
            </button>
          ) : menu.kind === 'ruler' ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (menu.kind === 'ruler') handleScrub(menu.at)
                setMenu(null)
              }}
            >
              播放头移到这里
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                if (menu.kind === 'track') handleRemoveTrack(menu.trackIndex)
              }}
            >
              删除轨道
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
