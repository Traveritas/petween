/**
 * stats-hud/hud-logic.ts — the pure bubble state machine (Phase 10). Turns a
 * stats snapshot stream (main-side ledger) into spawn/update/hide commands
 * for the DOM side; every timing policy lives here so it is unit-testable
 * without a DOM:
 *
 * - Thinking bubble: appears only after the session has been thinking for
 *   `thinkingShowThresholdMs` (below that it's flicker between fast tools),
 *   ticks live from thinkingSince, hides when the state leaves thinking.
 * - Edit bubble: one per WORKING EPISODE — the first edit fact of an episode
 *   spawns it, subsequent edit facts accumulate into it live, and leaving
 *   working hides it (the companion adds the hold delay so the final total
 *   stays readable).
 * - Turn bubble: the ledger's turn-summary event becomes a 完成提醒 bubble
 *   (thinking time + line deltas + wall duration).
 * - Milestones: while an episode accumulates, every crossing of
 *   `milestoneEveryLines` added-lines fires an edit-milestone command (the
 *   companion plays a pet animation, throttled).
 * - Second batch: multiSession tracks EVERY session (one column each in the
 *   host) — off restores the v1 focused-only behaviour, where a focus switch
 *   immediately retires the previous focus's bubbles. Sessions that vanished
 *   from the snapshot (watchdog dispose) retire theirs either way.
 */

import type { LedgerEvent as StatsLedgerEvent, LedgerSnapshot as StatsSnapshot } from './ledger'

export interface HudOptions {
  /** Thinking shorter than this never shows a bubble (ms). */
  thinkingShowThresholdMs: number
  /** How long the final thinking total stays before the fade (ms). */
  thinkingHoldMs: number
  /** How long a finished edit episode stays before the fade (ms). */
  editHoldMs: number
  /** Hard cap for one edit bubble's life (ms) — runaway working episodes. */
  editMaxAgeMs: number
  /** One column per session (second batch); false = focused session only. */
  multiSession: boolean
  /** Turn-end summary bubbles. */
  turnSummary: boolean
  /** Pet animation every N added lines (0 = off). */
  milestoneEveryLines: number
}

export const DEFAULT_HUD_OPTIONS: HudOptions = {
  thinkingShowThresholdMs: 1500,
  thinkingHoldMs: 900,
  editHoldMs: 1500,
  editMaxAgeMs: 20_000,
  multiSession: true,
  turnSummary: true,
  milestoneEveryLines: 0,
}

export type HudCommand =
  | { type: 'thinking-show'; sessionId: string; startedAt: number }
  | { type: 'thinking-hide'; sessionId: string; totalMs: number; holdMs: number }
  | { type: 'edit-show'; sessionId: string; added: number | null; removed: number | null; files: number }
  | { type: 'edit-update'; sessionId: string; added: number | null; removed: number | null; files: number }
  | { type: 'edit-hide'; sessionId: string; holdMs: number; maxAgeReached: boolean }
  | {
      type: 'turn-show'
      sessionId: string
      turnId?: string
      thinkingMs: number
      linesAdded: number
      linesRemoved: number
      edits: number
      durationMs: number
    }
  | { type: 'edit-milestone'; sessionId: string; lines: number; level: number }

interface EditEpisode {
  added: number
  removed: number
  files: number
  startedAt: number
  /** Highest milestone level fired for this episode (index of the crossing). */
  milestoneLevel: number
}

interface SessionTrack {
  thinkingShown: boolean
  /** Current thinking interval's start (event time), when known. */
  thinkingIntervalStart: number | null
  editEpisode: EditEpisode | null
}

export interface HudReducer {
  /** Process one snapshot; commands are in causal order. */
  apply(snapshot: StatsSnapshot, now: number): HudCommand[]
}

/**
 * `getOptions` is read on every apply so live setting changes take effect
 * without rebuilding (and resetting) the reducer's per-session tracking.
 * A plain options object is accepted too (frozen at creation).
 */
