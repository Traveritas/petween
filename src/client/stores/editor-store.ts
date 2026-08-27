/**
 * client/stores/editor-store.ts — the settings editor state machine (spec
 * §17, §21). Pure TS with a subscribe/getSnapshot pair so React components
 * read it through useSyncExternalStore; nothing here imports React or DSH.
 *
 * Save discipline: updateConfig mutates the local draft immediately (the Live
 * Preview follows via configRevision) and marks it dirty. Only saveConfig()
 * sends the editor-owned sections (enabled/global/poses/states/advanced/
 * interactions — never overlay, never version) as a patch PUT. Writes
 * serialize; edits landing while a PUT is in flight are included in a second
 * write (latest-wins). Asset imports upload immediately so they can be
 * previewed, while config persistence and replaced-asset cleanup wait for the
 * same explicit save. Custom animations (V1.1) are explicit-save too:
 * saveAnimation/deleteAnimation hit the API immediately and broadcast the
 * customs list through the hub; they never touch the config draft.
 */
import type { AssetMeta, PetweenConfig, PetPreset, PetSlice, PoseKey } from '../../core/types'
import { POSE_KEYS } from '../../core/types'
import type { AnimationDefinition } from '../../motion/animation-definition'
import { validateAnimationDefinition } from '../../motion/animation-definition'
import {
  applyPet as httpApplyPet,
  createPet as httpCreatePet,
  createPetFromDraft as httpCreatePetFromDraft,
  deleteAnimation as httpDeleteAnimation,
  deleteAsset as httpDeleteAsset,
  deletePet as httpDeletePet,
  exportMotionPack as httpExportMotionPack,
  getAnimations as httpGetAnimations,
  getConfig as httpGetConfig,
  getPets as httpGetPets,
  importMotionPack as httpImportMotionPack,
  patchConfig as httpPatchConfig,
  putAnimation as httpPutAnimation,
  renamePet as httpRenamePet,
  uploadAsset as httpUploadAsset,
  ApiError,
  type ConfigPatch,
  type GetAnimationsResponse,
  type GetConfigResponse,
  type GetPetsResponse,
  type MotionPack,
  type PackImportResponse,
  type UploadedAsset,
} from '../api'
import type { ConfigHub, ConfigSnapshot } from '../config-hub'
import { STATE_LABELS } from '../settings/state-labels'

/** Client-side mirror of the host upload rules (spec §20; host re-validates). */
const ACCEPTED_MIME_TYPES: ReadonlyArray<AssetMeta['mimeType']> = ['image/png', 'image/webp', 'image/jpeg']
const MAX_ASSET_BYTES = 10 * 1024 * 1024

/** The API surface the store needs; the default adapter hits the real HTTP API. */
export interface EditorApi {
  getConfig(): Promise<GetConfigResponse>
  /** V1.1: custom animations + host scan warnings (fetched in parallel with the config). */
  getAnimations(): Promise<GetAnimationsResponse>
  /** V1.1: named character presets and the active config pointer. */
  getPets(): Promise<GetPetsResponse>
  createPet(input: { name: string; from: 'current' | 'blank' }): Promise<{ pet: PetPreset; config: PetweenConfig }>
  /** A2: persist the supplied slice as a NEW preset; never touches the active pet. */
  createPetFromDraft(name: string, pet: PetSlice): Promise<{ pet: PetPreset }>
  renamePet(id: string, name: string): Promise<void>
  deletePet(id: string): Promise<void>
  applyPet(id: string): Promise<PetweenConfig>
  /** Patch PUT of the editor-owned sections; resolves the host-merged full config. */
  patchConfig(patch: ConfigPatch): Promise<PetweenConfig>
  /** Explicit-save custom animation write (no debounce — plan §3/P0). */
  putAnimation(definition: AnimationDefinition): Promise<void>
  deleteAnimation(id: string): Promise<void>
  /** P2 Motion Pack: raw pack JSON text in, per-entry import outcomes out. */
  importMotionPack(packJson: string): Promise<PackImportResponse>
  /** P2 Motion Pack: the ids to export, the manifest back. */
  exportMotionPack(ids: string[]): Promise<MotionPack>
  uploadAsset(file: File): Promise<UploadedAsset>
  deleteAsset(id: string): Promise<void>
}

