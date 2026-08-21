/**
 * state-channel tests (M4): a recording fake cordis host + a real node:http
 * server (the same harness style as tests/host/routes.test.ts). Covers the
 * SSE handshake (snapshot frame), live event frames, `?session=` filtering,
 * the aggregate stream, heartbeats, close cleanup, the /state snapshot
 * endpoint, and `session/disposed` memory cleanup.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { RawSessionEvent } from '../../src/integration/dsh/event-normalizer'
import {
  attachStateChannel,
  EVENTS_PATH,
  STATE_PATH,
  type StateChannel,
  type StateChannelHost,
} from '../../src/host/state-channel'

const HEARTBEAT_MS = 25

let server: Server
let base: string
let channel: StateChannel
let listeners: Map<string, ((...args: any[]) => void)[]>
let routes: WebRoute[]

beforeEach(async () => {
  listeners = new Map()
  routes = []
  const host: StateChannelHost = {
    on(name: string, listener: (...args: any[]) => void): () => void {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        listeners.set(name, (listeners.get(name) ?? []).filter((entry) => entry !== listener))
      }
    },
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          routes.splice(routes.indexOf(route), 1)
        }
      },
    },
  }
  channel = attachStateChannel(host, { heartbeatMs: HEARTBEAT_MS })
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  channel.dispose()
  await new Promise((resolve) => server.close(resolve))
})

const emitSessionEvent = (sessionId: string, type: string, data: unknown): void => {
  const event: RawSessionEvent = { type, time: Date.now(), data }
  for (const listener of listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
}

const emitAgentStatus = (sessionId: string, status: string): void => {
  for (const listener of listeners.get('agent/status') ?? []) listener({ agent: { id: sessionId }, status })
}

/** Accumulate without consuming: opens a stream and returns its buffer API. */
async function openStream(query?: string): Promise<{ text: () => string; waitFor: (predicate: (text: string) => boolean) => Promise<void>; close: () => Promise<void> }> {
  const response = await fetch(`${base}${EVENTS_PATH}${query ?? ''}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  let text = ''
  let closed = false
  const pumping = (async () => {
    while (!closed) {
      const { done, value } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
  })()
  return {
    text: () => text,
    waitFor: async (predicate) => {
      const deadline = Date.now() + 5000
      while (!predicate(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(text)}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: async () => {
      closed = true
      await reader.cancel().catch(() => {})
      await pumping.catch(() => {})
    },
  }
}

describe('GET /api/motion-pet/events (SSE)', () => {
  it('sends an empty snapshot frame on connect when nothing is known', async () => {
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes('"kind":"snapshot"'))
    expect(stream.text()).toContain('data: {"kind":"snapshot","events":[]}')
    await stream.close()
  })

  it('replays the session\'s last known event as the snapshot', async () => {
    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes('"type":"turn-start"'))
    const frame = stream.text().split('\n\n')[0]
    expect(frame).toContain('"kind":"snapshot"')
    expect(frame).toContain('"type":"turn-start"')
    expect(frame).toContain('"sessionId":"s1"')
    await stream.close()
  })

  it('streams one event frame per normalized event, filtered by session', async () => {
    const s1 = await openStream('?session=s1')
    const s2 = await openStream('?session=s2')
    await s1.waitFor((text) => text.includes('snapshot'))
    await s2.waitFor((text) => text.includes('snapshot'))

    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    await s1.waitFor((text) => text.includes('"kind":"event"'))
    expect(s1.text()).toContain('"type":"turn-start"')
    expect(s2.text()).not.toContain('"kind":"event"')

    emitSessionEvent('s2', 'tool/call', { name: 'bash', arguments: '{}' })
    await s2.waitFor((text) => text.includes('"kind":"event"'))
    expect(s2.text()).toContain('"toolKind":"command"')
    // s1 saw exactly its own single event frame
    expect(s1.text().match(/"kind":"event"/g)).toHaveLength(1)
    await s1.close()
    await s2.close()
  })

  it('the aggregate stream (no session param) receives every session', async () => {
    const all = await openStream()
    await all.waitFor((text) => text.includes('snapshot'))
    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    emitSessionEvent('s2', 'approval/asked', { id: 'a1', toolName: 'bash' })
    await all.waitFor((text) => text.includes('"type":"waiting"'))
    expect(all.text()).toContain('"sessionId":"s1"')
    expect(all.text()).toContain('"sessionId":"s2"')
    await all.close()
  })

  it('maps agent/status through the same channel (idle only)', async () => {
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes('snapshot'))
    emitAgentStatus('s1', 'running') // ignored: turn/start owns the active face
    emitAgentStatus('s1', 'idle')
    await stream.waitFor((text) => text.includes('"type":"idle"'))
    expect(stream.text().match(/"kind":"event"/g)).toHaveLength(1)
    await stream.close()
  })

  it('ignores session events with no visual meaning', async () => {
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes('snapshot'))
    emitSessionEvent('s1', 'todo/write', { todos: [] })
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_MS * 3))
    expect(stream.text()).not.toContain('"kind":"event"')
    await stream.close()
  })

  it('sends heartbeat comment lines', async () => {
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes(': motion-pet'))
    await stream.close()
  })

  it('drops the client when the connection closes', async () => {
    const stream = await openStream('?session=s1')
    await stream.waitFor((text) => text.includes('snapshot'))
    expect(channel.clientCount()).toBe(1)
    await stream.close()
    const deadline = Date.now() + 5000
    while (channel.clientCount() !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(channel.clientCount()).toBe(0)
  })

  it('rejects non-GET methods', async () => {
    const response = await fetch(`${base}${EVENTS_PATH}`, { method: 'POST' })
    expect(response.status).toBe(405)
  })
})

describe('attachStateChannel rollback', () => {
  it('unwinds every completed subscription when a later attach step throws', () => {
    const buildHost = (failAtCall: number): { host: StateChannelHost; unsubscribed: string[] } => {
      const unsubscribed: string[] = []
      let calls = 0
      const track = (label: string): (() => void) => {
        calls += 1
        if (calls === failAtCall) throw new Error(`boom at ${label}`)
        return () => unsubscribed.push(label)
      }
      return {
        unsubscribed,
        host: {
          on(name: string): () => void {
            return track(name)
          },
          webServer: {
            register: (route: WebRoute) => track(route.path),
          },
        },
      }
    }

    // failure at the 3rd cordis subscription: the first two are unsubscribed,
    // no route is ever registered
    const cordisFailure = buildHost(3)
    expect(() => attachStateChannel(cordisFailure.host)).toThrow(/boom at agent\/error/)
    expect(cordisFailure.unsubscribed).toEqual(['session/event', 'agent/status'])

    // failure at the first webServer.register: all four event subs roll back
    const routeFailure = buildHost(5)
    expect(() => attachStateChannel(routeFailure.host)).toThrow(new RegExp(`boom at ${EVENTS_PATH.replaceAll('/', '\\/')}`))
    expect(routeFailure.unsubscribed).toEqual(['session/event', 'agent/status', 'agent/error', 'session/disposed'])
  })
})

describe('GET /api/motion-pet/state', () => {
  it('returns the per-session snapshot, empty for unknown sessions', async () => {
    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    const hit = await (await fetch(`${base}${STATE_PATH}?session=s1`)).json()
    expect(hit.events).toHaveLength(1)
    expect(hit.events[0]).toMatchObject({ type: 'turn-start', sessionId: 's1' })
    const miss = await (await fetch(`${base}${STATE_PATH}?session=nope`)).json()
    expect(miss.events).toEqual([])
  })

  it('returns every known session without a session param', async () => {
    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    emitSessionEvent('s2', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    const body = await (await fetch(`${base}${STATE_PATH}`)).json()
    expect(body.events).toHaveLength(2)
    expect(body.events.map((event: { type: string }) => event.type).sort()).toEqual(['success', 'turn-start'])
  })

  it('keeps only the latest event per session and forgets disposed sessions', async () => {
    emitSessionEvent('s1', 'turn/start', { turn: 1 })
    emitSessionEvent('s1', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(channel.lastEvent('s1')).toMatchObject({ type: 'success' })
    for (const listener of listeners.get('session/disposed') ?? []) listener({ id: 's1' })
    expect(channel.lastEvent('s1')).toBeNull()
    const body = await (await fetch(`${base}${STATE_PATH}?session=s1`)).json()
    expect(body.events).toEqual([])
  })
})
