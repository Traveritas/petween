/**
 * client/stores/editor-store.ts — the settings editor state machine (spec
 * §17, §21). Pure TS with a subscribe/getSnapshot pair so React components
 * read it through useSyncExternalStore; nothing here imports React or DSH.
 *
 * Save discipline (§21): updateConfig mutates the local draft immediately
 * (the Live Preview follows via configRevision), then a 300ms debounce sends
 * the editor-owned sections (enabled/global/poses/states/advanced/interactions
 * — never overlay, never version) as a patch PUT; the host merges them onto its
 * current config, so a drag-save landing while the draft was dirty cannot be
 * rolled back by the later editor write. Writes serialize through a promise
 * chain; edits landing while a PUT is in flight re-flag the draft dirty and
 * are flushed right after it (latest-wins). Asset flows (§19.4) bypass the
 * debounce: upload → await the config write → delete the old asset (delete
 * failures only warn). Custom animations (V1.1) are explicit-save too:
 * saveAnimation/deleteAnimation hit the API immediately and broadcast the
 * customs list through the hub; they never touch the config draft.
 */
import type { AssetMeta, MotionPetConfig, PoseKey } from '../../core/types'
import { POSE_KEYS } from '../../core/types'
import type { AnimationDefinition } from '../../motion/animation-definition'
import { validateAnimationDefinition } from '../../motion/animation-definition'
import {
  deleteAnimation as httpDeleteAnimation,
  deleteAsset as httpDeleteAsset,
  getAnimations as httpGetAnimations,
  getConfig as httpGetConfig,
  patchConfig as httpPatchConfig,
  putAnimation as httpPutAnimation,
  uploadAsset as httpUploadAsset,
  ApiError,
  type ConfigPatch,
  type GetAnimationsResponse,
  type GetConfigResponse,
  type UploadedAsset,
} from '../api'
import type { ConfigHub, ConfigSnapshot } from '../config-hub'

/** Client-side mirror of the host upload rules (spec §20; host re-validates). */
const ACCEPTED_MIME_TYPES: ReadonlyArray<AssetMeta['mimeType']> = ['image/png', 'image/webp', 'image/jpeg']
const MAX_ASSET_BYTES = 10 * 1024 * 1024
/** §21: debounce window for coalescing edits into one PUT. */
const DEFAULT_DEBOUNCE_MS = 300

/** Display labels for the delete-in-use notice; mirrors StateList.STATE_LABELS. */
const POSE_LABELS: Record<PoseKey, string> = {
  idle: '待机',
  thinking: '思考',
  working: '工作',
  waiting: '等待',
  success: '成功',
  error: '错误',
}

/** The API surface the store needs; the default adapter hits the real HTTP API. */
export interface EditorApi {
  getConfig(): Promise<GetConfigResponse>
  /** V1.1: custom animations + host scan warnings (fetched in parallel with the config). */
  getAnimations(): Promise<GetAnimationsResponse>
  /** Patch PUT of the editor-owned sections; resolves the host-merged full config. */
  patchConfig(patch: ConfigPatch): Promise<MotionPetConfig>
  /** Explicit-save custom animation write (no debounce — plan §3/P0). */
  putAnimation(definition: AnimationDefinition): Promise<void>
  deleteAnimation(id: string): Promise<void>
  uploadAsset(file: File): Promise<UploadedAsset>
  deleteAsset(id: string): Promise<void>
}

const httpEditorApi: EditorApi = {
  getConfig: () => httpGetConfig(),
  getAnimations: () => httpGetAnimations(),
  patchConfig: async (patch) => (await httpPatchConfig(patch)).config,
  putAnimation: async (definition) => {
    await httpPutAnimation(definition)
  },
  deleteAnimation: async (id) => {
    await httpDeleteAnimation(id)
  },
  uploadAsset: async (file) => (await httpUploadAsset(file)).asset,
  deleteAsset: async (id) => {
    await httpDeleteAsset(id)
  },
}

export type EditorStatus = 'loading' | 'ready' | 'error'
export type SaveState = 'idle' | 'saving' | 'saved' | 'error'
export type NoticeKind = 'info' | 'warn' | 'error'

export interface EditorNotice {
  kind: NoticeKind
  text: string
}

export interface EditorSnapshot {
  status: EditorStatus
  /** The local draft; mutated in place, every mutation bumps configRevision. */
  config: MotionPetConfig | null
  assets: Record<string, AssetMeta>
  /** V1.1 custom animations (explicit-save; never part of the config debounce). */
  customs: AnimationDefinition[]
  selectedState: PoseKey
  saveState: SaveState
  loadError: string | null
  saveError: string | null
  notice: EditorNotice | null
  /** Bumped only when config/assets content changes — drives the Live Preview sync. */
  configRevision: number
}

