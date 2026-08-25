/**
 * client/overlay/PetRenderer.tsx — thin React host for PetStage (spec §16.2).
 *
 * The SAME component backs the settings Live Preview and the real shell
 * overlay; only the controller differs (ManualStateSource vs DshStateSource).
 * It owns exactly one thing: the PetStage lifecycle. The stage instance is
 * handed to the parent via onStage so the controller can build a
 * MotionDirector on it.
 *
 * §23 lifecycle contract: unmounting disposes the PetStage (removes the DOM),
 * but that does NOT cancel in-flight WAAPI animations or timers — those are
 * created by the MotionDirector on the stage's layers. The controller that
 * received the stage through onStage MUST dispose its director (it gets
 * onStage(null) first, which is the right moment); otherwise animations keep
 * running on detached elements.
 *
 * Note: onStage must be referentially stable (useCallback) — a new identity
 * recreates the stage and would invalidate the MotionDirector bound to it.
 */
import { useEffect, useRef, type JSX } from 'react'
import { PetStage } from './pet-stage'

export interface PetRendererProps {
  /** Called with the live stage after mount, and with null before dispose. */
  onStage: (stage: PetStage | null) => void
  /** §2.1: no usable image (or disabled pet) → render nothing at all. */
  visible?: boolean
  /**
   * Effective reduced-motion flag. Optional: when undefined the renderer does
   * not touch it and the stage keeps whatever its controller set (the preview
   * session owns the reduced-motion policy there).
   */
  reducedMotion?: boolean
  /** Stage square side in px; omit for the default. */
  size?: number
  showAnchorMarker?: boolean
  /**
   * Construction-time only: embed the stage in a host container (settings
   * Live Preview) instead of the default viewport-fixed overlay mode.
   */
  embedded?: boolean
}

export function PetRenderer(props: PetRendererProps): JSX.Element | null {
  const { onStage, visible = true, reducedMotion, size, showAnchorMarker = false, embedded = false } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<PetStage | null>(null)

  // Create/dispose the PetStage with the component's lifetime and visibility.
  useEffect(() => {
    if (!visible || containerRef.current === null) return undefined
    const stage = new PetStage({ reducedMotion, size, embedded })
    stageRef.current = stage
    containerRef.current.appendChild(stage.element)
    onStage(stage)
    return () => {
      // Controllers detach (and dispose their director) before the DOM goes.
      onStage(null)
      stage.dispose()
      stageRef.current = null
    }
    // reducedMotion/size are pushed into the live stage by the sync effect
    // below; recreating the stage for them would churn the bound director.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, onStage])

  // Sync later prop changes into the live stage (no recreation).
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    if (reducedMotion !== undefined) stage.setReducedMotion(reducedMotion)
    if (size !== undefined) stage.setSize(size)
    stage.setAnchorMarkerVisible(showAnchorMarker)
  }, [reducedMotion, size, showAnchorMarker, visible])

  if (!visible) return null
  return <div ref={containerRef} data-petween-renderer="" />
}
