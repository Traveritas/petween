/**
 * client/overlay/drag-controller.ts — pointer-gesture recognition for the
 * overlay pet body (spec §27/§28). Pure TS, no React/DOM framework, so jsdom
 * can drive it with synthetic events.
 *
 * Gesture model (§28): pointerdown → (setPointerCapture when available) →
 * pointermove → pointerup. Travel < 4px is a click (the session plays a light
 * pop, no state change); ≥ 4px is a drag. Every coordinate handed out is
 * already viewport-clamped (§27: 32px of the pet always stays visible), so a
 * persisted drag position can never strand the pet off-screen.
 *
 * move/up/cancel are tracked on window while a gesture is active: with real
 * pointer capture the events retarget to the handle and bubble to window;
 * without it (jsdom has no capture) window-level listeners still see them.
 */
import { clampStagePosition } from './pet-stage'

export const DRAG_THRESHOLD_PX = 4

export interface DragPoint {
  x: number
  y: number
}

export interface DragControllerOptions {
  /** The interactive pet body (the stage's pointer-events:auto layer). */
  handle: HTMLElement
  /** Stage square side in px, for the clamp math. */
  stageSize: number
  /** Current top-left viewport position of the stage square. */
  getPosition: () => DragPoint
  /** Dragging: apply the (clamped) position. */
  onMove: (x: number, y: number) => void
  /** Drag ended (or was cancelled) after real travel: persist this position. */
  onDragEnd: (x: number, y: number) => void
  /** Pointer released without crossing the drag threshold. */
  onClick: () => void
  /** Test seam; defaults to the live window size. */
  viewport?: () => { width: number; height: number }
}

export class DragController {
  private readonly options: DragControllerOptions
  private activePointerId: number | null = null
  private startClient: DragPoint = { x: 0, y: 0 }
  private startPosition: DragPoint = { x: 0, y: 0 }
  private last: DragPoint = { x: 0, y: 0 }
  private dragging = false
  private disposed = false

  constructor(options: DragControllerOptions) {
    this.options = options
    options.handle.addEventListener('pointerdown', this.handlePointerDown)
  }

  /** True between crossing the drag threshold and the gesture's end. */
  get isDragging(): boolean {
    return this.dragging
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.options.handle.removeEventListener('pointerdown', this.handlePointerDown)
    this.endGesture(null)
  }

  private clamp(point: DragPoint): DragPoint {
    const viewport = this.options.viewport?.() ?? { width: window.innerWidth, height: window.innerHeight }
    return clampStagePosition(point.x, point.y, this.options.stageSize, viewport.width, viewport.height)
  }

  private readonly handlePointerDown = (event: Event): void => {
    if (this.disposed || this.activePointerId !== null) return
    const pointer = event as Partial<PointerEvent>
    if (typeof pointer.button === 'number' && pointer.button !== 0) return // main button only
    if (pointer.isPrimary === false) return // ignore secondary touch points
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') return
    this.activePointerId = typeof pointer.pointerId === 'number' ? pointer.pointerId : 0
    this.startClient = { x: pointer.clientX, y: pointer.clientY }
    this.startPosition = this.options.getPosition()
    this.last = this.startPosition
    this.dragging = false
    const handle = this.options.handle
    if (typeof pointer.pointerId === 'number' && typeof handle.setPointerCapture === 'function') {
      try {
        handle.setPointerCapture(pointer.pointerId)
      } catch {
        // no active pointer with that id (synthetic events in jsdom)
      }
    }
    window.addEventListener('pointermove', this.handlePointerMove)
    window.addEventListener('pointerup', this.handlePointerUp)
    window.addEventListener('pointercancel', this.handlePointerCancel)
  }

  private readonly handlePointerMove = (event: Event): void => {
    const pointer = event as Partial<PointerEvent>
    if (!this.isGestureEvent(pointer)) return
    const dx = (pointer.clientX as number) - this.startClient.x
    const dy = (pointer.clientY as number) - this.startClient.y
    if (!this.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      this.dragging = true
    }
    this.last = this.clamp({ x: this.startPosition.x + dx, y: this.startPosition.y + dy })
    this.options.onMove(this.last.x, this.last.y)
  }

  private readonly handlePointerUp = (event: Event): void => {
    const pointer = event as Partial<PointerEvent>
    if (!this.isGestureEvent(pointer)) return
    const wasDragging = this.dragging
    this.endGesture(pointer)
    if (wasDragging) this.options.onDragEnd(this.last.x, this.last.y)
    else this.options.onClick()
  }

  private readonly handlePointerCancel = (event: Event): void => {
    const pointer = event as Partial<PointerEvent>
    if (!this.isGestureEvent(pointer)) return
    const wasDragging = this.dragging
    this.endGesture(pointer)
    // The pet visibly moved before the cancel; keep config in sync with it.
    if (wasDragging) this.options.onDragEnd(this.last.x, this.last.y)
  }

  private isGestureEvent(pointer: Partial<PointerEvent>): boolean {
    if (this.activePointerId === null) return false
    if (typeof pointer.clientX !== 'number' || typeof pointer.clientY !== 'number') return false
    const id = typeof pointer.pointerId === 'number' ? pointer.pointerId : 0
    return id === this.activePointerId
  }

  private endGesture(pointer: Partial<PointerEvent> | null): void {
    const handle = this.options.handle
    const pointerId = pointer?.pointerId ?? this.activePointerId
    if (pointerId !== null && typeof handle.releasePointerCapture === 'function') {
      try {
        handle.releasePointerCapture(pointerId)
      } catch {
        // capture was never held (jsdom) — nothing to release
      }
    }
    this.activePointerId = null
    this.dragging = false
    window.removeEventListener('pointermove', this.handlePointerMove)
    window.removeEventListener('pointerup', this.handlePointerUp)
    window.removeEventListener('pointercancel', this.handlePointerCancel)
  }
}
