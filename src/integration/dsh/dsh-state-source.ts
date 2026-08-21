/**
 * integration/dsh/dsh-state-source.ts — the DSH-backed state source for the
 * real overlay (M4, spec §13–§15). Mirrors ManualStateSource's role for the
 * settings preview: owns the StateAdapter transport and the M1
 * PetStateResolver (coalescing / dedupe / transient holds), and hands the
 * resolver's targets to the MotionDirector.
 *
 * The current DSH session arrives through the {@link CurrentSessionSource}
 * bridge: client/index.ts (the only place that may touch `ctx.sessions`)
 * installs it at apply time; this source subscribes and reconnects the
 * stream when the selection changes. With no bridge installed (or no current
 * session) the adapter connects to the aggregate stream — the §14.5 fallback.
 */
import { PetStateResolver } from '../../core/pet-state-resolver'
import type { MotionPetConfig } from '../../core/types'
import type { MotionDirector } from '../../motion/motion-director'
import { StateAdapter, type EventSourceFactory, type StateFetcher } from './state-adapter'

/**
 * Minimal read face of `ctx.sessions.list` (ObservableSnapshot). Keeps the
 * DSH service type out of the overlay controller; client/index.ts adapts the
 * real one.
 */
export interface CurrentSessionSource {
  getCurrent(): string | undefined
  subscribe(listener: () => void): () => void
}

let installedSessionSource: CurrentSessionSource | null = null

/** Called by client/index.ts at apply/dispose time (null on dispose). */
export function installCurrentSessionSource(source: CurrentSessionSource | null): void {
  installedSessionSource = source
}

export function getCurrentSessionSource(): CurrentSessionSource | null {
  return installedSessionSource
}

export interface DshStateSourceOptions {
  /** Session-owned config object; field updates are read live by the resolver. */
  config: Pick<MotionPetConfig, 'states' | 'global' | 'advanced'>
  director: MotionDirector
  /** Bridge to the DSH current-session selection; aggregate mode when absent. */
  sessionSource?: CurrentSessionSource
  coalesceMs?: number
  eventSourceFactory?: EventSourceFactory
  fetchState?: StateFetcher
  pollIntervalMs?: number
}

export class DshStateSource {
  private readonly resolver: PetStateResolver
  private readonly adapter: StateAdapter
  private readonly unsubscribeSessionSource: (() => void) | null = null

  constructor(options: DshStateSourceOptions) {
    this.resolver = new PetStateResolver({
      config: options.config,
      coalesceMs: options.coalesceMs,
      onTarget: (target) => {
        options.director.setTarget(target).catch((error: unknown) => {
          console.error('motion-pet: DSH state setTarget failed', error)
        })
      },
    })
    this.adapter = new StateAdapter({
      sessionId: options.sessionSource?.getCurrent(),
      onEvent: (event) => this.resolver.handleEvent(event),
      eventSourceFactory: options.eventSourceFactory,
      fetchState: options.fetchState,
      pollIntervalMs: options.pollIntervalMs,
      // §14.5: aggregate-mode terminal entries expire on the configured holds.
      successTtlMs: options.config.global.successHoldMs,
      errorTtlMs: options.config.global.errorHoldMs,
    })
    if (options.sessionSource !== undefined) {
      const source = options.sessionSource
      this.unsubscribeSessionSource = source.subscribe(() => {
        this.adapter.setSession(source.getCurrent())
      })
    }
  }

  /** Current stream session (undefined = aggregate); test introspection. */
  get sessionId(): string | undefined {
    return this.adapter.session
  }

  /** Hot-apply the §14.5 aggregate TTLs after a live config edit. */
  setTerminalTtls(successMs: number, errorMs: number): void {
    this.adapter.setTerminalTtls(successMs, errorMs)
  }

  /**
   * §14.4 click-to-dismiss: releases a held success/error face back to idle;
   * a no-op in every other state (the resolver dedupes it away).
   */
  dismissTerminal(): void {
    this.resolver.handleEvent({ type: 'dismiss' })
  }

  dispose(): void {
    this.unsubscribeSessionSource?.()
    this.adapter.dispose()
    this.resolver.dispose()
  }
}
