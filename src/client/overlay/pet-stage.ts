/**
 * client/overlay/pet-stage.ts — the PetStage: the MotionStage implementation
 * that owns the layered DOM (spec §3.4), pose image swapping and preload
 * (§16.3), anchor alignment (§12), user scale and viewport position (§27).
 *
 * The stage contains NO animation logic: all motion is written by the
 * Timeline Engine onto the four exposed layers (transition/sway/bounce/
 * breathe) via WAAPI. The stage itself only ever writes the layers it owns:
 * position, user-scale, stage (anchor offsets) and the pose <img>.
 *
 * DOM (each motion layer's box coincides with the stage square, so a
 * percentage transform-origin points at the same world anchor on all of them):
 *
 *   position → user-scale → sway → bounce → breathe → transition → stage → img
 *
 * The stage layer also holds a particle layer above the img (`.dsh-motion-pet-
 * particles`, §8.5 `particle` events) — not a transform-ownership layer; only
 * the ParticleEmitter writes into it.
 *
 * The position layer is viewport-fixed by default (§27, the shell.overlay
 * mode); with `embedded: true` it becomes an absolutely positioned square
 * centered in the host container (the settings Live Preview), and the
 * position APIs (setPosition/setDefaultPosition) do not apply there.
 */
import { DEFAULT_POSE_ANCHOR, type PoseAnchor, type ResolvedPose } from '../../core/types'
import { clamp } from '../../motion/math'
import type { MotionLayer } from '../../motion/motion-properties'
import type { MotionStage } from '../../motion/motion-stage'
import { ParticleEmitter } from './particles'

export const DEFAULT_STAGE_SIZE = 160
/** World anchor: the fixed stage-space point every pose anchor aligns to (§12.3). */
export const DEFAULT_WORLD_ANCHOR: PoseAnchor = { x: 0.5, y: 0.9 }
/** §27: at least this much of the pet must stay inside the viewport. */
export const MIN_VISIBLE_PX = 32
/** §27: the default (never dragged) corner offset from the viewport edges. */
export const DEFAULT_OVERLAY_MARGIN = 24

export interface PetStageOptions {
  /** Stage square side in px (image is contain-fitted into it). */
  size?: number
  worldAnchor?: PoseAnchor
  reducedMotion?: boolean
  /** advanced.particles: false = particle events are dropped. Default true. */
  particles?: boolean
  /**
   * false (default): the position layer is viewport-fixed (shell.overlay).
   * true: absolutely positioned and centered inside the host container
   * (settings Live Preview) — no !important override hacks needed.
   */
  embedded?: boolean
}

/** The computed <img> box inside the stage square (all px). */
export interface AnchorLayout {
  width: number
  height: number
  offsetX: number
  offsetY: number
}

/**
 * §12.3 anchor math: contain-fit the image into the stage square, apply zoom,
 * then offset the image so the pose anchor point lands exactly on the world
 * anchor point. Unknown image size (not loaded yet) degrades to a centered
 * stage fill — the pose anchor cannot be mapped without dimensions.
 */
export function computeAnchorLayout(options: {
  stageSize: number
  worldAnchor: PoseAnchor
  poseAnchor: PoseAnchor
  zoom: number
  naturalWidth: number
  naturalHeight: number
}): AnchorLayout {
  const { stageSize, worldAnchor, poseAnchor, zoom, naturalWidth, naturalHeight } = options
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
    return { width: stageSize, height: stageSize, offsetX: 0, offsetY: 0 }
  }
  const fit = Math.min(stageSize / naturalWidth, stageSize / naturalHeight)
  const width = naturalWidth * fit * zoom
  const height = naturalHeight * fit * zoom
  return {
    width,
    height,
    offsetX: worldAnchor.x * stageSize - poseAnchor.x * width,
    offsetY: worldAnchor.y * stageSize - poseAnchor.y * height,
  }
}

/** Keep inline style values short and stable across floating-point noise. */
function px(value: number): string {
  return `${Math.round(value * 100) / 100}px`
}

