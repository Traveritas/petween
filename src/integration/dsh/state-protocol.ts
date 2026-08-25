/**
 * integration/dsh/state-protocol.ts — the M4 host↔client wire contract
 * (spec §13.1 + state-channel framing). Zero imports by design: host
 * (state-channel.ts) and client (state-adapter.ts) both consume it, and the
 * client bundle must never inline host code.
 *
 * Endpoints (both exact routes, host/state-channel.ts):
 * - `GET /api/petween/events[?session=<id>]` — SSE stream of StateFrame
 *   blocks (`data: {json}\n\n`), plus `: petween` heartbeat comments.
 * - `GET /api/petween/state[?session=<id>]` — plain JSON `{ events }`,
 *   the same payload a snapshot frame carries.
 */

/** Spec §13.1 verbatim. `ts` is unix epoch ms. */
export type NormalizedAgentEvent =
  | { type: 'idle'; sessionId?: string; ts: number }
  | { type: 'turn-start'; sessionId?: string; ts: number }
  | { type: 'thinking'; sessionId?: string; ts: number }
  | { type: 'tool-start'; toolKind: 'edit' | 'command' | 'other'; sessionId?: string; ts: number }
  | { type: 'tool-end'; sessionId?: string; ts: number }
  | { type: 'waiting'; sessionId?: string; ts: number }
  | { type: 'success'; sessionId?: string; ts: number }
  | { type: 'error'; sessionId?: string; ts: number }

/**
 * SSE frame shapes:
 * - `snapshot`: sent once on connect (and mirrored by the /state endpoint).
 *   Filtered connections carry zero-or-one events (the session's last known
 *   normalized event); aggregate connections carry every known session's.
 * - `event`: one live normalized event.
 */
export type StateFrame =
  | { kind: 'snapshot'; events: NormalizedAgentEvent[] }
  | { kind: 'event'; event: NormalizedAgentEvent }

export const EVENTS_PATH = '/api/petween/events'
export const STATE_PATH = '/api/petween/state'
