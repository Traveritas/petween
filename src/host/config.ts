/**
 * host/config.ts — config.json persistence (spec §18).
 *
 * `loadConfig` is the single migration entry (§18.3): every version branch
 * lives here, never scattered into UI. Today there is only v1 — anything
 * unrecognized is repaired field-wise onto v1 defaults; a future v1 → v2
 * migration chains in ahead of the repair pass.
 */
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { MotionPetConfig } from '../core/types'
import { readJsonFile, writeJsonAtomic } from './storage'
import { repairConfig, validateConfigPatch, type ConfigValidationOptions } from './validation'

export function defaultConfigPath(): string {
  return dshHomePath('motion-pet', 'config.json')
}

/** Migration entry (spec §18.3): validate + defaults + version handling. */
export function loadConfig(raw: unknown, options: ConfigValidationOptions = {}): MotionPetConfig {
  return repairConfig(raw, options)
}

export interface ConfigStoreOptions {
  /** Defaults to `$DSH_HOME/motion-pet/config.json` (spec §18.1). */
  configPath?: string
  /** Custom-animation existence check for states.*.enter.animationId (V1.1). */
  animationExists?: (id: string) => boolean
}

export class ConfigStore {
  readonly configPath: string
  private readonly animationExists?: (id: string) => boolean
  /** Serializes update() so concurrent writes never lose each other's fields. */
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(options: ConfigStoreOptions = {}) {
    this.configPath = options.configPath ?? defaultConfigPath()
    this.animationExists = options.animationExists
  }

  /** Load + repair; defaults when the file is missing or corrupt. */
  async load(): Promise<MotionPetConfig> {
    return loadConfig(await readJsonFile(this.configPath), { animationExists: this.animationExists })
  }

  /** Atomic save (temp + fsync + rename, see host/storage.ts). */
  async save(config: MotionPetConfig): Promise<void> {
    await writeJsonAtomic(this.configPath, config)
  }

  /**
   * Serialized read-merge-write (§19.2): the patch is strictly validated
   * against the CURRENT on-disk config and atomically saved, as one unit per
   * caller. Concurrent PUTs queue behind each other, so two writers patching
   * different fields both land instead of the later one clobbering the first.
   */
  update(patch: unknown): Promise<MotionPetConfig> {
    const run = this.writeChain.then(async () => {
      const config = validateConfigPatch(patch, await this.load(), { animationExists: this.animationExists })
      await this.save(config)
      return config
    })
    // A failed update (invalid patch, disk error) must not poison the queue.
    this.writeChain = run.catch(() => undefined)
    return run
  }
}
