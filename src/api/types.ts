// Public plugin API (docs/06). Built-in plugins use exactly these types — no back doors.
// Rule: bump and widen, never mutate. Anything not here yet is not part of apiVersion 1.

export const API_VERSION = 1;

export interface Disposable {
  dispose(): void;
}

// ---------- geometry ----------

/** Global desktop coordinates: physical pixels ÷ primary monitor scale (docs/01 §2). */
export interface Point {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------- motion (docs/03 §3) ----------

export interface TransformDelta {
  x?: number;
  y?: number;
  rotate?: number;
  scaleX?: number;
  scaleY?: number;
  skewX?: number;
  skewY?: number;
  opacity?: number;
}

export interface MotionContext {
  pet: PetHandle;
  params: Record<string, unknown>;
  strength: number;
  reducedMotion: boolean;
}

export interface MotionSource {
  /** t = ms since this motion started, dt = ms since last frame. */
  evaluate(t: number, dt: number, ctx: MotionContext): TransformDelta;
  /** One-shot: total duration in ms. Looping / open-ended: null. */
  readonly duration: number | null;
  /** ms → marker name, e.g. { 180: 'swap' }. */
  readonly markers?: Record<number, string>;
  /** Open-ended one-shots (e.g. an impulse spring) report completion here. */
  isDone?(): boolean;
  dispose?(): void;
}

export interface MotionType {
  /** Built-ins: 'keyframes' | 'spring' | 'noise' | 'sine'. Plugin types: '<pluginId>:<name>'. */
  id: string;
  create(params: Record<string, unknown>): MotionSource;
  paramsSchema?: unknown;
}

/** Named motion id from the pet pack, or an inline definition. */
export type MotionRef = string | { type: string; [param: string]: unknown };

export type MotionLayer = 'base' | 'transition' | 'physics' | 'plugin' | 'interaction';

export interface MotionOptions {
  layer?: MotionLayer;
  blend?: 'add' | 'override';
  weight?: number;
}

export interface MotionHandle extends Disposable {
  readonly active: boolean;
  setWeight(w: number): void;
  /** Fires once when a one-shot finishes (not on dispose). */
  onEnd(fn: () => void): Disposable;
  onMarker(fn: (name: string) => void): Disposable;
}

// ---------- channels (docs/02) ----------

export interface LeaseRequest<T> {
  priority: number;
  value: T;
  /** 'signal-change': released automatically when the brain's output changes. */
  releaseOn?: 'never' | 'signal-change';
  /** Revoke holders at equal or lower priority instead of stacking above them. */
  preempt?: boolean;
}

export interface Lease<T> extends Disposable {
  readonly owner: string;
  readonly priority: number;
  readonly value: T;
  /** true while this lease is the stack top. */
  readonly active: boolean;
  readonly revoked: boolean;
  update(value: T): void;
  release(): void;
  onActiveChange(fn: (active: boolean) => void): Disposable;
  onRevoked(fn: () => void): Disposable;
}

export interface ExclusiveChannel<T> {
  request(req: LeaseRequest<T>): Lease<T>;
  /** Current winning value. */
  readonly value: T;
  /** Inspector view of the stack, top first. */
  entries(): { owner: string; priority: number; value: T; active: boolean }[];
}

/** `clip` channel value: a clip id from the pet pack, or an inline clip. */
export interface ClipIntent {
  clip: string | ClipDef;
  transition?: TransitionRef;
  enter?: MotionRef;
}

export interface BubbleRequest {
  text: string;
  priority?: number;
  ttlMs?: number;
}

export interface BubbleHandle extends Disposable {
  readonly showing: boolean;
  onShow(fn: () => void): Disposable;
  onHide(fn: () => void): Disposable;
}

export interface BubbleChannel {
  say(req: BubbleRequest): BubbleHandle;
  /** The bubble currently on screen (owner + text), or null. */
  readonly current: { owner: string; text: string } | null;
  entries(): { owner: string; text: string; priority: number; showing: boolean }[];
}

// ---------- input ----------

export type InputType =
  | 'hover-start'
  | 'hover-end'
  | 'down'
  | 'up'
  | 'click'
  | 'context'
  | 'drag-start'
  | 'drag-move'
  | 'drag-end';

export interface InputEvent {
  type: InputType;
  /** Global desktop coordinates of the cursor. */
  x: number;
  y: number;
  button: number;
}

// ---------- pet pack (docs/04) ----------

export interface ClipDef {
  type: 'still' | 'frames' | string;
  source: string;
  fps?: number;
  /** Spritesheet layout for `frames`; frame size = image width / columns. */
  frames?: { count: number; columns?: number };
  segments?: { enter?: [number, number]; loop?: [number, number]; exit?: [number, number] };
  markers?: Record<string, string>;
  anchor?: { x: number; y: number };
  scale?: number;
}

export type TransitionRef = 'cut' | 'crossfade' | 'onMarker' | 'afterLoop' | { type: string; [k: string]: unknown };

export interface StateAppearance {
  clips: string[];
  variant?: 'random' | 'cycle' | 'sticky';
  cycleMs?: number;
  weights?: number[];
  enter?: MotionRef;
  loop?: MotionRef[];
  exit?: MotionRef;
  transition?: TransitionRef;
}

export interface PetPack {
  format: number;
  id: string;
  name: string;
  attribution?: { creators?: string[]; license?: string; sourceUrl?: string };
  scale?: number;
  clips: Record<string, ClipDef>;
  motions?: Record<string, { type: string; [k: string]: unknown }>;
  states: Record<string, StateAppearance>;
  plugins?: Record<string, unknown>;
}

export interface PetPackInfo {
  id: string;
  name: string;
  attribution?: PetPack['attribution'];
}

// ---------- pets ----------

export type PetEvent = 'stateKey' | 'clip' | 'input' | 'playback' | 'bubble';

export interface PlaybackEvent {
  clip: string;
  kind: 'marker' | 'loop' | 'end';
  marker?: string;
}

export interface PetHandle {
  readonly id: string;
  readonly pack: PetPackInfo;
  readonly position: Point;
  /** px per second, from position changes. */
  readonly velocity: Point;
  /** Current picture's box on the desktop (before motion transforms). */
  readonly bounds: Rect;
  readonly stateKey: string;

