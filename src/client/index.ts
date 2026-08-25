/**
 * petween browser half — the settings.section slot carries the compact
 * PetweenCard entry card (the full editor lives on the standalone
 * /petween-editor/ page); 'shell.overlay' carries the real pet surface
 * (spec §5.2). M4 additionally bridges the DSH current-session selection
 * (`ctx.sessions.list`) into the overlay's DshStateSource. Both surfaces
 * share one config through the config hub and one renderer (PetRenderer,
 * §16.2).
 *
 * The plugin also PROVIDES 'petween/client' — the extension service other
 * DSH plugins may inject (snapshots, position control, animation playback).
 * The service itself lives cordis-free in extension-service.ts; this file is
 * the only place that touches ctx.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merges so the slot names type-check.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installCurrentSessionSource } from '../integration/dsh/dsh-state-source'
import { petweenClientService } from './extension-service'
import { PetOverlay } from './overlay/PetOverlay'
import { PetweenCard } from './settings/PetweenCard'

export const inject = ['slots', 'sessions']

/** Cordis metadata: the service name this plugin provides. */
export const provide = ['petween/client']

export function apply(ctx: ClientContext) {
  // M4: the overlay follows the user's current session (spec §14.5 primary
  // rule). PetOverlay constructs OverlaySession without extra props, so the
  // selection travels through this installed bridge instead.
  installCurrentSessionSource({
    getCurrent: () => ctx.sessions.list.getSnapshot().current,
    subscribe: (listener) => ctx.sessions.list.subscribe(listener),
  })
  const disposers = [
    // The extension service: provided for the plugin's whole lifetime so
    // consumers see a stable identity; it degrades to null-answers during
    // the overlay's no-session windows by design.
    ctx.provide('petween/client', petweenClientService),
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'petween', order: 130, label: 'Petween' },
        PetweenCard,
      ),
    ),
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        { name: 'shell.overlay', id: 'petween', order: 100, label: 'Petween' },
        PetOverlay,
      ),
    ),
  ]
  return () => {
    installCurrentSessionSource(null)
    for (const dispose of disposers) dispose()
  }
}
