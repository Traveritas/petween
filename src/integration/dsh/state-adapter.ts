/**
 * integration/dsh/state-adapter.ts — the browser end of the M4 state channel
 * (spec §13.1 → §14). Connects an EventSource to `/api/petween/events`,
 * decodes snapshot/event frames, maps NormalizedAgentEvent to the resolver's
 * PetSemanticEvent, and emits deduped semantic events downstream.
 *
 * Two connection modes:
 * - filtered (`sessionId` set): the host pipes only that session's events;
 *   the map below holds at most one entry and events pass through.
 * - aggregate (no sessionId — the extreme fallback when the sessions service
 *   is unavailable): the host pipes every session and this adapter applies
 *   the §14.5 priority WAITING > ERROR > ACTIVE > SUCCESS > IDLE over each
 *   session's latest event. Success/error are TTL'd (§14.5: they are
 *   transient holds, not permanent states): an expired terminal entry counts
 *   as absent, so a session that finished long ago cannot suppress another
 *   session's live activity forever. The TTL clock is the event's own `ts`
 *   (host timestamp), so a snapshot replay after a reconnect/poll cannot
 *   revive a terminal that already ended — only a genuinely fresh terminal
 *   holds. Expiry is not only evaluated when an
 *   event arrives: every recompute arms a one-shot timer for the earliest
 *   live terminal expiry, so a suppressed session surfaces (or the pet
 *   returns to idle) even when no further event ever comes. The TTLs
 *   themselves hot-apply via {@link StateAdapter.setTerminalTtls}.
 *
 * Recovery: the native EventSource reconnects by itself; additionally, while
 * the stream is in an error state the adapter polls `GET …/state` every 2s
 * (treated like a snapshot frame) until the stream opens again. The fallback
 * poll suspends while the page is hidden (§23) and resumes on return if the
 * stream is still down.
 *
 * Stale-work guards: every (re)connect bumps a connection generation; SSE
 * handlers and in-flight poll callbacks captured under an older generation
 * are dropped, so a late frame/snapshot from a previous session's connection
 * can never apply after setSession().
 *
 * Pure TS: no DSH imports (spec §3.2); EventSource is a browser native API.
 */
import type { PetSemanticEvent } from '../../core/types'
import { EVENTS_PATH, STATE_PATH, type NormalizedAgentEvent, type StateFrame } from './state-protocol'

/** The slice of the native EventSource surface the adapter uses. */
export interface EventSourceLike {
  onopen: (() => void) | null
  onmessage: ((event: { data: string }) => void) | null
  onerror: (() => void) | null
  close(): void
}

export type EventSourceFactory = (url: string) => EventSourceLike

/** The `/state` snapshot payload (same shape as the SSE snapshot frame). */
export interface StateSnapshot {
  events: NormalizedAgentEvent[]
}

export type StateFetcher = (sessionId: string | undefined) => Promise<StateSnapshot>

export interface StateAdapterOptions {
  /** Deduped semantic events for the PetStateResolver. */
  onEvent: (event: PetSemanticEvent) => void
  /** undefined connects to the aggregate stream (all sessions). */
  sessionId?: string
  eventSourceFactory?: EventSourceFactory
  fetchState?: StateFetcher
  /** Fallback poll interval while the stream errors; default 2000ms. */
  pollIntervalMs?: number
  /**
   * §14.5 aggregate TTLs: a session's terminal event stops competing after
   * this long. Defaults mirror the resolver holds (1600/1800ms);
   * DshStateSource passes the config.global values here and hot-applies
   * later edits through setTerminalTtls.
   */
  successTtlMs?: number
  errorTtlMs?: number
}

const DEFAULT_POLL_INTERVAL_MS = 2000
const DEFAULT_SUCCESS_TTL_MS = 1600
const DEFAULT_ERROR_TTL_MS = 1800

/** §14.5 ranks: WAITING > ERROR > ACTIVE > SUCCESS > IDLE. */
function rankOf(event: NormalizedAgentEvent): number {
  switch (event.type) {
    case 'waiting':
      return 4
    case 'error':
      return 3
    case 'success':
      return 1
    case 'idle':
      return 0
    default:
      return 2 // turn-start / thinking / tool-start / tool-end → ACTIVE
  }
}

/** NormalizedAgentEvent → the resolver's semantic vocabulary (§13.3). */
export function toSemanticEvent(event: NormalizedAgentEvent): PetSemanticEvent {
  switch (event.type) {
    case 'idle':
      return { type: 'idle' }
    case 'turn-start':
      return { type: 'turn-start' }
    case 'thinking':
      return { type: 'activity', mode: 'thinking' }
    case 'tool-start':
      return { type: 'activity', mode: event.toolKind === 'edit' ? 'coding' : event.toolKind === 'command' ? 'command' : 'working' }
    case 'tool-end':
      // The tool finished; the agent returns to reasoning for the next step.
      return { type: 'activity', mode: 'thinking' }
    case 'waiting':
      return { type: 'waiting' }
    case 'success':
      return { type: 'turn-end', outcome: 'success' }
    case 'error':
      return { type: 'turn-end', outcome: 'error' }
  }
}