  on(event: 'stateKey', fn: (key: string) => void): Disposable;
  on(event: 'clip', fn: (clipId: string) => void): Disposable;
  on(event: 'input', fn: (e: InputEvent) => void): Disposable;
  on(event: 'playback', fn: (e: PlaybackEvent) => void): Disposable;
  on(event: 'bubble', fn: (b: { owner: string; text: string } | null) => void): Disposable;

  channel(name: 'state'): ExclusiveChannel<string>;
  channel(name: 'clip'): ExclusiveChannel<ClipIntent | null>;
  channel(name: 'position'): ExclusiveChannel<Point>;
  channel(name: 'bubble'): BubbleChannel;

  motion: { add(source: MotionSource | MotionRef, opts?: MotionOptions): MotionHandle };

  showState(key: string, opts?: { priority?: number; releaseOn?: 'never' | 'signal-change' }): Lease<string>;
  say(text: string, opts?: { priority?: number; ttlMs?: number }): BubbleHandle;
  play(motion: MotionRef, opts?: MotionOptions): MotionHandle;
  pluginConfig<T>(): T | undefined;
}

// ---------- agents (docs/05) ----------

export interface HookRequest {
  connectorId: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

export interface AgentEvent {
  agent: string;
  sessionId: string;
  at: number;
  type: 'session-start' | 'session-end' | 'turn-start' | 'thinking' | 'tool-start' | 'tool-end' | 'waiting' | 'turn-end';
  tool?: { name: string; kind: 'edit' | 'command' | 'read' | 'search' | 'web' | 'other'; ok?: boolean };
  outcome?: 'success' | 'error' | 'interrupted';
  extra?: Record<string, unknown>;
}

export interface SessionInfo {
  agent: string;
  sessionId: string;
  startedAt: number;
  lastEventAt: number;
  lastEvent: AgentEvent['type'];
}

export interface ConnectorDef {
  id: string;
  parse(req: HookRequest): AgentEvent[];
}

export interface BrainInstance {
  onEvent(e: AgentEvent): void;
  dispose?(): void;
}

export interface BrainDef {
  id: string;
  /** `output(key)` sets the pet's priority-0 state. */
  create(pet: PetHandle, output: (key: string) => void): BrainInstance;
}

export interface BindingRuleDef {
  id: string;
  /** Which pets an event drives. */
  route(e: AgentEvent, pets: PetHandle[]): PetHandle[];
}

export interface TransitionTypeDef {
  id: string;
  /**
   * When the outgoing clip may be swapped for the incoming one, after the enter motion's `swap` point.
   * Return how long a crossfade lasts (0 = hard cut) and an optional gate on the outgoing playback.
   */
  plan(params: Record<string, unknown>): { crossfadeMs: number; waitFor?: { marker: string } | 'loop-end' };
}

// ---------- plugin context (docs/06 §4) ----------

export interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export interface Store {
  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
  onChange(fn: (key: string) => void): Disposable;
}

export interface StageLayer extends Disposable {
  /** Container on the primary stage; position children in global desktop coordinates via toLocal(). */
  readonly el: HTMLElement;
  toLocal(p: Point): Point;
}

export interface TrayItemOptions {
  label: string;
  checked?: boolean;
  enabled?: boolean;
  onClick(): void;
}

export interface TrayItemHandle extends Disposable {
  update(patch: Partial<Omit<TrayItemOptions, 'onClick'>>): void;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HostApi {
  paths: { home: string; appData: string };
  fs: {
    readText(path: string): Promise<string>;
    writeText(path: string, content: string): Promise<void>;
    list(path: string): Promise<{ name: string; isDir: boolean }[]>;
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
  };
  shell: { exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult> };
  openExternal(url: string): Promise<void>;
  /** Port of the local hook server (docs/05 §1), for connectors writing hook commands. */
  hookPort(): Promise<number>;
}

export interface PluginContext {
  readonly id: string;
  readonly log: Logger;