/**
 * §27 viewport clamp: the stage square may partly leave the viewport, but at
 * least MIN_VISIBLE_PX of it always stays reachable (drag + resize policy).
 */
export function clampStagePosition(
  x: number,
  y: number,
  size: number,
  viewportWidth: number,
  viewportHeight: number,
): { x: number; y: number } {
  const min = -(size - MIN_VISIBLE_PX)
  return {
    x: clamp(x, min, Math.max(MIN_VISIBLE_PX, viewportWidth - MIN_VISIBLE_PX)),
    y: clamp(y, min, Math.max(MIN_VISIBLE_PX, viewportHeight - MIN_VISIBLE_PX)),
  }
}

function div(className: string): HTMLDivElement {
  const element = document.createElement('div')
  element.className = className
  return element
}

export class PetStage implements MotionStage {
  /** The four layers the Motion Engine may animate (spec §3.4). */
  readonly layers: Record<MotionLayer, HTMLElement>

  private readonly root: HTMLDivElement
  private readonly userScaleLayer: HTMLDivElement
  private readonly stageLayer: HTMLDivElement
  private readonly image: HTMLImageElement
  private readonly particleLayer: HTMLDivElement
  private readonly particles: ParticleEmitter
  private readonly anchorMarker: HTMLDivElement
  private readonly preloaded = new Set<string>()

  private size: number
  private worldAnchor: PoseAnchor
  private reducedMotionValue: boolean
  private readonly embedded: boolean
  private pose: ResolvedPose | null = null
  private disposed = false

  constructor(options: PetStageOptions = {}) {
    this.size = options.size ?? DEFAULT_STAGE_SIZE
    this.worldAnchor = { ...(options.worldAnchor ?? DEFAULT_WORLD_ANCHOR) }
    this.reducedMotionValue = options.reducedMotion ?? false
    this.embedded = options.embedded ?? false

    this.root = div('dsh-motion-pet-position')
    this.userScaleLayer = div('dsh-motion-pet-user-scale')
    const sway = div('dsh-motion-pet-sway')
    const bounce = div('dsh-motion-pet-bounce')
    const breathe = div('dsh-motion-pet-breathe')
    const transition = div('dsh-motion-pet-transition')
    this.stageLayer = div('dsh-motion-pet-stage')
    this.image = document.createElement('img')
    this.image.className = 'dsh-motion-pet-pose'
    this.layers = { transition, sway, bounce, breathe }

    this.root.append(this.userScaleLayer)
    this.userScaleLayer.append(sway)
    sway.append(bounce)
    bounce.append(breathe)
    breathe.append(transition)
    transition.append(this.stageLayer)
    this.stageLayer.append(this.image)
    this.particleLayer = div('dsh-motion-pet-particles')
    this.stageLayer.append(this.particleLayer)
    this.particles = new ParticleEmitter(this.particleLayer, {
      enabled: options.particles ?? true,
      reducedMotion: this.reducedMotionValue,
    })
    this.anchorMarker = this.buildAnchorMarker()
    this.stageLayer.append(this.anchorMarker)

    this.applyBaseStyles()
    // If asset metadata lacked dimensions, the first real load refines the layout.
    this.image.addEventListener('load', this.handleImageLoad)
  }

  /** The outermost element (position layer); append it to a host container. */
  get element(): HTMLDivElement {
    return this.root
  }

  get reducedMotion(): boolean {
    return this.reducedMotionValue
  }

  /**
   * Effective reduced-motion flag, computed by the outer layer from config +
   * (prefers-reduced-motion). The stage never subscribes to media queries.
   */
  setReducedMotion(value: boolean): void {
    this.reducedMotionValue = value
    this.particles.setReducedMotion(value)
  }

  /** advanced.particles config switch; false = particle events are dropped. */
  setParticlesEnabled(value: boolean): void {
    this.particles.setEnabled(value)
  }

  /** MotionStage contract: fire a particle burst for a `particle` event. */
  emitParticle(effect: string): void {
    if (this.disposed) return
    this.particles.emit(effect)
  }

  get currentPose(): ResolvedPose | null {
    return this.pose
  }

  get stageSize(): number {
    return this.size
  }