export interface EditorStoreOptions {
  api?: EditorApi
  debounceMs?: number
  /**
   * M3 shared config hub: when present, load() reuses the hub's single GET,
   * successful saves are broadcast to the overlay instantly, and external
   * publishes are adopted — unless the draft is dirty (unsaved edits are
   * never rolled back by a poll). Tests omit the hub and keep the api path.
   */
  hub?: ConfigHub
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** §2.1 gate: at least one pose references an asset that actually exists. */
export function hasAnyUsableImage(config: MotionPetConfig, assets: Record<string, AssetMeta>): boolean {
  return POSE_KEYS.some((key) => {
    const assetId = config.poses[key].assetId
    return assetId !== undefined && assets[assetId] !== undefined
  })
}

export class EditorStore {
  private readonly api: EditorApi
  private readonly debounceMs: number
  private readonly hub: ConfigHub | undefined
  private readonly unsubscribeHub: (() => void) | null = null
  private readonly listeners = new Set<() => void>()
  private snapshot: EditorSnapshot

  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saveChain: Promise<void> = Promise.resolve()
  private dirty = false
  private disposed = false

  constructor(options: EditorStoreOptions = {}) {
    this.api = options.api ?? httpEditorApi
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.hub = options.hub
    this.snapshot = {
      status: 'loading',
      config: null,
      assets: {},
      customs: [],
      selectedState: 'idle',
      saveState: 'idle',
      loadError: null,
      saveError: null,
      notice: null,
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
      let config: MotionPetConfig
      let assets: Record<string, AssetMeta>
      let customs: AnimationDefinition[]
      let animationWarnings: string[]
      if (this.hub !== undefined) {
        ;({ config, assets, customs } = await this.hub.load())
        animationWarnings = this.hub.getAnimationWarnings()
      } else {
        const [configResponse, animationsResponse] = await Promise.all([this.api.getConfig(), this.api.getAnimations()])
        ;({ config, assets } = configResponse)
        ;({ customs, warnings: animationWarnings } = animationsResponse)
      }
      if (this.disposed) return
      // Clone from the hub cache: the draft is mutated in place by edits and
      // must never alias the shared snapshot.
      this.emit({
        status: 'ready',
        config: structuredClone(config),
        assets: { ...assets },
        customs: structuredClone(customs),
        // Corrupt animation files were skipped host-side (plan §3): say so once.
        notice:
          animationWarnings.length > 0
            ? { kind: 'warn', text: `有 ${animationWarnings.length} 个自定义动画文件损坏或不合法，已被跳过。` }
            : null,
      })
    } catch (error) {
      if (this.disposed) return
      this.emit({ status: 'error', loadError: describeError(error) })
    }
  }