  pets: {
    list(): PetHandle[];
    on(event: 'added' | 'removed', fn: (pet: PetHandle) => void): Disposable;
  };

  agent: {
    on(event: 'event', fn: (e: AgentEvent) => void): Disposable;
    sessions(): SessionInfo[];
  };

  register: {
    connector(def: ConnectorDef): Disposable;
    brain(def: BrainDef): Disposable;
    motionType(def: MotionType): Disposable;
    transitionType(def: TransitionTypeDef): Disposable;
    bindingRule(def: BindingRuleDef): Disposable;
  };

  stage: {
    addLayer(opts: { z: number; hitTest?: (p: Point) => boolean }): StageLayer;
  };
  tray: { addItem(item: TrayItemOptions): TrayItemHandle };

  settings: Store;
  data: Store;
  host: HostApi;

  bus: { emit(topic: string, payload: unknown): void; on(topic: string, fn: (payload: unknown) => void): Disposable };
  services: { provide(name: string, impl: unknown): Disposable; use<T>(name: string): T | undefined };

  setTimeout(fn: () => void, ms: number): Disposable;
  setInterval(fn: () => void, ms: number): Disposable;
  /** Called every rendered frame with (now, dt) in ms. */
  requestFrame(fn: (now: number, dt: number) => void): Disposable;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  main?: string;
  settings?: string;
  dependencies?: Record<string, string>;
  permissions?: string[];
  contributes?: {
    stateKeys?: { key: string; label: string }[];
    motionTypes?: string[];
    channels?: string[];
  };
}

export interface PluginModule {
  activate(ctx: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

export function definePlugin(m: PluginModule): PluginModule {
  return m;
}
