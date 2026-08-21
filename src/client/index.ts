/**
 * dsh-motion-pet browser half — the settings.section slot carries the compact
 * MotionPetCard entry card (the full editor lives on the standalone
 * /motion-pet-editor/ page); 'shell.overlay' carries the real pet surface
 * (spec §5.2). M4 additionally bridges the DSH current-session selection
 * (`ctx.sessions.list`) into the overlay's DshStateSource. Both surfaces
 * share one config through the config hub and one renderer (PetRenderer,
 * §16.2).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pull the SlotMap merges so the slot names type-check.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { installCurrentSessionSource } from '../integration/dsh/dsh-state-source'
import { PetOverlay } from './overlay/PetOverlay'
import { MotionPetCard } from './settings/MotionPetCard'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext) {
  // M4: the overlay follows the user's current session (spec §14.5 primary
  // rule). PetOverlay constructs OverlaySession without extra props, so the
  // selection travels through this installed bridge instead.
  installCurrentSessionSource({
    getCurrent: () => ctx.sessions.list.getSnapshot().current,
    subscribe: (listener) => ctx.sessions.list.subscribe(listener),
  })
  const disposers = [
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register(
        { name: 'settings.section', id: 'motion-pet', order: 130, label: 'Motion Pet' },
        MotionPetCard,
      ),
    ),
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register(
        { name: 'shell.overlay', id: 'motion-pet', order: 100, label: 'Motion Pet' },
        PetOverlay,
      ),
    ),
  ]
  return () => {
    installCurrentSessionSource(null)
    for (const dispose of disposers) dispose()
  }
}
