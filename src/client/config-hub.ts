/**
 * client/config-hub.ts — the shared config snapshot for the settings editor
 * and the shell.overlay pet (M3 acceptance: both surfaces read the SAME
 * config, spec §M3).
 *
 * - load(): exactly one GET pair (config + custom animations), memoized;
 *   whichever surface mounts first pays it.
 * - publish(): a local save (editor debounce, overlay drag persist) broadcasts
 *   its saved config immediately — the other surface updates without waiting
 *   for a poll.
 * - startPolling(): 3s interval catches external changes (another tab, CLI).
 *   Polling stops while document.hidden (§23) and refetches immediately when
 *   the page returns; a poll only publishes on an actual JSON diff.
 *
 * Pure TS, no React/DSH. The default singleton {@link configHub} is what the
 * production slots share; tests construct their own with an injected fetch.
 */
import type { AssetMeta, MotionPetConfig } from '../core/types'
import type { AnimationDefinition } from '../motion/animation-definition'
import {
  getAnimations as httpGetAnimations,
  getConfig as httpGetConfig,
  type GetAnimationsResponse,
  type GetConfigResponse,
} from './api'

export interface ConfigSnapshot {
  config: MotionPetConfig
  assets: Record<string, AssetMeta>
  /** V1.1 custom animations served by the host (plan §3); sessions register them. */
  customs: AnimationDefinition[]
}

export type ConfigListener = (snapshot: ConfigSnapshot) => void

export interface ConfigHubOptions {
  /** Test seam; production hits the real same-origin HTTP API. */
  fetchConfig?: () => Promise<GetConfigResponse>
  /** Test seam for GET /animations; fetched in parallel with the config. */
  fetchAnimations?: () => Promise<GetAnimationsResponse>
  pollIntervalMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 3000

export class ConfigHub {
  private readonly fetchConfig: () => Promise<GetConfigResponse>
  private readonly fetchAnimations: () => Promise<GetAnimationsResponse>
  private readonly pollIntervalMs: number
  private readonly listeners = new Set<ConfigListener>()
  private snapshot: ConfigSnapshot | null = null
  private loadPromise: Promise<ConfigSnapshot> | null = null
  /** Host-side animation scan warnings from the latest load/poll. */
  private animationWarnings: string[] = []
  private polling = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by publish(); a poll started before a local save drops its result. */
  private publishGeneration = 0

  constructor(options: ConfigHubOptions = {}) {
    this.fetchConfig = options.fetchConfig ?? httpGetConfig
    this.fetchAnimations = options.fetchAnimations ?? httpGetAnimations
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  }

  /** The first caller triggers the single GET pair; everyone else shares the cache. */
  load(): Promise<ConfigSnapshot> {
    if (this.snapshot !== null) return Promise.resolve(this.snapshot)
    if (this.loadPromise === null) {
      this.loadPromise = Promise.all([this.fetchConfig(), this.fetchAnimations()]).then(
        ([{ config, assets }, { customs, warnings }]) => {
          this.snapshot = { config, assets, customs }
          this.animationWarnings = warnings
          return this.snapshot
        },
        (error: unknown) => {
          this.loadPromise = null // a failed load may be retried
          throw error
        },
      )
    }
    return this.loadPromise
  }

  getCurrent(): ConfigSnapshot | null {
    return this.snapshot
  }

  /** Corrupt-animation-file warnings from the latest successful fetch. */
  getAnimationWarnings(): string[] {
    return this.animationWarnings
  }

  subscribe(listener: ConfigListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * A local save succeeded: cache the saved config and broadcast it now. The
   * snapshot is cloned so later mutations of the caller's objects cannot leak
   * into other subscribers. Also invalidates any poll currently in flight —
   * its (older) server snapshot must not overwrite this fresher state.
   */
  publish(snapshot: ConfigSnapshot): void {
    this.publishGeneration += 1
    this.snapshot = {
      config: structuredClone(snapshot.config),
      assets: { ...snapshot.assets },
      customs: structuredClone(snapshot.customs),
    }
    this.emit()
  }

  startPolling(): void {
    if (this.polling) return
    this.polling = true
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
      if (document.visibilityState === 'hidden') return // §23: no timers while hidden
    }
    this.scheduleNextPoll()
  }

  stopPolling(): void {
    this.polling = false
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
  }

  /** One poll tick; publishes only when the server JSON actually differs. */
  async poll(): Promise<void> {
    const generation = this.publishGeneration
    try {
      const [{ config, assets }, { customs, warnings }] = await Promise.all([this.fetchConfig(), this.fetchAnimations()])
      // A local publish landed while this GET was in flight: its state is
      // fresher than the polled snapshot, so the poll result is dropped.
      if (generation !== this.publishGeneration) return
      this.animationWarnings = warnings
      const next: ConfigSnapshot = { config, assets, customs }
      if (this.snapshot !== null && snapshotsEqual(this.snapshot, next)) return
      this.snapshot = next
      this.emit()
    } catch {
      // poll failures are silent: the next tick (or a local publish) retries
    }
  }

  private scheduleNextPoll(): void {
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll().finally(() => {
        if (this.polling && this.pollTimer === null) this.scheduleNextPoll()
      })
    }, this.pollIntervalMs)
  }

  private emit(): void {
    if (this.snapshot === null) return
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private readonly handleVisibilityChange = (): void => {
    if (!this.polling) return
    if (document.visibilityState === 'hidden') {
      if (this.pollTimer !== null) {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
      }
      return
    }
    // Back in the foreground: refetch immediately, then resume the interval.
    void this.poll()
    if (this.pollTimer === null) this.scheduleNextPoll()
  }
}

function snapshotsEqual(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return (
    JSON.stringify(a.config) === JSON.stringify(b.config) &&
    JSON.stringify(a.assets) === JSON.stringify(b.assets) &&
    JSON.stringify(a.customs) === JSON.stringify(b.customs)
  )
}

/** The app-wide hub shared by the settings editor and the overlay. */
export const configHub = new ConfigHub()
