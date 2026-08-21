/**
 * client/overlay-session.ts — the shell.overlay controller. Binds a live
 * PetStage to the motion stack for the REAL overlay and, since M4, to the
 * DSH agent state: once the pet is on stage it owns a DshStateSource
 * (integration/dsh) that drives the MotionDirector through the SSE channel.
 *
 * Owns: registry/director lifecycle, boot preload + idle target, shared-config
 * application (config-hub publishes), the §22 reduced-motion policy
 * (matchMedia + config override; the stage never listens itself), the §23
 * visibility policy (director.pause/resume — ambient phase preserved), drag
 * position persistence (§27: debounced PUT + hub broadcast), the §28 click
 * interaction, and window-resize re-clamping.
 */
import { createPoseResolver } from '../core/pose-resolver'
import { BUILTIN_INTERACTION_DEFINITIONS } from '../core/transition-presets'
import type { AssetMeta, MotionPetConfig, PoseKey, ResolvedPose } from '../core/types'
import { POSE_KEYS } from '../core/types'
import { DshStateSource, getCurrentSessionSource } from '../integration/dsh/dsh-state-source'
import { createBuiltinRegistry, type AnimationRegistry } from '../motion/animation-registry'
import { MotionDirector } from '../motion/motion-director'
import { patchConfig as httpPatchConfig, type ConfigPatch } from './api'
import type { ConfigHub, ConfigSnapshot } from './config-hub'
import { syncCustomAnimations } from './custom-animations'
import { DragController } from './overlay/drag-controller'
import { clampStagePosition, DEFAULT_OVERLAY_MARGIN, type PetStage } from './overlay/pet-stage'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** §21-style debounce for the drag-end position write. */
const DEFAULT_POSITION_SAVE_DEBOUNCE_MS = 300

/** Anything the overlay needs from the M4 agent-state source. */
export interface OverlayStateSourceHandle {
  dispose(): void
  /** Hot-applies §14.5 aggregate TTLs (success/error holds) after a live config edit. */
  setTerminalTtls?(successMs: number, errorMs: number): void
  /** §14.4: a pet click releases a held success/error face; no-op otherwise. */
  dismissTerminal?(): void
}

export interface OverlaySessionOptions {
  stage: PetStage
  /** The shared hub; must already be loaded (PetOverlay guarantees this). */
  hub: ConfigHub
  /**
   * Position persistence seam; production hits the real HTTP API. Sends a
   * partial patch (the host merges + serializes), resolves the full config.
   */
  patchConfig?: (patch: ConfigPatch) => Promise<MotionPetConfig>
  registry?: AnimationRegistry
  positionSaveDebounceMs?: number
  /**
   * M4 seam: builds the agent-state source once the pet is on stage. The
   * default constructs the real DshStateSource wired to the SSE channel;
   * without an EventSource (non-browser test envs) it returns null and the
   * pet simply keeps its idle face (the M3 behavior).
   */
  createStateSource?: (director: MotionDirector, config: MotionPetConfig) => OverlayStateSourceHandle | null
}

const defaultCreateStateSource = (
  director: MotionDirector,
  config: MotionPetConfig,
): OverlayStateSourceHandle | null => {
  if (typeof EventSource !== 'function') return null
  return new DshStateSource({ config, director, sessionSource: getCurrentSessionSource() ?? undefined })
}

/** config.overlay → px position; null means the §27 default corner. */
function readOverlayPosition(config: MotionPetConfig): { x: number; y: number } | null {
  const { x, y } = config.overlay
  return x === null || y === null ? null : { x, y }
}

export class OverlaySession {
  readonly registry: AnimationRegistry
  readonly director: MotionDirector
  readonly drag: DragController

