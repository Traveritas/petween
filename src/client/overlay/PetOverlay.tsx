/**
 * client/overlay/PetOverlay.tsx — the shell.overlay slot entry (M3, spec
 * §5.2). Renders the shared PetRenderer (§16.2: same component as the
 * settings Live Preview) once the config hub is loaded, gated on
 * config.enabled and at least one usable image (§2.1: no image → the overlay
 * renders nothing at all and reserves no space).
 *
 * Pointer-events contract (§2.1): the slot container is click-through; the
 * PetStage root keeps pointer-events:none and only the pet body opts back in
 * (pet-stage.ts), so nothing here sets pointer events.
 *
 * Owns: the hub load/polling lifecycle and the OverlaySession lifecycle
 * through the renderer's onStage contract (dispose BEFORE the DOM goes).
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { configHub as sharedConfigHub, type ConfigHub, type ConfigSnapshot } from '../config-hub'
import { clearActivePetSession, setActivePetSession } from '../extension-service'
import { OverlaySession } from '../overlay-session'
import { hasAnyUsableImage } from '../stores/editor-store'
import { PetRenderer } from './PetRenderer'
import type { PetStage } from './pet-stage'

export interface PetOverlayProps {
  /** Test seam; production always uses the shared singleton hub. */
  hub?: ConfigHub
}

export function PetOverlay(props: PetOverlayProps): JSX.Element | null {
  const hub = props.hub ?? sharedConfigHub
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(() => hub.getCurrent())
  const sessionRef = useRef<OverlaySession | null>(null)

  useEffect(() => {
    let active = true
    if (hub.getCurrent() === null) {
      hub.load().then(
        (loaded) => {
          if (active) setSnapshot(loaded)
        },
        (error: unknown) => {
          console.error('petween: failed to load the config', error)
        },
      )
    }
    hub.startPolling()
    const unsubscribe = hub.subscribe((next) => {
      setSnapshot(next)
    })
    return () => {
      active = false
      unsubscribe()
      hub.stopPolling()
    }
  }, [hub])

  // The session binds to the stage; it must be disposed BEFORE the stage DOM
  // goes (PetRenderer's onStage(null) contract). Each live session is also the
  // extension service's active session — registered on creation, unregistered
  // BEFORE dispose so the service's final null push sees a live snapshot.
  const handleStage = useCallback(
    (stage: PetStage | null) => {
      if (stage === null) {
        const session = sessionRef.current
        sessionRef.current = null
        if (session !== null) {
          clearActivePetSession(session)
          session.dispose()
        }
        return
      }
      const session = new OverlaySession({ stage, hub })
      sessionRef.current = session
      setActivePetSession(session)
      void session.start()
    },
    [hub],
  )

  // Backstop cleanup in case the slot fiber vanishes without a stage detach.
  useEffect(
    () => () => {
      const session = sessionRef.current
      sessionRef.current = null
      if (session !== null) {
        clearActivePetSession(session)
        session.dispose()
      }
    },
    [],
  )

  const visible =
    snapshot !== null && snapshot.config.enabled && hasAnyUsableImage(snapshot.config, snapshot.assets)
  return <PetRenderer onStage={handleStage} visible={visible} />
}