  /**
   * M3 rollback guard: adopt a hub publish (overlay drag save, another tab's
   * poll) only while the local draft is clean; a dirty draft is the user's
   * in-progress edit and must win. Identical content (e.g. the echo of our
   * own save) is skipped without bumping configRevision. Customs are
   * explicit-save data outside the debounce — they always follow the hub.
   */
  private adoptPublished(published: ConfigSnapshot): void {
    if (this.disposed || this.snapshot.status !== 'ready') return
    const patch: Partial<EditorSnapshot> = {}
    if (JSON.stringify(this.snapshot.customs) !== JSON.stringify(published.customs)) {
      patch.customs = structuredClone(published.customs)
    }
    const current = this.snapshot.config
    if (!this.dirty && current !== null) {
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
   * Apply a local edit: the draft updates immediately (Live Preview follows
   * via configRevision), the PUT is debounced (§21 — never one write per
   * input event).
   */
  updateConfig(mutate: (draft: MotionPetConfig) => void): void {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    mutate(draft)
    this.emit({
      configRevision: this.snapshot.configRevision + 1,
      saveState: 'saving',
      saveError: null,
    })
    this.scheduleSave()
  }

  /** Manual retry after a failed save (the save indicator offers it). */
  retrySave(): void {
    if (this.snapshot.config === null || this.disposed) return
    this.emit({ saveState: 'saving', saveError: null })
    this.scheduleSave()
  }

  /**
   * §19.4 image (re)import: upload the new asset, point the pose at it, PUT,
   * and only then delete the replaced asset. The PUT is awaited (the debounce
   * is bypassed) so the DELETE can never race ahead of the config reference;
   * a failed DELETE only warns.
   */
  async importImage(state: PoseKey, file: File): Promise<void> {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    const mimeType = file.type as AssetMeta['mimeType']
    if (!ACCEPTED_MIME_TYPES.includes(mimeType)) {
      this.emit({ notice: { kind: 'error', text: '仅支持 PNG / WebP / JPEG 图片（SVG 已明确拒绝）。' } })
      return
    }
    if (file.size > MAX_ASSET_BYTES) {
      this.emit({ notice: { kind: 'error', text: '图片超过 10MB 上限，请压缩后再导入。' } })
      return
    }
    if (mimeType === 'image/jpeg') {
      this.emit({ notice: { kind: 'info', text: 'JPEG 图片没有透明背景，建议使用 PNG 或 WebP。' } })
    }

    let uploaded: UploadedAsset
    try {
      uploaded = await this.api.uploadAsset(file)
    } catch (error) {
      if (!this.disposed) this.emit({ notice: { kind: 'error', text: `上传失败：${describeError(error)}` } })
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
    this.emit({
      assets: { ...this.snapshot.assets, [uploaded.id]: meta },
      configRevision: this.snapshot.configRevision + 1,
      saveState: 'saving',
      saveError: null,
    })
    this.scheduleSave()

    const saved = await this.persistNow()
    if (!saved || previousAssetId === undefined || previousAssetId === uploaded.id) return
    try {
      await this.api.deleteAsset(previousAssetId)
      if (this.disposed) return
      const rest = { ...this.snapshot.assets }
      delete rest[previousAssetId]
      this.emit({ assets: rest, configRevision: this.snapshot.configRevision + 1 })
    } catch (error) {
      // 409 ASSET_IN_USE: another pose still references it — keep it locally.
      if (error instanceof ApiError && error.code === 'ASSET_IN_USE') return
      if (!this.disposed) {
        this.emit({ notice: { kind: 'warn', text: `旧图片文件清理失败：${describeError(error)}` } })
      }
    }
  }

  /** Clear the pose's image (absent assetId = cleared, host validation), then delete the file if unreferenced. */
  async removeImage(state: PoseKey): Promise<void> {
    const draft = this.snapshot.config
    if (draft === null || this.disposed) return
    const assetId = draft.poses[state].assetId
    if (assetId === undefined) return
    delete draft.poses[state].assetId
    this.emit({ configRevision: this.snapshot.configRevision + 1, saveState: 'saving', saveError: null })
    this.scheduleSave()

    const saved = await this.persistNow()
    if (!saved || this.disposed || this.snapshot.config === null) return
    const stillReferenced = POSE_KEYS.some((key) => this.snapshot.config?.poses[key].assetId === assetId)
    if (stillReferenced) return
    try {
      await this.api.deleteAsset(assetId)
      if (this.disposed) return
      const rest = { ...this.snapshot.assets }
      delete rest[assetId]
      this.emit({ assets: rest, configRevision: this.snapshot.configRevision + 1 })
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'ASSET_IN_USE' || error.code === 'NOT_FOUND')) return
      if (!this.disposed) {
        this.emit({ notice: { kind: 'warn', text: `图片文件清理失败：${describeError(error)}` } })
      }
    }
  }

  /**
   * V1.1 animation library save (plan §3): explicit-write semantics — no
   * debounce. The client-side schema check runs first (the host re-validates);
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

  /** States (and the click interaction) referencing the animation, as display labels. */
  private animationReferencers(id: string): string[] {
    const config = this.snapshot.config
    if (config === null) return []
    const labels = POSE_KEYS.filter((key) => config.states[key].enter.animationId === id).map(
      (key) => `「${POSE_LABELS[key]}」状态`,
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

  /** Cancel the pending debounce; a dirty draft gets one final best-effort write. */
  dispose(): void {
    if (this.disposed) return
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.unsubscribeHub?.()
    this.disposed = true
    if (this.dirty) void this.persistDirty()
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.persistDirty()
    }, this.debounceMs)
  }

  /** Skip the debounce and persist now (asset flows must order PUT before DELETE). */
  private persistNow(): Promise<boolean> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = true
    return this.persistDirty()
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
    let savedConfig: MotionPetConfig | null = null
    while (this.dirty && this.snapshot.config !== null) {
      this.dirty = false
      // Ownership split (P1): the editor owns enabled/global/poses/states/
      // advanced/interactions; the overlay owns overlay.x/y. Only the owned
      // sections travel — no overlay, no version — so the host merges onto
      // its current config and a drag-save made while this draft was dirty
      // survives the save.
      const draft = this.snapshot.config
      const payload: ConfigPatch = {
        enabled: draft.enabled,
        global: structuredClone(draft.global),
        poses: structuredClone(draft.poses),
        states: structuredClone(draft.states),
        advanced: structuredClone(draft.advanced),
        interactions: structuredClone(draft.interactions),
      }
      try {
        // The host response is authoritative: it carries the merged overlay.
        savedConfig = await this.api.patchConfig(payload)
      } catch (error) {
        if (!this.disposed) this.emit({ saveState: 'error', saveError: describeError(error) })
        return false
      }
    }
    // Broadcast the saved config so the overlay updates without a poll (M3).
    if (savedConfig !== null) {
      this.hub?.publish({ config: savedConfig, assets: this.snapshot.assets, customs: this.snapshot.customs })
    }
    if (!this.disposed) this.emit({ saveState: 'saved', saveError: null })
    return true
  }
}