  private readonly stage: PetStage
  private readonly hub: ConfigHub
  private readonly patchConfig: (patch: ConfigPatch) => Promise<MotionPetConfig>
  private readonly positionSaveDebounceMs: number
  private readonly createStateSource: (director: MotionDirector, config: MotionPetConfig) => OverlayStateSourceHandle | null
  private readonly unsubscribeHub: () => void
  private readonly config: MotionPetConfig
  private assets: Record<string, AssetMeta>
  private resolvePose: (poseKey: PoseKey) => ResolvedPose | null
  private mediaQuery: MediaQueryList | null = null
  private stateSource: OverlayStateSourceHandle | null = null
  private position: { x: number; y: number } | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveInFlight = false
  private hidden = false
  private disposed = false
  private started = false
  private poseRefreshSeq = 0

  constructor(options: OverlaySessionOptions) {
    const snapshot = options.hub.getCurrent()
    if (snapshot === null) throw new Error('OverlaySession: the config hub must be loaded first')
    this.stage = options.stage
    this.hub = options.hub
    this.patchConfig = options.patchConfig ?? (async (patch) => (await httpPatchConfig(patch)).config)
    this.positionSaveDebounceMs = options.positionSaveDebounceMs ?? DEFAULT_POSITION_SAVE_DEBOUNCE_MS
    this.createStateSource = options.createStateSource ?? defaultCreateStateSource
    // Own copies: the hub replaces its cached objects on every publish, so the
    // director's config object must be session-owned and field-updated (same
    // trick as PreviewSession.updateConfig).
    this.config = structuredClone(snapshot.config)
    this.assets = { ...snapshot.assets }
    this.resolvePose = createPoseResolver(this.config.poses, this.assets)

    this.registry = options.registry ?? createBuiltinRegistry()
    // §28 click feedback is interaction data (core/transition-presets) and is
    // not part of the transition/ambient builtin arrays — register it here.
    for (const definition of BUILTIN_INTERACTION_DEFINITIONS) {
      if (this.registry.get(definition.id) === undefined) this.registry.registerBuiltin(definition)
    }
    this.syncCustoms(snapshot.customs)
    this.director = new MotionDirector({
      stage: options.stage,
      registry: this.registry,
      config: this.config,
      // Indirection: updateConfig swaps the resolver on config changes.
      resolvePose: (poseKey) => this.resolvePose(poseKey),
    })

    this.position = readOverlayPosition(this.config)
    this.stage.setUserScale(this.config.global.scale)
    this.applyPosition()

    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY)
      this.mediaQuery.addEventListener('change', this.handleMediaChange)
    }
    this.applyReducedMotion()
    this.stage.setParticlesEnabled(this.config.advanced.particles)

    this.drag = new DragController({
      handle: this.stage.interactiveElement,
      stageSize: this.stage.stageSize,
      getPosition: () => this.position ?? this.defaultPositionPx(),
      onMove: (x, y) => {
        this.position = { x, y }
        this.stage.setPosition(x, y)
      },
      onDragEnd: () => this.schedulePositionSave(),
      onClick: () => this.clickPop(),
    })

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleResize)
    }
    this.unsubscribeHub = this.hub.subscribe((next) => {
      void this.updateConfig(next)
    })
  }

  /**
   * Boot: preload every resolvable pose (§16.3), then show idle. The target
   * goes straight to the director (reason 'session-switch') — it is the mount
   * bootstrap, not a semantic event, and must not consume the resolver's idle
   * dedupe (same contract as PreviewSession.start). No usable image (§2.1)
   * leaves the stage empty; a later hub publish retries via updateConfig.
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return
    const seen = new Set<string>()
    const poses: ResolvedPose[] = []
    for (const key of POSE_KEYS) {
      const pose = this.resolvePose(key)
      if (pose !== null && !seen.has(pose.asset.id)) {
        seen.add(pose.asset.id)
        poses.push(pose)
      }
    }
    await this.stage.preload(poses)
    if (this.disposed || this.started) return
    if (this.resolvePose(this.config.states.idle.pose) === null) return
    await this.director.setTarget({
      visualState: 'idle',
      poseKey: this.config.states.idle.pose,
      reason: 'session-switch',
    })
    if (this.disposed) return
    this.started = true
    this.reconcileStateSource()
    await this.refreshCurrentPose()
  }

  /**
   * M4: the state source lives exactly while the pet is on stage and enabled
   * (spec: no SSE without a usable image or with enabled=false). Created
   * lazily after a successful boot; torn down live on a disable publish —
   * PetOverlay normally unmounts the whole session on either condition, so
   * this is the in-session backstop.
   */
  private reconcileStateSource(): void {
    const wanted = this.started && this.config.enabled && !this.disposed
    if (wanted && this.stateSource === null) {
      this.stateSource = this.createStateSource(this.director, this.config)
    } else if (!wanted && this.stateSource !== null) {
      this.stateSource.dispose()
      this.stateSource = null
    }
  }

  /**
   * Hub publish → hot-apply: re-resolve poses, follow scale/reduced-motion,
   * restart ambient only on a substantive states change, and follow a remotely
   * changed overlay position — unless a local drag/save currently owns it.
   */
  async updateConfig(snapshot: ConfigSnapshot): Promise<void> {
    if (this.disposed) return
    const previousStates = JSON.stringify(this.config.states)
    const previousReducedMotion = this.config.global.reducedMotion
    const previousScale = this.config.global.scale
    const previousSuccessHoldMs = this.config.global.successHoldMs
    const previousErrorHoldMs = this.config.global.errorHoldMs
    const next = structuredClone(snapshot.config)
    this.config.enabled = next.enabled
    this.config.global = next.global
    this.config.poses = next.poses
    this.config.states = next.states
    this.config.overlay = next.overlay
    this.config.advanced = next.advanced
    this.config.interactions = next.interactions
    this.assets = { ...snapshot.assets }
    this.resolvePose = createPoseResolver(this.config.poses, this.assets)
    this.stage.setParticlesEnabled(this.config.advanced.particles)
    this.syncCustoms(snapshot.customs)

    if (this.config.global.scale !== previousScale) this.stage.setUserScale(this.config.global.scale)
    if (this.config.global.reducedMotion !== previousReducedMotion) {
      this.applyReducedMotion()
    } else if (JSON.stringify(this.config.states) !== previousStates) {
      this.director.refreshAmbient()
    }

    // The state source reads the §14.5 holds once at construction; push edits.
    if (
      this.config.global.successHoldMs !== previousSuccessHoldMs ||
      this.config.global.errorHoldMs !== previousErrorHoldMs
    ) {
      this.stateSource?.setTerminalTtls?.(this.config.global.successHoldMs, this.config.global.errorHoldMs)
    }

    if (!this.drag.isDragging && this.saveTimer === null && !this.saveInFlight) {
      this.position = readOverlayPosition(this.config)
      this.applyPosition()
    }

    if (!this.started) {
      await this.start() // the first boot found no image; retry now
      return
    }
    this.reconcileStateSource()
    await this.refreshCurrentPose()
  }

  /** §22: push the effective reduced-motion flag into stage + ambient engine. */
  applyReducedMotion(): void {
    const setting = this.config.global.reducedMotion
    const system = this.mediaQuery?.matches ?? false
    const effective = setting === 'always' || (setting === 'system' && system)
    this.stage.setReducedMotion(effective)
    this.director.refreshAmbient()
  }

  /**
   * V1.1: reconcile the registry's user:* entries with the hub's customs
   * (editor save/clone/delete, or another tab via poll). A dangling
   * animationId falls back to preset semantics at play time, so a removed
   * custom never breaks the pet.
   */
  private syncCustoms(customs: ConfigSnapshot['customs']): void {
    for (const warning of syncCustomAnimations(this.registry, customs)) {
      console.warn(`motion-pet: ${warning}`)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
      void this.persistPosition() // best-effort final write (drag ended just now)
    }
    this.stateSource?.dispose()
    this.stateSource = null
    this.unsubscribeHub()
    this.mediaQuery?.removeEventListener('change', this.handleMediaChange)
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleResize)
    }
    this.drag.dispose()
    this.director.dispose()
    this.mediaQuery = null
  }

  /**
   * Re-resolve the current target's pose after a config change; swap if it
   * changed. Resolution follows the DIRECTOR's target (same rationale as
   * PreviewSession): a pose shown through fallback carries the fallback source
   * key on stage, so re-resolving the stage slot would miss a freshly
   * imported image until the next agent state change.
   *
   * A transition in flight still pose-swaps the values resolved at its start,
   * so the refresh first waits for it to settle and then re-resolves against
   * the new config. A transition that started after the config change already
   * resolved fresh values; the refresh leaves the stage to it.
   */
  private async refreshCurrentPose(): Promise<void> {
    const seq = ++this.poseRefreshSeq
    if (this.director.transitionInFlight) {
      await this.director.whenSettled()
      if (this.disposed || seq !== this.poseRefreshSeq) return
      if (this.director.transitionInFlight) return // a newer transition owns the stage
    }
    const target = this.director.currentTarget
    if (target === null) return
    const current = this.stage.currentPose
    if (current === null) return
    const next = this.resolvePose(target.poseKey)
    if (next === null) return // every image removed; the overlay unmounts instead
    const unchanged =
      next.asset.url === current.asset.url &&
      next.anchor.x === current.anchor.x &&
      next.anchor.y === current.anchor.y &&
      next.zoom === current.zoom
    if (unchanged) return
    await this.stage.preload([next])
    if (this.disposed || seq !== this.poseRefreshSeq) return // superseded
    this.stage.swapPose(next)
  }

  /**
   * §28: a click plays the configured interaction (data-driven, no state
   * change on its own; an optional flash pose is handled by the director).
   * It also dismisses a held success/error face (§14.4 until-interaction) —
   * the dismiss stays ahead of the pop; outside a terminal hold it is a no-op.
   */
  private clickPop(): void {
    if (this.disposed || this.hidden) return
    this.stateSource?.dismissTerminal?.()
    void this.director.playInteraction().catch((error: unknown) => {
      console.error('motion-pet: click interaction failed', error)
    })
  }

  private applyPosition(): void {
    if (this.position === null) this.stage.setDefaultPosition()
    else this.stage.setPosition(this.position.x, this.position.y)
  }

  /** The §27 default corner, expressed in px for drag math. */
  private defaultPositionPx(): { x: number; y: number } {
    const size = this.stage.stageSize
    return clampStagePosition(
      window.innerWidth - size - DEFAULT_OVERLAY_MARGIN,
      window.innerHeight - size - DEFAULT_OVERLAY_MARGIN,
      size,
      window.innerWidth,
      window.innerHeight,
    )
  }

  private schedulePositionSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persistPosition()
    }, this.positionSaveDebounceMs)
  }

  /**
   * Debounced drag-end write: an overlay-only patch PUT — never a full config
   * copy, so a concurrent editor save cannot be clobbered (the host serializes
   * the read-merge-write). The host's merged config is broadcast to the hub.
   */
  private async persistPosition(): Promise<void> {
    const position = this.position
    if (position === null) return
    this.saveInFlight = true
    try {
      const saved = await this.patchConfig({ overlay: { x: Math.round(position.x), y: Math.round(position.y) } })
      const current = this.hub.getCurrent()
      if (!this.disposed && current !== null) {
        this.hub.publish({ config: saved, assets: current.assets, customs: current.customs })
      }
    } catch (error) {
      if (!this.disposed) console.error('motion-pet: failed to save the pet position', error)
    } finally {
      this.saveInFlight = false
    }
  }

  /** §23: freeze ambient + in-flight interactions while hidden (phase kept). */
  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) this.director.pause()
    else this.director.resume()
  }

  private readonly handleMediaChange = (): void => {
    this.applyReducedMotion()
  }

  private readonly handleVisibilityChange = (): void => {
    this.setHidden(document.visibilityState === 'hidden')
  }

  private readonly handleResize = (): void => {
    // §27: a dragged position re-clamps into the new viewport; the default
    // corner re-anchors itself via right/bottom CSS.
    if (this.disposed || this.position === null) return
    this.applyPosition()
  }
}
