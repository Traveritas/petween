/**
 * host/state-channel.ts — the M4 agent-state push channel (spec §13/§14.5).
 * Subscribes the host-side cordis events, normalizes them through
 * integration/dsh/event-normalizer, keeps each session's latest normalized
 * event in memory, and serves:
 *
 * - exact `GET /api/petween/events[?session=<id>]` — SSE stream. On
 *   connect a snapshot frame is sent first (`{kind:'snapshot',events:[...]}`:
 *   the session's last known event, zero-or-one when filtered, every known
 *   session when aggregate), then one frame per normalized event
 *   (`{kind:'event',event:{...}}`), then a `: petween` heartbeat comment
 *   every 25s. The webServer WebRoute contract explicitly allows holding the
 *   response open for SSE (dsh-host-webserver types).
 * - exact `GET /api/petween/state[?session=<id>]` — plain JSON snapshot
 *   with the same `{events:[...]}` payload, for initial load and the client's
 *   fallback polling.
 *
 * The host stays a dumb pipe: every frame carries its sessionId and the
 * client does the §14.5 cross-session aggregation, so both endpoints only
 * filter by the optional `?session=` parameter. The per-session memory is
 * cleaned on `session/disposed`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  normalizeAgentError,
  normalizeAgentStatus,
  normalizeSessionEvent,
  type RawSessionEvent,
} from '../integration/dsh/event-normalizer'
import { EVENTS_PATH, STATE_PATH, type NormalizedAgentEvent, type StateFrame } from '../integration/dsh/state-protocol'

export { EVENTS_PATH, STATE_PATH }

const DEFAULT_HEARTBEAT_MS = 25_000
/** Keep-alive comment line (SSE convention), sent between data frames. */
const HEARTBEAT_LINE = ': petween\n\n'

/** SSE wire frame (one `data: {json}\n\n` block each). */

/**
 * Narrow slice of the cordis context (the routes.ts RoutesHost pattern). The
 * real `Context` satisfies it structurally; tests pass a recording fake.
 */
export interface StateChannelHost {
  on(name: 'session/event', listener: (session: { id: string }, event: RawSessionEvent) => void): () => void
  on(name: 'session/disposed', listener: (session: { id: string }) => void): () => void
  on(name: 'agent/status', listener: (payload: { agent: { id: string }; status: string }) => void): () => void
  on(name: 'agent/error', listener: (payload: { agent: { id: string } }) => void): () => void
  webServer: {
    register(route: WebRoute): () => void
  }
}

export interface StateChannelOptions {
  /** SSE keep-alive interval; default 25s (well under typical proxy idle caps). */
  heartbeatMs?: number
}

export interface StateChannel {
  /** Live SSE client count (test introspection). */
  clientCount(): number
  /** Last normalized event known for a session. */
  lastEvent(sessionId: string): NormalizedAgentEvent | null
  /** Unsubscribes, unregisters the routes, and closes every open stream. */
  dispose(): void
}

interface SseClient {
  res: ServerResponse
  /** undefined = aggregate stream (every session). */
  sessionId: string | undefined
  heartbeat: ReturnType<typeof setInterval>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function sessionParam(req: IncomingMessage): string | undefined {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('session') ?? undefined
  } catch {
    return undefined
  }
}

export function attachStateChannel(host: StateChannelHost, options?: StateChannelOptions): StateChannel {
  const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const clients = new Set<SseClient>()
  const lastBySession = new Map<string, NormalizedAgentEvent>()
  let disposed = false

  const dropClient = (client: SseClient): void => {
    if (!clients.delete(client)) return
    clearInterval(client.heartbeat)
    try {
      client.res.end()
    } catch {
      // the socket is already gone
    }
  }

  const write = (client: SseClient, text: string): void => {
    try {
      client.res.write(text)
    } catch {
      dropClient(client) // a dead socket must not break the broadcast loop
    }
  }

  const publish = (event: NormalizedAgentEvent): void => {
    if (event.sessionId !== undefined) lastBySession.set(event.sessionId, event)
    const frame = `data: ${JSON.stringify({ kind: 'event', event } satisfies StateFrame)}\n\n`
    for (const client of clients) {
      if (client.sessionId === undefined || client.sessionId === event.sessionId) {
        write(client, frame)
      }
    }
  }

  const snapshotFor = (sessionId: string | undefined): NormalizedAgentEvent[] => {
    if (sessionId === undefined) return [...lastBySession.values()]
    const known = lastBySession.get(sessionId)
    return known === undefined ? [] : [known]
  }

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } })
      return
    }
    const sessionId = sessionParam(req)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // intermediary buffering would delay frames (nginx-style proxies)
      'x-accel-buffering': 'no',
    })
    const client: SseClient = {
      res,
      sessionId,
      heartbeat: setInterval(() => write(client, HEARTBEAT_LINE), heartbeatMs),
    }
    clients.add(client)
    // res.write() failures can also surface asynchronously as 'error' events
    // (write-after-end on a dying socket); without a listener they would hit
    // the process as uncaught exceptions — treat them like a dropped client.
    client.res.on('error', () => dropClient(client))
    // Socket-level errors deliver to the request side too (an unlistened
    // IncomingMessage 'error' can crash a bare node:http host) — same drop.
    req.on('error', () => dropClient(client))
    write(client, `data: ${JSON.stringify({ kind: 'snapshot', events: snapshotFor(sessionId) } satisfies StateFrame)}\n\n`)
    res.on('close', () => dropClient(client))
  }

  const handleState = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'expected GET' } })
      return
    }
    sendJson(res, 200, { events: snapshotFor(sessionParam(req)) })
  }

  // Register step by step so a mid-attach failure can unwind: without the
  // rollback every subscription that already succeeded would leak.
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      host.on('session/event', (session, event) => {
        const normalized = normalizeSessionEvent(session.id, event)
        if (normalized !== null) publish(normalized)
      }),
    )
    disposers.push(
      host.on('agent/status', ({ agent, status }) => {
        const normalized = normalizeAgentStatus(agent.id, status)
        if (normalized !== null) publish(normalized)
      }),
    )
    disposers.push(
      host.on('agent/error', ({ agent }) => {
        publish(normalizeAgentError(agent.id))
      }),
    )
    disposers.push(
      host.on('session/disposed', (session) => {
        lastBySession.delete(session.id)
      }),
    )
    disposers.push(host.webServer.register({ kind: 'exact', path: EVENTS_PATH, handler: handleEvents }))
    disposers.push(host.webServer.register({ kind: 'exact', path: STATE_PATH, handler: handleState }))
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // keep unwinding; the original error is the one that propagates
      }
    }
    throw error
  }

  return {
    clientCount: () => clients.size,
    lastEvent: (sessionId) => lastBySession.get(sessionId) ?? null,
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const dispose of disposers) dispose()
      for (const client of [...clients]) dropClient(client)
    },
  }
}