function eventsUrl(sessionId: string | undefined): string {
  return sessionId === undefined ? EVENTS_PATH : `${EVENTS_PATH}?session=${encodeURIComponent(sessionId)}`
}

function stateUrl(sessionId: string | undefined): string {
  return sessionId === undefined ? STATE_PATH : `${STATE_PATH}?session=${encodeURIComponent(sessionId)}`
}

const defaultFetchState: StateFetcher = async (sessionId) => {
  const response = await fetch(stateUrl(sessionId))
  if (!response.ok) throw new Error(`state snapshot failed (${response.status})`)
  return (await response.json()) as StateSnapshot
}

export class StateAdapter {
  private readonly onEvent: (event: PetSemanticEvent) => void
  private readonly eventSourceFactory: EventSourceFactory
  private readonly fetchState: StateFetcher
  private readonly pollIntervalMs: number
  /** §14.5 TTLs; mutable so live config edits hot-apply (setTerminalTtls). */
  private successTtlMs: number
  private errorTtlMs: number

  private sessionId: string | undefined
  private source: EventSourceLike | null = null
  /** Per-session latest normalized event (one entry in filtered mode). */
  private readonly sessions = new Map<string, { event: NormalizedAgentEvent; receivedAt: number }>()
  /** Identity of the last emitted winner: dedupes repeat aggregate results. */
  private lastEmittedKey: string | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  /** One-shot recompute armed at the earliest live terminal entry's expiry. */
  private terminalExpiryTimer: ReturnType<typeof setTimeout> | null = null
  /** The stream reported an error and has not reopened: polling is warranted. */
  private streamErrored = false
  private disposed = false
  /** Bumped per (re)connect; stale SSE/poll callbacks are dropped. */
  private connectionGeneration = 0