  /** Synchronous image swap (MotionStage contract): the caller preloaded it. */
  swapPose(pose: ResolvedPose): void {
    if (this.disposed) return
    this.pose = pose
    if (this.image.getAttribute('src') !== pose.asset.url) {
      this.image.src = pose.asset.url
    }
    this.layoutPose()
  }

  /**
   * §16.3: warm the browser cache for every pose before transitions run.
   * Individual failures are swallowed — an image that cannot be decoded is
   * simply not preloaded; swapPose still works (with a possible flash). Only
   * a verified load marks the URL, so a later preload retries a failure
   * instead of skipping it forever.
   */
  async preload(poses: ResolvedPose[]): Promise<void> {
    const pending = poses.map(async (pose) => {
      const url = pose.asset.url
      if (this.preloaded.has(url)) return
      const image = new Image()
      try {
        if (typeof image.decode === 'function') {
          image.src = url
          await image.decode()
        } else {
          await new Promise<void>((resolve, reject) => {
            image.onload = () => resolve()
            image.onerror = () => reject(new Error(`failed to preload ${url}`))
            image.src = url
          })
        }
      } catch {
        return // not marked: the next preload attempt retries this URL
      }
      this.preloaded.add(url)
    })
    await Promise.all(pending)
  }

  /** User scale around the world anchor, so the pet grows from the ground. */
  setUserScale(scale: number): void {
    if (!(scale > 0)) return
    this.userScaleLayer.style.transform = `scale(${scale})`
  }

  /**
   * Viewport position of the stage square's top-left corner (§27). Clamped so
   * at least MIN_VISIBLE_PX of the pet always stays inside the viewport.
   * Switches the layer from the default corner anchor to absolute left/top.
   * Overlay (fixed) mode only — embedded stages are host-centered.
   */
  setPosition(x: number, y: number): void {
    const { x: clampedX, y: clampedY } = clampStagePosition(
      x,
      y,
      this.size,
      window.innerWidth,
      window.innerHeight,
    )
    const style = this.root.style
    style.right = 'auto'
    style.bottom = 'auto'
    style.left = px(clampedX)
    style.top = px(clampedY)
  }

  /** §27: pin to the bottom-right viewport corner until the first drag. */
  setDefaultPosition(): void {
    const style = this.root.style
    style.left = 'auto'
    style.top = 'auto'
    style.right = px(DEFAULT_OVERLAY_MARGIN)
    style.bottom = px(DEFAULT_OVERLAY_MARGIN)
  }

  /** The interactive pet body (§2.1: the only layer with pointer-events:auto). */
  get interactiveElement(): HTMLElement {
    return this.stageLayer
  }

  /** Anchor crosshair at the world anchor (editor preview aid, §17.2). */
  setAnchorMarkerVisible(visible: boolean): void {
    this.anchorMarker.style.display = visible ? 'block' : 'none'
  }

  /** Resizes the stage square and re-runs the anchor layout. */
  setSize(size: number): void {
    if (!(size > 0) || size === this.size) return
    this.size = size
    this.root.style.width = px(size)
    this.root.style.height = px(size)
    this.layoutPose()
  }

