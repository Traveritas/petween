/**
 * client/timeline/pointer-gesture.ts — click-vs-drag recognition for
 * keyframe diamonds and event markers, the same pattern as the overlay's
 * DragController: window-level move/up/cancel listeners while a gesture is
 * active (jsdom drives it with synthetic events), no pointer-capture
 * requirement.
 *
 * Travel below the threshold ends as a click (select); crossing it reports
 * drags with the raw client coordinates — the lane owning the gesture
 * converts them to snapped timeline times.
 *
 * The gesture only self-cleans on move/up/cancel, so the returned cancel
 * handle (idempotent) exists for the owner's unmount path: it removes the
 * window listeners and mutes the gesture mid-press.
 */

export const TIMELINE_DRAG_THRESHOLD_PX = 3

export interface PointerGestureOptions {
  onDrag: (clientX: number, clientY: number) => void
  onClick: () => void
}

/** Loose pointer shape: React synthetic events and jsdom MouseEvents both fit. */
interface PointerLike {
  button?: number
  isPrimary?: boolean
  pointerId?: number
  clientX?: number
  clientY?: number
}

/** Rejected presses never start a gesture; their cancel handle is a no-op. */
const NOOP_CANCEL = (): void => {}

export function beginPointerGesture(event: PointerLike, options: PointerGestureOptions): () => void {
  if (typeof event.button === 'number' && event.button !== 0) return NOOP_CANCEL // main button only
  if (event.isPrimary === false) return NOOP_CANCEL // ignore secondary touch points
  if (typeof event.clientX !== 'number' || typeof event.clientY !== 'number') return NOOP_CANCEL
  const pointerId = typeof event.pointerId === 'number' ? event.pointerId : 0
  const startX = event.clientX
  const startY = event.clientY
  let dragging = false
  let cancelled = false

  const isGestureEvent = (next: PointerLike): boolean => {
    const id = typeof next.pointerId === 'number' ? next.pointerId : 0
    return id === pointerId && typeof next.clientX === 'number' && typeof next.clientY === 'number'
  }
  const cleanup = (): void => {
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleCancel)
  }
  const handleMove = (raw: Event): void => {
    if (cancelled) return
    const next = raw as PointerLike
    if (!isGestureEvent(next)) return
    const dx = (next.clientX as number) - startX
    const dy = (next.clientY as number) - startY
    if (!dragging) {
      if (Math.hypot(dx, dy) < TIMELINE_DRAG_THRESHOLD_PX) return
      dragging = true
    }
    options.onDrag(next.clientX as number, next.clientY as number)
  }
  const handleUp = (raw: Event): void => {
    if (cancelled) return
    if (!isGestureEvent(raw as PointerLike)) return
    const wasDragging = dragging
    cleanup()
    if (!wasDragging) options.onClick()
  }
  const handleCancel = (raw: Event): void => {
    if (cancelled) return
    if (!isGestureEvent(raw as PointerLike)) return
    cleanup()
  }
  window.addEventListener('pointermove', handleMove)
  window.addEventListener('pointerup', handleUp)
  window.addEventListener('pointercancel', handleCancel)
  return () => {
    if (cancelled) return
    cancelled = true
    cleanup()
  }
}
