/**
 * host/view-store.ts — preset-authority phase 2: the single funnel for every
 * config-VIEW read and write (docs/preset-authority-eval.md §2/§6).
 *
 * Reads: loadView() materializes the "current config" — the v2 global
 * document + the active preset's slice (host/config-view.ts) — in the legacy
 * v1 shape every client already speaks.
 *
 * Writes: update() is the PUT /config compatibility shim. One body can mix:
 * - global fields (enabled / global.transition… / overlay / advanced /
 *   interactions) → strictly validated, written to the v2 global document;
 * - slice fields (poses / states / global.scale) → strictly validated,
 *   written into the ACTIVE preset (form (i): every edit belongs to a pet);
 * - the activePetId pointer → a pure pointer write: a bare switch presents
 *   the target pet's own slice (the 2026-08-29 clobber class is gone by
 *   construction), a dangling id 404s, and explicit null is a tolerated
 *   no-op (the retired "detach" — it keeps the current pointer so
 *   full-document roundtrips keep working).
 * A slice write with a null/dangling pointer auto-provisions the default pet
 * (DEFAULT_PET_NAME) seeded from the current document's own slice — the
 * boot migration's "null/dangling → default pet" repair applied at write
 * time, so pre-migration v1 installs and fresh setups keep old clients
 * working.
 *
 * Every view-affecting write — global, slice or pointer — funnels through
 * update() and bumps the ONE monotonic revision (host/config.ts sidecar) on
 * the same serialized path. There is deliberately no host-side push: the
 * client's broadcast contract is poll-and-diff on GET /config plus the PUT
 * response itself (config-hub), and both now flow out of this single exit —
 * any change is visible in the very next view.
 */
import type { PetweenConfig, PetSlice } from '../core/types'
import type { AnimationKind } from '../motion/animation-definition'
import { RevisionMismatchError, type ConfigStore } from './config'
import { buildConfigView } from './config-view'
import { DEFAULT_PET_NAME, PetError, petSliceFromConfig, validatePetId, type PetsStore } from './pets'
import { createWriteLock, type WriteLock } from './storage'
import { validateGlobalPatch, validatePetSlicePatch } from './validation'

export interface ConfigViewStoreOptions {
  configStore: ConfigStore
  petsStore: PetsStore
  /** Custom-animation kind lookup for the strict slice validation (V1.1). */
  animationLookup?: (id: string) => AnimationKind | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Extract the slice patch out of a PUT body: poses/states verbatim, scale
 * lifted out of the `global` object (the slice's only field living inside
 * the legacy `global` section).
 */
function slicePatchOf(source: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (source.poses !== undefined) patch.poses = source.poses
  if (source.states !== undefined) patch.states = source.states
  if (isRecord(source.global)) {
    const scale = source.global.scale
    if (scale !== undefined) patch.scale = scale
  }
  return patch
}

export class ConfigViewStore {
  private readonly configStore: ConfigStore
  private readonly petsStore: PetsStore
  private readonly animationLookup?: (id: string) => AnimationKind | undefined
  /**
   * Serializes whole update() funnels against each other. Deliberately NOT
   * the shared B10 store lock: the stores enqueue on that one inside the
   * funnel, and holding it across the funnel would wait on itself (the
   * onSaved-mirror deadlock lesson, docs/implementation-notes.md). This
   * second, outer lock is deadlock-free because no store path ever calls
   * back into the funnel.
   */
  private readonly viewLock: WriteLock = createWriteLock()

  constructor(options: ConfigViewStoreOptions) {
    this.configStore = options.configStore
    this.petsStore = options.petsStore
    this.animationLookup = options.animationLookup
  }

  /** The materialized current config (legacy v1 shape). */
  async loadView(): Promise<PetweenConfig> {
    const config = await this.configStore.load()
    let slice: PetSlice | null = null
    if (config.activePetId !== null) {
      try {
        slice = await this.petsStore.read(config.activePetId)
      } catch (error) {
        // A dangling pointer or unreadable file resolves to no slice — the
        // view falls back to the document's own slice (legacy v1 data or
        // defaults) until a write or the boot repair re-points it.
        if (!(error instanceof PetError && error.code === 'NOT_FOUND')) throw error
      }
    }
    return buildConfigView(config, slice)
  }