  /** Removes the DOM and drops references. In-flight animations are NOT the
   *  stage's concern — the MotionDirector owner must cancel them (§23). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.image.removeEventListener('load', this.handleImageLoad)
    this.particles.dispose()
    this.root.remove()
    this.pose = null
    this.preloaded.clear()
  }

  private readonly handleImageLoad = (): void => {
    this.layoutPose()
  }

  private buildAnchorMarker(): HTMLDivElement {
    const marker = div('dsh-motion-pet-anchor-marker')
    const horizontal = div('dsh-motion-pet-anchor-marker-h')
    const vertical = div('dsh-motion-pet-anchor-marker-v')
    marker.append(horizontal, vertical)
    return marker
  }

  private applyBaseStyles(): void {
    const origin = `${this.worldAnchor.x * 100}% ${this.worldAnchor.y * 100}%`

    const rootStyle = this.root.style
    if (this.embedded) {
      // Embedded host (settings Live Preview): center the square in the host
      // box — absolute + inset:0 + margin:auto centers a fixed-size element.
      rootStyle.position = 'absolute'
      rootStyle.inset = '0'
      rootStyle.margin = 'auto'
    } else {
      rootStyle.position = 'fixed' // shell.overlay: viewport-positioned (§27)
    }
    rootStyle.width = px(this.size)
    rootStyle.height = px(this.size)
    rootStyle.pointerEvents = 'none' // §2.1: only the pet body is interactive

    const full = (element: HTMLElement): CSSStyleDeclaration => {
      const style = element.style
      style.width = '100%'
      style.height = '100%'
      style.transformOrigin = origin
      style.pointerEvents = 'none'
      return style
    }

    this.userScaleLayer.style.width = '100%'
    this.userScaleLayer.style.height = '100%'
    this.userScaleLayer.style.transformOrigin = origin
    this.userScaleLayer.style.pointerEvents = 'none'

    full(this.layers.sway)
    full(this.layers.bounce)
    full(this.layers.breathe)
    full(this.layers.transition)

    const stageStyle = this.stageLayer.style
    stageStyle.position = 'relative'
    stageStyle.width = '100%'
    stageStyle.height = '100%'
    stageStyle.transformOrigin = origin // §12.4: squash around the world anchor
    stageStyle.pointerEvents = 'auto'
    stageStyle.touchAction = 'none' // §28: pointer dragging must not scroll the page
    stageStyle.cursor = 'grab'

    const imageStyle = this.image.style
    imageStyle.position = 'absolute'
    imageStyle.objectFit = 'contain'
    imageStyle.userSelect = 'none'
    ;(imageStyle as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none'
    this.image.draggable = false
    this.image.alt = ''

    // Particle layer: above the pose image, never interactive, bursts may
    // overshoot the stage square (overflow visible).
    const particleStyle = this.particleLayer.style
    particleStyle.position = 'absolute'
    particleStyle.left = '0'
    particleStyle.top = '0'
    particleStyle.right = '0'
    particleStyle.bottom = '0'
    particleStyle.overflow = 'visible'
    particleStyle.pointerEvents = 'none'

    const markerStyle = this.anchorMarker.style
    markerStyle.position = 'absolute'
    markerStyle.left = `${this.worldAnchor.x * 100}%`
    markerStyle.top = `${this.worldAnchor.y * 100}%`
    markerStyle.width = '0'
    markerStyle.height = '0'
    markerStyle.display = 'none'
    markerStyle.pointerEvents = 'none'
    for (const line of [this.anchorMarker.children[0], this.anchorMarker.children[1]] as HTMLElement[]) {
      const lineStyle = line.style
      lineStyle.position = 'absolute'
      lineStyle.background = 'rgba(255, 64, 64, 0.9)'
      lineStyle.pointerEvents = 'none'
    }
    const [horizontal, vertical] = [this.anchorMarker.children[0] as HTMLElement, this.anchorMarker.children[1] as HTMLElement]
    Object.assign(horizontal.style, { left: '-7px', top: '-0.5px', width: '15px', height: '1px' })
    Object.assign(vertical.style, { left: '-0.5px', top: '-7px', width: '1px', height: '15px' })
  }

  /** Recompute the img box from the current pose's anchor/zoom (§12.3). */
  private layoutPose(): void {
    const pose = this.pose
    if (pose === null || this.disposed) return
    let { width: naturalWidth, height: naturalHeight } = pose.asset
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) {
      naturalWidth = this.image.naturalWidth
      naturalHeight = this.image.naturalHeight
    }
    const layout = computeAnchorLayout({
      stageSize: this.size,
      worldAnchor: this.worldAnchor,
      poseAnchor: pose.anchor ?? DEFAULT_POSE_ANCHOR,
      zoom: pose.zoom,
      naturalWidth,
      naturalHeight,
    })
    const style = this.image.style
    style.width = px(layout.width)
    style.height = px(layout.height)
    style.left = px(layout.offsetX)
    style.top = px(layout.offsetY)
  }
}