export function createHudReducer(getOptions?: (() => Partial<HudOptions>) | Partial<HudOptions>): HudReducer {
  const resolveOptions = (): Partial<HudOptions> | undefined =>
    typeof getOptions === 'function' ? getOptions() : getOptions
  const options = (): HudOptions => ({ ...DEFAULT_HUD_OPTIONS, ...(resolveOptions() ?? {}) })
  const tracks = new Map<string, SessionTrack>()
  let lastFocus: string | null = null

  const trackOf = (sessionId: string): SessionTrack => {
    let track = tracks.get(sessionId)
    if (track === undefined) {
      track = { thinkingShown: false, thinkingIntervalStart: null, editEpisode: null }
      tracks.set(sessionId, track)
    }
    return track
  }

  const hideEdit = (commands: HudCommand[], sessionId: string, holdMs: number, maxAgeReached: boolean, track: SessionTrack): void => {
    if (track.editEpisode === null) return
    track.editEpisode = null
    commands.push({ type: 'edit-hide', sessionId, holdMs, maxAgeReached })
  }

  const applyEvent = (commands: HudCommand[], event: StatsLedgerEvent, sessionId: string): void => {
    const track = trackOf(sessionId)
    if (event.type === 'state') {
      if (event.state === 'thinking') {
        if (track.thinkingIntervalStart === null) track.thinkingIntervalStart = event.at
      } else {
        if (track.thinkingIntervalStart !== null && track.thinkingShown) {
          commands.push({
            type: 'thinking-hide',
            sessionId,
            totalMs: Math.max(0, event.at - track.thinkingIntervalStart),
            holdMs: options().thinkingHoldMs,
          })
        }
        track.thinkingShown = false
        track.thinkingIntervalStart = null
      }
      // Entering thinking IS leaving working: the episode's bubble hides too.
      if (event.state !== 'working') {
        hideEdit(commands, sessionId, options().editHoldMs, false, track)
      }
      return
    }
    if (event.type === 'turn-summary') {
      if (options().turnSummary && event.summary !== undefined) {
        commands.push({
          type: 'turn-show',
          sessionId,
          turnId: event.turnId,
          thinkingMs: event.summary.thinkingMs,
          linesAdded: event.summary.linesAdded,
          linesRemoved: event.summary.linesRemoved,
          edits: event.summary.edits,
          durationMs: event.summary.durationMs,
        })
      }
      return
    }
    // Edit fact: open or grow the working episode's bubble.
    const added = event.added ?? null
    const removed = event.removed ?? null
    if (track.editEpisode === null) {
      track.editEpisode = { added: added ?? 0, removed: removed ?? 0, files: 1, startedAt: event.at, milestoneLevel: 0 }
      commands.push({ type: 'edit-show', sessionId, added, removed, files: 1 })
    } else {
      track.editEpisode.added += added ?? 0
      track.editEpisode.removed += removed ?? 0
      track.editEpisode.files += 1
      commands.push({
        type: 'edit-update',
        sessionId,
        added: track.editEpisode.added,
        removed: track.editEpisode.removed,
        files: track.editEpisode.files,
      })
    }
    // Milestone crossing: every N cumulative ADDED lines in the episode.
    const every = options().milestoneEveryLines
    if (every > 0 && track.editEpisode !== null) {
      const level = Math.floor(track.editEpisode.added / every)
      if (level > track.editEpisode.milestoneLevel) {
        track.editEpisode.milestoneLevel = level
        commands.push({ type: 'edit-milestone', sessionId, lines: track.editEpisode.added, level })
      }
    }
  }

  const reconcileSession = (commands: HudCommand[], sessionId: string, summary: StatsSnapshot['sessions'][string], now: number): void => {
    const track = trackOf(sessionId)
    // Ring-wrap fallback, symmetric with the edit branch below: when the
    // renderer is throttled long enough for the 256-event ring to lose the
    // thinking→working transition, the event stream can no longer deliver
    // the hide — the summary is the remaining truth (v0.4.0 review).
    if (
      track.thinkingShown &&
      (summary.state !== 'thinking' || (summary.thinkingSince !== null && summary.thinkingSince !== track.thinkingIntervalStart))
    ) {
      commands.push({
        type: 'thinking-hide',
        sessionId,
        totalMs: Math.max(0, now - (track.thinkingIntervalStart ?? now)),
        holdMs: options().thinkingHoldMs,
      })
      track.thinkingShown = false
      track.thinkingIntervalStart = null
    }
    if (summary.state === 'thinking' && summary.thinkingSince !== null) {
      if (track.thinkingIntervalStart === null) track.thinkingIntervalStart = summary.thinkingSince
      if (!track.thinkingShown && now - summary.thinkingSince >= options().thinkingShowThresholdMs) {
        track.thinkingShown = true
        commands.push({ type: 'thinking-show', sessionId, startedAt: summary.thinkingSince })
      }
    }
    if (summary.state !== 'working') {
      hideEdit(commands, sessionId, options().editHoldMs, false, track)
    }
    if (track.editEpisode !== null && options().editMaxAgeMs > 0 && now - track.editEpisode.startedAt >= options().editMaxAgeMs) {
      hideEdit(commands, sessionId, 0, true, track)
    }
  }

  return {
    apply(snapshot, now) {
      const commands: HudCommand[] = []
      const focus = snapshot.focusedSessionId
      const multi = options().multiSession

      // Sessions that vanished from the snapshot (watchdog dispose) retire
      // their bubbles; tracks go so they never leak into a reused id.
      for (const [sessionId, track] of tracks) {
        if (snapshot.sessions[sessionId] !== undefined) continue
        if (track.thinkingShown) commands.push({ type: 'thinking-hide', sessionId, totalMs: 0, holdMs: 0 })
        hideEdit(commands, sessionId, 0, false, track)
        tracks.delete(sessionId)
      }

      // Focus switched away and v1 scoping: retire the old focus's bubbles.
      if (!multi && lastFocus !== null && focus !== lastFocus) {
        const previous = tracks.get(lastFocus)
        if (previous !== undefined) {
          if (previous.thinkingShown) {
            previous.thinkingShown = false
            commands.push({ type: 'thinking-hide', sessionId: lastFocus, totalMs: 0, holdMs: 0 })
          }
          hideEdit(commands, lastFocus, 0, false, previous)
          previous.thinkingIntervalStart = null
        }
      }
      lastFocus = focus

      const inScope = (sessionId: string): boolean => multi || sessionId === focus

      for (const event of snapshot.events) {
        // A session vanished from the snapshot (connector disabled → reset()
        // drops the ledger row) but its last events still sit in the ring:
        // replaying them would pop a final turn/reply bubble AFTER the user
        // just switched the connector off. Any live session has a row from
        // its first recorded event, so this filter is safe.
        if (snapshot.sessions[event.sessionId] === undefined) continue
        if (inScope(event.sessionId)) applyEvent(commands, event, event.sessionId)
      }

      for (const [sessionId, summary] of Object.entries(snapshot.sessions)) {
        if (inScope(sessionId)) reconcileSession(commands, sessionId, summary, now)
      }

      return commands
    },
  }
}