  /** B3: the one monotonic revision covering every view-affecting write. */
  revision(): Promise<number> {
    return this.configStore.revision()
  }

  /**
   * The PUT /config funnel (compatibility shim): route one patch body to the
   * global document and/or the active preset, then resolve the fresh view —
   * PUT responses ARE views (the editor's adoptPublished depends on the
   * response carrying the full config shape).
   */
  update(raw: unknown, options: { expectedRevision?: number } = {}): Promise<PetweenConfig> {
    return this.viewLock(async () => {
      // B3 fail-fast: reject a stale writer before ANY side effect (the
      // auto-provision below creates a pet — a 409 must not orphan one).
      // updateGlobals re-checks inside its own segment as the authoritative
      // gate; this pre-flight is exact because the view lock serializes every
      // revision-bumping write in the process.
      if (options.expectedRevision !== undefined) {
        const currentRevision = await this.configStore.revision()
        if (options.expectedRevision !== currentRevision) throw new RevisionMismatchError(currentRevision)
      }
      const current = await this.configStore.load()
      const source = isRecord(raw) ? raw : undefined

      // --- pointer routing -------------------------------------------------
      // An explicit shape-valid pointer is a switch: the target must EXIST
      // (404 — a dangling id can no longer smuggle the live slice into a
      // view), and the view then presents the target's own slice. Explicit
      // null (the retired "detach") is a tolerated no-op: it falls through
      // here and the global walker keeps the current pointer. Garbage shapes
      // are rejected by that same validation (400 — a malformed id is a
      // client bug, not a missing pet).
      let pointerId: string | undefined
      if (source !== undefined && typeof source.activePetId === 'string' && validatePetId(source.activePetId) !== null) {
        pointerId = source.activePetId
      }

      // --- slice routing ---------------------------------------------------
      const slicePatch = source === undefined ? {} : slicePatchOf(source)
      const hasSlice = Object.keys(slicePatch).length > 0
      // The slice's home: the explicit pointer target, else the current one.
      // A null/dangling target auto-provisions the default pet seeded from
      // the current document's own slice, so a pre-migration v1 install
      // keeps its live data on the very first write.
      let targetId = pointerId ?? current.activePetId
      let sliceBase: PetSlice = petSliceFromConfig(current)
      let provision = false
      if (pointerId !== undefined) {
        const target = await this.petsStore.read(pointerId) // PetError NOT_FOUND → 404
        sliceBase = target
        targetId = target.id
      } else if (hasSlice && targetId !== null) {
        try {
          sliceBase = await this.petsStore.read(targetId)
        } catch (error) {
          if (!(error instanceof PetError && error.code === 'NOT_FOUND')) throw error
          provision = true // dangling pointer: heal into a fresh default pet
        }
      } else if (hasSlice) {
        provision = true // null pointer: first write on a fresh/legacy install
      }

      // --- strict validation of both segments BEFORE any write -------------
      // (a globals 400 / slice 400 must never leave a half-applied funnel:
      // the pointer flip and the pet creation happen only after both pass).
      // The slice pre-validation is FAIL-FAST ONLY — its merged output drops
      // explicit-null clears, so the raw patch (nulls intact) is what
      // writeSlice re-validates against the freshest preset inside its own
      // segment. Only the provision create uses the merged output.
      validateGlobalPatch(raw, current, { animationLookup: this.animationLookup })
      if (hasSlice) validatePetSlicePatch(slicePatch, sliceBase, { animationLookup: this.animationLookup })

      // --- writes ----------------------------------------------------------
      if (provision) {
        const pet = await this.petsStore.create(DEFAULT_PET_NAME, validatePetSlicePatch(slicePatch, sliceBase, { animationLookup: this.animationLookup }))
        targetId = pet.id
      }
      // One global write covers the global fields AND the pointer (incl. the
      // auto-provisioned one) — one revision bump per funnel run. The global
      // walker ignores the slice fields still present in the body.
      const globalsPatch: Record<string, unknown> = { ...source }
      if (provision) globalsPatch.activePetId = targetId
      await this.configStore.updateGlobals(globalsPatch, options)
      if (hasSlice && !provision) {
        await this.petsStore.writeSlice(targetId as string, slicePatch, { animationLookup: this.animationLookup })
      }
      return this.loadView()
    })
  }
}
