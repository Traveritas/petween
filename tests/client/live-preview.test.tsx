// @vitest-environment jsdom
/**
 * LivePreview tests: the draft hot-sync effect pushes every config/assets
 * change into the session; a rejecting updateConfig must surface as a console
 * warning, never an unhandled rejection (the effect is fire-and-forget).
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewSession } from '../../src/client/preview-session'
import { LivePreview } from '../../src/client/settings/LivePreview'
import { createDefaultPetweenConfig } from '../../src/core/defaults'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let mounted: boolean

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  mounted = true
})

afterEach(() => {
  if (mounted) act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('LivePreview — draft hot-sync', () => {
  it('a rejecting session.updateConfig is caught and warned, not unhandled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const updateConfig = vi.fn(() => Promise.reject(new Error('decode exploded')))
    const sessionRef = { current: { updateConfig } as unknown as PreviewSession }
    await act(async () => {
      root.render(
        <LivePreview
          config={createDefaultPetweenConfig()}
          assets={{}}
          configRevision={0}
          sessionRef={sessionRef}
          onStage={() => {}}
          onReplay={() => {}}
        />,
      )
    })

    expect(updateConfig).toHaveBeenCalledTimes(1)
    await act(async () => {}) // let the rejection's catch microtask run
    expect(warn).toHaveBeenCalledWith('petween: live preview config sync failed', expect.any(Error))
  })
})