const httpEditorApi: EditorApi = {
  getConfig: () => httpGetConfig(),
  getAnimations: () => httpGetAnimations(),
  getPets: () => httpGetPets(),
  createPet: (input) => httpCreatePet(input),
  createPetFromDraft: (name, pet) => httpCreatePetFromDraft(name, pet),
  renamePet: async (id, name) => {
    await httpRenamePet(id, name)
  },
  deletePet: async (id) => {
    await httpDeletePet(id)
  },
  applyPet: async (id) => (await httpApplyPet(id)).config,
  patchConfig: async (patch) => (await httpPatchConfig(patch)).config,
  putAnimation: async (definition) => {
    await httpPutAnimation(definition)
  },
  deleteAnimation: async (id) => {
    await httpDeleteAnimation(id)
  },
  importMotionPack: (packJson) => httpImportMotionPack(packJson),
  exportMotionPack: (ids) => httpExportMotionPack(ids),
  uploadAsset: async (file) => (await httpUploadAsset(file)).asset,
  deleteAsset: async (id) => {
    await httpDeleteAsset(id)
  },
}

export type EditorStatus = 'loading' | 'ready' | 'error'
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'
export type NoticeKind = 'info' | 'warn' | 'error'

export interface EditorNotice {
  kind: NoticeKind
  text: string
}

export interface EditorSnapshot {
  status: EditorStatus
  /** The local draft; mutated in place, every mutation bumps configRevision. */
  config: PetweenConfig | null
  assets: Record<string, AssetMeta>
  /** V1.1 custom animations (explicit-save; separate from the config draft). */
  customs: AnimationDefinition[]
  /** V1.1 named pet presets; active identity lives in config.activePetId. */
  pets: PetPreset[]
  selectedState: PoseKey
  saveState: SaveState
  loadError: string | null
  saveError: string | null
  notice: EditorNotice | null
  /** UX-3: the pose slot whose image upload is in flight (one at a time). */
  importing: PoseKey | null
  /** Bumped only when config/assets content changes — drives the Live Preview sync. */
  configRevision: number
}

export interface EditorStoreOptions {
  api?: EditorApi
  /**
   * M3 shared config hub: when present, load() reuses the hub's single GET,
   * successful saves are broadcast to the overlay instantly, and external
   * publishes are adopted — unless the draft is dirty (unsaved edits are
   * never rolled back by a poll). Tests omit the hub and keep the api path.
   */
  hub?: ConfigHub
}

/**
 * Notices are user-facing: well-known transport codes get Chinese copy
 * instead of the raw English message; anything else (host validation
 * messages included) passes through unchanged.
 */
function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'TIMEOUT') return '请求超时，请稍后重试'
    if (error.code === 'NETWORK') return '网络连接失败，请检查网络'
  }
  return error instanceof Error ? error.message : String(error)
}

/** §2.1 gate: at least one pose references an asset that actually exists. */
export function hasAnyUsableImage(config: PetweenConfig, assets: Record<string, AssetMeta>): boolean {
  return POSE_KEYS.some((key) => {
    const assetId = config.poses[key].assetId
    return assetId !== undefined && assets[assetId] !== undefined
  })
}

export class EditorStore {
  private readonly api: EditorApi
  private readonly hub: ConfigHub | undefined
  private readonly unsubscribeHub: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: EditorSnapshot

  private saveChain: Promise<void> = Promise.resolve()
  private dirty = false
  private saveInFlight = false
  private readonly pendingAssetDeletes = new Set<string>()
  private disposed = false
  /** UX-3: sequence of the latest importImage call — only it may clear `importing`. */
  private importSeq = 0

  constructor(options: EditorStoreOptions = {}) {
    this.api = options.api ?? httpEditorApi
    this.hub = options.hub
    this.snapshot = {
      status: 'loading',
      config: null,
      assets: {},
      customs: [],
      pets: [],
      selectedState: 'idle',
      saveState: 'idle',
      loadError: null,
      saveError: null,
      notice: null,
      importing: null,
      configRevision: 0,
    }
    this.unsubscribeHub = this.hub?.subscribe((published) => this.adoptPublished(published)) ?? null
  }