  constructor(options: StateAdapterOptions) {
    this.onEvent = options.onEvent
    // The native handler-prop types are structurally incompatible under
    // strictFunctionTypes; the adapter only assigns handlers and calls close().
    this.eventSourceFactory =
      options.eventSourceFactory ?? ((url) => new EventSource(url) as unknown as EventSourceLike)
    this.fetchState = options.fetchState ?? defaultFetchState
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.successTtlMs = options.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ERROR_TTL_MS
    this.sessionId = options.sessionId
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }
    this.connect()
  }

  /** Current stream session (undefined = aggregate mode). */
  get session(): string | undefined {
    return this.sessionId
  }

  /** Follow the DSH current-session selection; reconnects on change. */
  setSession(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.sessions.clear()
    this.lastEmittedKey = null
    this.clearTerminalExpiry()
    this.connect()
  }

  /**
   * Hot-apply the §14.5 aggregate TTLs (the settings page edits
   * successHoldMs/errorHoldMs while the stream is running). A TTL change can
   * expire or revive entries immediately, so recompute right away.
   */
  setTerminalTtls(successMs: number, errorMs: number): void {
    if (this.disposed) return
    if (successMs === this.successTtlMs && errorMs === this.errorTtlMs) return
    this.successTtlMs = successMs
    this.errorTtlMs = errorMs
    this.recompute()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopPolling()
    this.clearTerminalExpiry()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }
    this.source?.close()
    this.source = null
    this.sessions.clear()
  }

  private connect(): void {
    // Invalidate every callback captured by the previous connection first.
    const generation = ++this.connectionGeneration
    this.source?.close()
    const source = this.eventSourceFactory(eventsUrl(this.sessionId))
    source.onopen = () => {
      if (generation !== this.connectionGeneration) return
      this.streamErrored = false
      this.stopPolling()
    }
    source.onmessage = (message) => {
      if (generation !== this.connectionGeneration) return // stale frame from an old session
      this.handleMessage(message.data)
    }
    source.onerror = () => {
      if (generation !== this.connectionGeneration) return
      this.streamErrored = true
      this.startPolling()
    }
    this.source = source
  }

  private handleMessage(data: string): void {
    if (this.disposed) return
    let frame: StateFrame
    try {
      frame = JSON.parse(data) as StateFrame
    } catch {
      return // not our frame (should not happen on this endpoint)
    }
    if (frame.kind === 'snapshot') this.applySnapshot(frame.events)
    else if (frame.kind === 'event') this.applyEvent(frame.event)
  }

  /** A snapshot replaces everything known (reconnect, session switch, poll). */
  private applySnapshot(events: NormalizedAgentEvent[]): void {
    const receivedAt = Date.now()
    this.sessions.clear()
    for (const event of events) this.sessions.set(event.sessionId ?? '', { event, receivedAt })
    this.recompute()
  }

  private applyEvent(event: NormalizedAgentEvent): void {
    this.sessions.set(event.sessionId ?? '', { event, receivedAt: Date.now() })
    this.recompute()
  }

  /** §14.5: terminal events compete only within their TTL. */
  private terminalTtl(event: NormalizedAgentEvent): number | null {
    if (event.type === 'success') return this.successTtlMs
    if (event.type === 'error') return this.errorTtlMs
    return null
  }

  /**
   * A terminal entry's freshness clock is its OWN `ts`, not the receipt time:
   * a snapshot/poll replay (SSE reconnect, /state fallback) re-delivers the
   * session's last event, and a success/error that ended minutes ago must not
   * parade as a fresh terminal hold ("ghost celebration"). `receivedAt` stays
   * on the entry for non-terminal freshness semantics only.
   */
  private terminalExpired(event: NormalizedAgentEvent, ttl: number, now: number): boolean {
    return now - event.ts >= ttl
  }

  /** Pick the §14.5 winner and emit it when the aggregate actually changed. */
  private recompute(): void {
    const now = Date.now()
    let winner: NormalizedAgentEvent | null = null
    let winnerRank = -1
    for (const { event } of this.sessions.values()) {
      const ttl = this.terminalTtl(event)
      if (ttl !== null && this.terminalExpired(event, ttl, now)) continue // expired terminal counts as absent
      const rank = rankOf(event)
      if (rank > winnerRank || (rank === winnerRank && winner !== null && event.ts >= winner.ts)) {
        winner = event
        winnerRank = rank
      }
    }
    // A live error NEWER than a held waiting briefly outranks it (2026-08-27
    // 拍板 (a)): waiting entries never expire, so without this a session left
    // at an unanswered approval masks every later failure in another session
    // forever. The error's own TTL expiry recompute restores the waiting face
    // ~1.8s later (scheduleTerminalExpiry arms it for every live terminal,
    // winner or not), and the strict-newer guard keeps §14.5 steady state
    // untouched — a waiting that arrives after an error still displaces it
    // immediately, exactly as before.
    if (winner !== null && winner.type === 'waiting') {
      let error: NormalizedAgentEvent | null = null
      for (const { event } of this.sessions.values()) {
        if (event.type !== 'error' || this.terminalExpired(event, this.errorTtlMs, now)) continue
        if (error === null || event.ts >= error.ts) error = event
      }
      if (error !== null && error.ts > winner.ts) winner = error
    }
    this.scheduleTerminalExpiry(now)
    if (winner === null) {
      // Nothing known (fresh/empty snapshot): the pet belongs in idle.
      if (this.lastEmittedKey === '<none>') return
      this.lastEmittedKey = '<none>'
      this.onEvent({ type: 'idle' })
      return
    }
    const key = `${winner.sessionId ?? ''}|${winner.type}|${'toolKind' in winner ? winner.toolKind : ''}`
    if (key === this.lastEmittedKey) return
    this.lastEmittedKey = key
    this.onEvent(toSemanticEvent(winner))
  }

  /**
   * A live terminal entry expires on its own: arm a one-shot recompute for
   * the earliest expiry so the runner-up surfaces (or the pet idles) without
   * waiting for the next event. Re-armed by every recompute; cleared by
   * setSession/dispose. The expiry instant is derived from the event's own
   * `ts` (same clock as the recompute check above).
   */
  private scheduleTerminalExpiry(now: number): void {
    this.clearTerminalExpiry()
    if (this.disposed) return
    let earliest: number | null = null
    for (const { event } of this.sessions.values()) {
      const ttl = this.terminalTtl(event)
      if (ttl === null || this.terminalExpired(event, ttl, now)) continue // non-terminal or already expired
      const expiresAt = event.ts + ttl
      if (earliest === null || expiresAt < earliest) earliest = expiresAt
    }
    if (earliest === null) return
    this.terminalExpiryTimer = setTimeout(() => {
      this.terminalExpiryTimer = null
      if (!this.disposed) this.recompute()
    }, Math.max(0, earliest - now))
  }

  private clearTerminalExpiry(): void {
    if (this.terminalExpiryTimer !== null) clearTimeout(this.terminalExpiryTimer)
    this.terminalExpiryTimer = null
  }

  /** 2s snapshot polling, only while the EventSource reports an error. */
  private startPolling(): void {
    if (this.disposed || this.pollTimer !== null) return
    if (typeof document !== 'undefined' && document.hidden) return // §23: no polling while hidden
    this.pollTimer = setInterval(() => {
      const sessionId = this.sessionId
      const generation = this.connectionGeneration
      this.fetchState(sessionId).then(
        (snapshot) => {
          // Drop a late snapshot from before a setSession()/reconnect.
          if (!this.disposed && this.pollTimer !== null && generation === this.connectionGeneration) {
            this.applySnapshot(snapshot.events)
          }
        },
        () => {
          // silent: the next tick retries, and an EventSource recovery wins
        },
      )
    }, this.pollIntervalMs)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  /** §23: suspend the fallback poll while hidden; resume if the stream is down. */
  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return
    if (document.hidden) {
      this.stopPolling()
    } else if (this.streamErrored) {
      this.startPolling()
    }
  }
}