  readonly getSnapshot = (): EditorSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(patch: Partial<EditorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  async load(): Promise<void> {
    if (this.disposed) return
    this.emit({ status: 'loading', loadError: null })
    try {
      let config: PetweenConfig
      let assets: Record<string, AssetMeta>
      let customs: AnimationDefinition[]
      let animationWarnings: string[]
      let pets: PetPreset[]
      let petWarnings: string[]
      let activePetId: string | null
      if (this.hub !== undefined) {
        const [shared, petsResponse] = await Promise.all([this.hub.load(), this.api.getPets()])
        ;({ config, assets, customs } = shared)
        animationWarnings = this.hub.getAnimationWarnings()
        ;({ pets, warnings: petWarnings, activePetId } = petsResponse)
      } else {
        const [configResponse, animationsResponse, petsResponse] = await Promise.all([
          this.api.getConfig(),
          this.api.getAnimations(),
          this.api.getPets(),
        ])
        ;({ config, assets } = configResponse)
        ;({ customs, warnings: animationWarnings } = animationsResponse)
        ;({ pets, warnings: petWarnings, activePetId } = petsResponse)
      }
      if (this.disposed) return
      // Hub-backed stores keep the shared poll alive themselves: when the pet
      // overlay is disabled or unmounted it releases its own claim, but the
      // settings built on this hub must still observe external changes.
      this.hub?.startPolling(this)
      // GET /pets is authoritative for the pointer and may observe a newer
      // switch than a separately fetched config response.
      config = structuredClone(config)
      config.activePetId = activePetId
      // Clone from the hub cache: the draft is mutated in place by edits and
      // must never alias the shared snapshot.
      const warningParts: string[] = []
      if (animationWarnings.length > 0) warningParts.push(`${animationWarnings.length} 个自定义动画文件损坏或不合法`)
      if (petWarnings.length > 0) warningParts.push(`${petWarnings.length} 个宠物预设文件损坏或不合法`)
      this.emit({
        status: 'ready',
        config: structuredClone(config),
        assets: { ...assets },
        customs: structuredClone(customs),
        pets: structuredClone(pets),
        // Corrupt animation files were skipped host-side (plan §3): say so once.
        notice:
          warningParts.length > 0 ? { kind: 'warn', text: `有 ${warningParts.join('；')}，已被跳过。` } : null,
      })
    } catch (error) {
      if (this.disposed) return
      this.emit({ status: 'error', loadError: describeError(error) })
    }
  }

  /**
   * M3 rollback guard: adopt a hub publish (overlay drag save, another tab's
   * poll) only while the local draft is clean and no save is in flight; a dirty draft is the user's
   * in-progress edit and must win. Identical content (e.g. the echo of our
   * own save) is skipped without bumping configRevision. Customs are
   * explicit-save data outside the config draft — they always follow the hub.
   */
  private adoptPublished(published: ConfigSnapshot): void {
    if (this.disposed || this.snapshot.status !== 'ready') return
    const patch: Partial<EditorSnapshot> = {}
    if (JSON.stringify(this.snapshot.customs) !== JSON.stringify(published.customs)) {
      patch.customs = structuredClone(published.customs)
    }
    const current = this.snapshot.config
    if (!this.dirty && !this.saveInFlight && current !== null) {
      const sameConfig = JSON.stringify(current) === JSON.stringify(published.config)
      const sameAssets = JSON.stringify(this.snapshot.assets) === JSON.stringify(published.assets)
      if (!sameConfig || !sameAssets) {
        patch.config = structuredClone(published.config)
        patch.assets = { ...published.assets }
        patch.configRevision = this.snapshot.configRevision + 1
      }
    }
    if (Object.keys(patch).length > 0) this.emit(patch)
  }

  selectState(state: PoseKey): void {
    if (this.disposed) return
    this.emit({ selectedState: state })
  }

  clearNotice(): void {
    if (this.snapshot.notice !== null) this.emit({ notice: null })
  }

  /**
   * Apply a local edit: the draft and Live Preview update immediately. The
   * user decides when to persist it with saveConfig().
   */
  updateConfig(mutate: (draft: PetweenConfig) => void): void {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    mutate(draft)
    this.dirty = true
    this.emit({
      configRevision: this.snapshot.configRevision + 1,
      saveState: this.saveInFlight ? 'saving' : 'dirty',
      saveError: null,
    })
  }

  /** Persist all current editor changes. */
  saveConfig(): Promise<boolean> {
    if (this.snapshot.config === null || this.disposed) return Promise.resolve(false)
    if (!this.dirty && !this.saveInFlight) return Promise.resolve(true)
    this.emit({ saveState: 'saving', saveError: null })
    return this.persistDirty()
  }

  /** Manual retry after a failed save. */
  retrySave(): void {
    void this.saveConfig()
  }

  /**
   * UX: abandon the unsaved draft and return to the last SAVED config.
   *
   * The authoritative state comes from a fresh GET — the hub cache may lag a
   * drag save from another surface — cloned like load() so the draft never
   * aliases anything shared. Only the config draft and the assets map roll
   * back: selectedState and the explicit-save lists (customs/pets) survive.
   * pendingAssetDeletes is cleared: the replaced files are still referenced
   * by the saved config and must never be deleted.
   *
   * A save in flight is awaited first (its PUT may still land on the host;
   * the revert then shows the server's saved state either way). A save
   * queued while the revert's GET is in flight aborts the revert — the newer
   * intent wins and nothing is silently dropped. Plain edits (no save) made
   * during that millisecond-scale GET window ARE discarded by design: the
   * confirm already expressed the revert intent.
   */
  async revertConfig(): Promise<void> {
    if (this.disposed || this.snapshot.config === null) return
    const chainBefore = this.saveChain
    await chainBefore
    if (this.disposed || this.snapshot.config === null) return
    let response: GetConfigResponse
    try {
      response = await this.api.getConfig()
    } catch (error) {
      if (!this.disposed) {
        this.emit({ notice: { kind: 'error', text: `撤回失败：${describeError(error)}` } })
      }
      return
    }
    if (this.disposed) return
    if (this.saveChain !== chainBefore) {
      this.emit({ notice: { kind: 'warn', text: '已取消撤回：期间发起了新的保存。' } })
      return
    }
    this.dirty = false
    this.pendingAssetDeletes.clear()
    this.emit({
      config: structuredClone(response.config),
      assets: { ...response.assets },
      configRevision: this.snapshot.configRevision + 1,
      saveState: 'idle',
      saveError: null,
      notice: { kind: 'info', text: '已撤回未保存的修改。' },
    })
  }

  /**
   * Image (re)import: upload now for local preview, then wait for the user's
   * explicit config save before deleting the replaced asset. The in-flight
   * upload is mirrored on the snapshot (`importing`) so the UI can disable
   * the trigger button and say 上传中… (UX-3).
   */
  async importImage(state: PoseKey, file: File): Promise<void> {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    // One visible import at a time: the newest call owns the `importing` slot;
    // a superseded import still reports its own notice but cannot clear a
    // newer import's flag.
    const seq = ++this.importSeq
    this.emit({ importing: state })
    const finishImport = (patch: Partial<EditorSnapshot>): void => {
      if (this.disposed) return
      // Only the `importing` flag belongs to the newest sequence — its data
      // patches always land (the draft was already mutated by then), or a
      // superseded import would leave snapshot.assets/dirty state behind the
      // draft with no revision bump to heal it.
      if (seq === this.importSeq) this.emit({ importing: null, ...patch })
      else this.emit(patch)
    }
    const mimeType = file.type as AssetMeta['mimeType']
    if (!ACCEPTED_MIME_TYPES.includes(mimeType)) {
      finishImport({ notice: { kind: 'error', text: '仅支持 PNG / WebP / JPEG 图片（SVG 已明确拒绝）。' } })
      return
    }
    if (file.size > MAX_ASSET_BYTES) {
      finishImport({ notice: { kind: 'error', text: '图片超过 10MB 上限，请压缩后再导入。' } })
      return
    }
    if (mimeType === 'image/jpeg') {
      this.emit({ notice: { kind: 'info', text: 'JPEG 图片没有透明背景，建议使用 PNG 或 WebP。' } })
    }

    let uploaded: UploadedAsset
    try {
      uploaded = await this.api.uploadAsset(file)
    } catch (error) {
      finishImport({ notice: { kind: 'error', text: `上传失败：${describeError(error)}` } })
      return
    }
    if (this.disposed || this.snapshot.config === null) return

    const previousAssetId = this.snapshot.config.poses[state].assetId
    const meta: AssetMeta = {
      id: uploaded.id,
      fileName: file.name, // display-only; the on-disk name is host-generated
      mimeType,
      width: uploaded.width,
      height: uploaded.height,
      sizeBytes: file.size,
      sha256: '', // never read client-side and never sent back
      url: uploaded.url,
    }
    this.snapshot.config.poses[state].assetId = uploaded.id
    if (previousAssetId !== undefined && previousAssetId !== uploaded.id) {
      this.pendingAssetDeletes.add(previousAssetId)
    }
    this.dirty = true
    finishImport({
      assets: { ...this.snapshot.assets, [uploaded.id]: meta },
      configRevision: this.snapshot.configRevision + 1,
      saveState: this.saveInFlight ? 'saving' : 'dirty',
      saveError: null,
    })
  }

  /** Clear the pose's image (absent assetId = cleared, host validation), then delete the file if unreferenced. */
  async removeImage(state: PoseKey): Promise<void> {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    const assetId = draft.poses[state].assetId
    if (assetId === undefined) return
    delete draft.poses[state].assetId
    this.pendingAssetDeletes.add(assetId)
    this.dirty = true
    this.emit({
      configRevision: this.snapshot.configRevision + 1,
      saveState: this.saveInFlight ? 'saving' : 'dirty',
      saveError: null,
    })
  }

  /**
   * V1.1 animation library save (plan §3): explicit-write semantics — no
   * config save. The client-side schema check runs first (the host re-validates);
   * the saved list is broadcast through the hub so the overlay re-syncs its
   * registry without waiting for a poll. The config draft is untouched.
   */
  async saveAnimation(definition: AnimationDefinition): Promise<boolean> {
    if (this.disposed || this.snapshot.status !== 'ready') return false
    const check = validateAnimationDefinition(definition)
    if (!check.valid) {
      this.emit({ notice: { kind: 'error', text: `动画定义不合法：${check.errors.join('；')}` } })
      return false
    }
    try {
      await this.api.putAnimation(definition)
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `动画保存失败：${describeError(error)}` } })
      return false
    }
    if (this.disposed) return true
    const customs = this.snapshot.customs.some((custom) => custom.id === definition.id)
      ? this.snapshot.customs.map((custom) => (custom.id === definition.id ? definition : custom))
      : [...this.snapshot.customs, definition]
    this.emit({ customs, notice: { kind: 'info', text: `动画「${definition.name}」已保存。` } })
    this.publishCustoms(customs)
    return true
  }

  /**
   * Delete a custom animation. References are checked against the local draft
   * first (state enter transitions + the click interaction) so the in-use
   * notice can name the offenders; the host re-checks and its 409 maps to the
   * same kind of notice.
   */
  async deleteAnimation(id: string): Promise<boolean> {
    if (this.disposed || this.snapshot.status !== 'ready') return false
    const referencers = this.animationReferencers(id)
    if (referencers.length > 0) {
      this.emit({ notice: { kind: 'error', text: `无法删除：动画仍被 ${referencers.join('、')} 引用。` } })
      return false
    }
    try {
      await this.api.deleteAnimation(id)
    } catch (error) {
      if (this.disposed) return false
      const text =
        error instanceof ApiError && error.code === 'ANIMATION_IN_USE'
          ? '无法删除：动画仍被配置引用（可能在其他页面刚设置）。'
          : `动画删除失败：${describeError(error)}`
      this.emit({ notice: { kind: 'error', text } })
      return false
    }
    if (this.disposed) return true
    const customs = this.snapshot.customs.filter((custom) => custom.id !== id)
    this.emit({ customs, notice: { kind: 'info', text: '动画已删除。' } })
    this.publishCustoms(customs)
    return true
  }

  /**
   * P2 Motion Pack import: read the chosen pack file, hand the raw JSON to
   * the host (it owns validation + the collision policy), then refresh the
   * customs list from the library — an import may add and rewrite many ids
   * at once. The notice summarizes the per-entry outcome; remapped ids are
   * spelled out so the user knows what landed where.
   */
  async importPack(file: File): Promise<boolean> {
    if (this.disposed || this.snapshot.status !== 'ready') return false
    let packJson: string
    try {
      packJson = await file.text()
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `读取动画包文件失败：${describeError(error)}` } })
      return false
    }
    let result: PackImportResponse
    try {
      result = await this.api.importMotionPack(packJson)
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `导入动画包失败：${describeError(error)}` } })
      return false
    }
    if (this.disposed) return true
    await this.refreshCustomsSafely()
    const imported = result.entries.filter((entry) => entry.status === 'imported').length
    const identical = result.entries.filter((entry) => entry.status === 'identical').length
    const remapped = result.entries.filter((entry) => entry.status === 'remapped')
    const parts = [`已导入动画包「${result.name}」：${imported} 新增`]
    if (identical > 0) parts.push(`${identical} 相同跳过`)
    if (remapped.length > 0) {
      parts.push(`${remapped.length} 因重名改号（${remapped.map((entry) => `${entry.requestedId} → ${entry.finalId}`).join('，')}）`)
    }
    this.emit({
      notice: {
        kind: remapped.length > 0 || result.warnings.length > 0 ? 'warn' : 'info',
        text: [...parts, ...result.warnings].join('；'),
      },
    })
    return true
  }

  /**
   * P2 Motion Pack export: bundle every custom animation in the library into
   * one manifest and trigger a browser download. Exports carry no mounts —
   * they are author intent, not the user's live config state.
   */
  async exportPack(): Promise<boolean> {
    if (this.disposed || this.snapshot.status !== 'ready') return false
    const ids = this.snapshot.customs.map((custom) => custom.id)
    if (ids.length === 0) {
      this.emit({ notice: { kind: 'warn', text: '当前没有可导出的自定义动画。' } })
      return false
    }
    let pack: MotionPack
    try {
      pack = await this.api.exportMotionPack(ids)
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `导出动画包失败：${describeError(error)}` } })
      return false
    }
    if (this.disposed) return true
    if (typeof URL?.createObjectURL !== 'function' || typeof document === 'undefined') {
      this.emit({ notice: { kind: 'warn', text: '当前环境不支持自动下载，动画包已生成但未能保存。' } })
      return false
    }
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    try {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `motion-pack-${pack.namespace}.json`
      anchor.click()
    } finally {
      URL.revokeObjectURL(url)
    }
    this.emit({ notice: { kind: 'info', text: `已导出动画包「${pack.name}」（${ids.length} 个动画）。` } })
    return true
  }

  /** Refresh the customs snapshot from the library (import path) + broadcast. */
  private async refreshCustomsSafely(): Promise<void> {
    try {
      const { customs } = await this.api.getAnimations()
      if (this.disposed) return
      this.emit({ customs: structuredClone(customs) })
      this.publishCustoms(this.snapshot.customs)
    } catch (error) {
      if (!this.disposed) console.error('petween: failed to refresh the animation library', error)
    }
  }

  /** Create a named copy of the current character and make it active. */
  createPetCurrent(name: string): Promise<boolean> {
    return this.createPet(name, 'current')
  }

  /** Protect any unsaved character host-side, then create and apply a blank one. */
  createPetBlank(name: string): Promise<boolean> {
    return this.createPet(name, 'blank')
  }

  /**
   * A2 (2026-08-27 拍板 A): snapshot the CURRENT DRAFT — unsaved edits
   * included — into a brand-new preset, leaving the active pet and its draft
   * untouched (no apply, no dirty change, no implicit save). The lossless
   * branch of the variant workflow: experiment freely, fork what is on
   * screen, keep editing the original. Awaits saveChain first so a draft
   * referencing a just-saved config state settles before the fork reads it.
   */
  async saveDraftAsNewPet(name: string): Promise<boolean> {
    const draft = this.snapshot.config
    if (this.disposed || draft === null) return false
    await this.saveChain
    if (this.disposed) return false
    try {
      await this.api.createPetFromDraft(name, {
        scale: draft.global.scale,
        poses: structuredClone(draft.poses),
        states: structuredClone(draft.states),
      })
      if (this.disposed) return true
      await this.refreshPetsSafely()
      return true
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `另存宠物失败：${describeError(error)}` } })
      return false
    }
  }

  private async createPet(name: string, from: 'current' | 'blank'): Promise<boolean> {
    if (!(await this.preparePetAction())) return false
    try {
      const { config } = await this.api.createPet({ name, from })
      if (this.disposed) return true
      this.adoptPetConfig(config)
      await this.refreshPetsSafely()
      return true
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `新建宠物失败：${describeError(error)}` } })
      return false
    }
  }

  async renamePet(id: string, name: string): Promise<boolean> {
    if (!(await this.preparePetAction(id))) return false
    try {
      await this.api.renamePet(id, name)
      if (this.disposed) return true
      await this.refreshPetsSafely()
      return true
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `重命名失败：${describeError(error)}` } })
      return false
    }
  }

  async deletePet(id: string): Promise<boolean> {
    if (!(await this.preparePetAction(id))) return false
    try {
      await this.api.deletePet(id)
      if (this.disposed) return true
      await this.refreshPetsSafely()
      return true
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `删除宠物失败：${describeError(error)}` } })
      return false
    }
  }

  async applyPet(id: string): Promise<boolean> {
    if (this.snapshot.config?.activePetId === id) return true
    if (!(await this.preparePetAction())) return false
    try {
      const config = await this.api.applyPet(id)
      if (this.disposed) return true
      this.adoptPetConfig(config)
      await this.refreshPetsSafely()
      return true
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `切换宠物失败：${describeError(error)}` } })
      return false
    }
  }

  /**
   * Identity changes never save a draft implicitly. Relaxation (UX): rename/
   * delete of a NON-active preset never reads or writes the draft, so those
   * targets skip BOTH the clean requirement and the failed-save gate;
   * switching (apply) and creating still replace the working config and
   * require a clean, successfully-saved draft.
   */
  private async preparePetAction(target?: string): Promise<boolean> {
    if (this.disposed || this.snapshot.config === null) return false
    const touchesActive = target === undefined || target === this.snapshot.config.activePetId
    if (touchesActive && this.dirty) {
      this.emit({ notice: { kind: 'warn', text: '有未保存修改，请先点击保存再操作宠物预设。' } })
      return false
    }
    await this.saveChain
    if (touchesActive && this.snapshot.saveState === 'error') {
      this.emit({ notice: { kind: 'warn', text: '上次保存失败，请先重试保存或撤回修改，再操作宠物预设。' } })
      return false
    }
    return true
  }

  /** Adopt the full config returned by create/apply and publish it immediately. */
  private adoptPetConfig(config: PetweenConfig): void {
    const next = structuredClone(config)
    this.dirty = false
    this.emit({
      config: next,
      configRevision: this.snapshot.configRevision + 1,
      saveState: 'saved',
      saveError: null,
    })
    this.hub?.publish({ config: next, assets: this.snapshot.assets, customs: this.snapshot.customs })
  }

  /** Refresh the list after every pet mutation and synchronize delete-active's null pointer. */
  private async refreshPets(): Promise<void> {
    const { pets, activePetId, warnings } = await this.api.getPets()
    if (this.disposed) return
    const patch: Partial<EditorSnapshot> = { pets: structuredClone(pets) }
    const current = this.snapshot.config
    if (current !== null && current.activePetId !== activePetId) {
      const config = structuredClone(current)
      config.activePetId = activePetId
      patch.config = config
      patch.configRevision = this.snapshot.configRevision + 1
      this.hub?.publish({ config, assets: this.snapshot.assets, customs: this.snapshot.customs })
    }
    if (warnings.length > 0) {
      patch.notice = { kind: 'warn', text: `有 ${warnings.length} 个宠物预设文件损坏或不合法，已被跳过。` }
    }
    this.emit(patch)
  }

  /** A mutation already succeeded if only the follow-up list refresh fails. */
  private async refreshPetsSafely(): Promise<void> {
    try {
      await this.refreshPets()
    } catch (error) {
      if (!this.disposed) {
        this.emit({ notice: { kind: 'warn', text: `宠物已更新，但列表刷新失败：${describeError(error)}` } })
      }
    }
  }

  /** States (and the click interaction) referencing the animation, as display labels. */
  private animationReferencers(id: string): string[] {
    const config = this.snapshot.config
    if (config === null) return []
    const labels = POSE_KEYS.filter((key) => config.states[key].enter.animationId === id).map(
      (key) => `「${STATE_LABELS[key]}」状态`,
    )
    labels.push(
      ...POSE_KEYS.filter((key) => config.states[key].ambient.customAnimationId === id).map(
        (key) => `「${STATE_LABELS[key]}」状态循环动画`,
      ),
    )
    if (config.interactions.click.animation === id) labels.push('点击互动')
    return labels
  }

  /** Broadcast a customs-only change; config/assets stay at the hub's version. */
  private publishCustoms(customs: AnimationDefinition[]): void {
    if (this.hub === undefined) return
    const current = this.hub.getCurrent()
    if (current === null) return
    this.hub.publish({ config: current.config, assets: current.assets, customs })
  }

  /** Unsaved drafts remain unsaved when the editor closes. */
  dispose(): void {
    if (this.disposed) return
    this.unsubscribeHub?.()
    this.hub?.stopPolling(this)
    this.disposed = true
  }

  /** Serialized writes: at most one PUT in flight; resolves false on failure. */
  private persistDirty(): Promise<boolean> {
    const result = this.saveChain.then(() => this.writeLoop())
    this.saveChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async writeLoop(): Promise<boolean> {
    let savedConfig: PetweenConfig | null = null
    this.saveInFlight = true
    while (this.dirty && this.snapshot.config !== null) {
      this.dirty = false
      // Ownership split (P1): the editor owns enabled/global/poses/states/
      // advanced/interactions; the overlay owns overlay.x/y. Only the owned
      // sections travel — no overlay, no version — so the host merges onto
      // its current config and a drag-save made while this draft was dirty
      // survives the save.
      const draft = this.snapshot.config
      // Optional animation references use null as the explicit clear marker;
      // omission means "keep the host's current value" in patch semantics.
      const states = Object.fromEntries(
        POSE_KEYS.map((key) => {
          const state = draft.states[key]
          return [
            key,
            {
              ...structuredClone(state),
              enter: { ...structuredClone(state.enter), animationId: state.enter.animationId ?? null },
              ambient: {
                ...structuredClone(state.ambient),
                customAnimationId: state.ambient.customAnimationId ?? null,
              },
            },
          ]
        }),
      ) as unknown as PetweenConfig['states']
      const payload: ConfigPatch = {
        enabled: draft.enabled,
        global: structuredClone(draft.global),
        poses: structuredClone(draft.poses),
        states,
        advanced: structuredClone(draft.advanced),
        interactions: structuredClone(draft.interactions),
      }
      try {
        // The host response is authoritative: it carries the merged overlay.
        savedConfig = await this.api.patchConfig(payload)
      } catch (error) {
        this.dirty = true
        this.saveInFlight = false
        if (!this.disposed) this.emit({ saveState: 'error', saveError: describeError(error) })
        return false
      }
    }
    this.saveInFlight = false
    // Broadcast the saved config so the overlay updates without a poll (M3).
    if (savedConfig !== null) {
      this.hub?.publish({ config: savedConfig, assets: this.snapshot.assets, customs: this.snapshot.customs })
      await this.cleanupReplacedAssets()
    }
    // cleanupReplacedAssets is a real await window: edits that landed there
    // (dirty=true) must not be overwritten with 'saved' — that would disable
    // the save button and drop the beforeunload guard while work is unsaved.
    if (!this.disposed) this.emit({ saveState: this.dirty ? 'dirty' : 'saved', saveError: null })
    return true
  }

  /** Delete assets made unreachable by a successful explicit save. */
  private async cleanupReplacedAssets(): Promise<void> {
    const config = this.snapshot.config
    if (config === null) return
    const referenced = new Set(POSE_KEYS.map((key) => config.poses[key].assetId).filter((id): id is string => id !== undefined))
    for (const assetId of [...this.pendingAssetDeletes]) {
      if (referenced.has(assetId)) continue
      try {
        await this.api.deleteAsset(assetId)
        this.pendingAssetDeletes.delete(assetId)
        if (this.disposed) continue
        const assets = { ...this.snapshot.assets }
        delete assets[assetId]
        this.emit({ assets, configRevision: this.snapshot.configRevision + 1 })
      } catch (error) {
        if (error instanceof ApiError && (error.code === 'ASSET_IN_USE' || error.code === 'NOT_FOUND')) {
          this.pendingAssetDeletes.delete(assetId)
          continue
        }
        if (!this.disposed) this.emit({ notice: { kind: 'warn', text: `旧图片文件清理失败：${describeError(error)}` } })
      }
    }
  }
}
