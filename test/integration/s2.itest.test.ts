import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { SessionDetail, ListSessionsResponse, ReplayEvent } from '../../src/shared/session.ts'

// These tests round-trip through Express into s2-lite; give them generous
// timeouts so a slow Docker host produces a real failure, not a 5s timeout.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Integration test against a real S2 API surface, intended to run against
// `s2 lite` (the in-memory emulator):
//   docker run -p 8080:80 ghcr.io/s2-streamstore/s2 lite
// Skipped unless S2_TEST_ENDPOINT is set, so the default unit suite (and CI's
// build job, which has no S2) stays green.
const S2_ENDPOINT = process.env.S2_TEST_ENDPOINT

if (S2_ENDPOINT) {
  // Configure the server BEFORE importing it (config is read once at module load).
  process.env.NODE_ENV = 'test'
  process.env.REPLAYA_LOG_REQUESTS = 'false'
  process.env.S2_ACCESS_TOKEN = process.env.S2_ACCESS_TOKEN || 'ignored'
  process.env.S2_BASIN = process.env.S2_TEST_BASIN || 'replaya-it-basin'
  process.env.S2_ACCOUNT_ENDPOINT = S2_ENDPOINT
  process.env.S2_BASIN_ENDPOINT = S2_ENDPOINT
  // Exercise the data path without auth so the focus is the S2 round-trip.
  delete process.env.REPLAYA_INGEST_AUTH_REQUIRED
  delete process.env.REPLAYA_PROJECT_KEYS
}

const integration = describe.skipIf(!S2_ENDPOINT)

integration('S2 integration (s2 lite): create → append → replay', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    const { app } = await import('../../server/index.ts')
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      })
    })
  })

  afterAll(async () => {
    // Best-effort cleanup so a long-lived local s2-lite doesn't accumulate sessions.
    if (base) {
      try {
        const list = (await (await fetch(`${base}/api/sessions?limit=100`)).json()) as ListSessionsResponse
        await Promise.all(
          list.sessions.map((summary) =>
            fetch(`${base}/api/sessions/${summary.id}`, { method: 'DELETE' }).catch(() => undefined),
          ),
        )
      } catch {
        // ignore — the emulator is ephemeral in CI
      }
    }
    server?.close()
  })

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init)
    if (!response.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`)
    }
    return response.json()
  }

  const postEvents = (id: string, events: ReplayEvent[], eventCount: number) =>
    json(`/api/sessions/${id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events, eventCount }),
    })
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  // Consume an SSE stream, invoking onMessage(eventName, data) per frame.
  // Returns an abort handle once the response headers are in.
  const openSse = async (
    path: string,
    onMessage: (event: string, data: unknown) => void,
  ): Promise<{ close: () => void }> => {
    const controller = new AbortController()
    const response = await fetch(`${base}${path}`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`live stream failed: ${response.status}`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let split
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, split)
            buffer = buffer.slice(split + 2)
            let eventName = 'message'
            const dataLines: string[] = []
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (dataLines.length > 0) {
              let data: unknown = null
              try {
                data = JSON.parse(dataLines.join('\n'))
              } catch {
                data = null
              }
              onMessage(eventName, data)
            }
          }
        }
      } catch {
        // aborted / stream closed
      }
    })()

    return { close: () => controller.abort() }
  }

  it('reaches S2 and reports healthy', async () => {
    const health = await json('/api/health')
    expect(health.ok).toBe(true)
    expect(health.s2Status).toBe('ready')
  })

  it('round-trips a recorded session: create → append → read back → list', async () => {
    const { session } = (await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Integration', source: 'integration', url: 'https://example.test/checkout' }),
    })) as { session: SessionDetail }

    expect(session.id).toMatch(/^session-/)

    const t0 = 1_700_000_000_000
    const events: ReplayEvent[] = [
      { type: 4, timestamp: t0, data: { href: 'https://example.test/checkout', width: 1280, height: 720 } },
      { type: 2, timestamp: t0 + 10, data: { node: { type: 0, childNodes: [] }, initialOffset: { top: 0, left: 0 } } },
      { type: 3, timestamp: t0 + 120, data: { source: 2, type: 2, id: 5, x: 12, y: 34 } },
      { type: 3, timestamp: t0 + 240, data: { source: 5, id: 7, text: '****', isChecked: false } },
    ]

    const appended = await json(`/api/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events, eventCount: events.length }),
    })
    expect(appended.appended).toBe(events.length)

    // Read back through the same path the dashboard replays from.
    const detail = ((await json(`/api/sessions/${session.id}`)) as { session: SessionDetail }).session
    expect(detail.events.length).toBeGreaterThanOrEqual(events.length)

    const types = detail.events.map((event) => event.type)
    expect(types).toContain(2) // full snapshot
    expect(types).toContain(4) // meta / navigation

    // A click interaction survives the round trip with its payload intact.
    const click = detail.events.find(
      (event) => event.type === 3 && (event.data as { source?: number } | undefined)?.source === 2,
    )
    expect((click?.data as { x?: number } | undefined)?.x).toBe(12)

    // And the session shows up in the listing.
    const list = (await json('/api/sessions?limit=20')) as ListSessionsResponse
    expect(list.sessions.some((summary) => summary.id === session.id)).toBe(true)
  })

  it('streams newly appended events to a live tail (SSE)', async () => {
    const { session } = (await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Live tail', source: 'integration' }),
    })) as { session: SessionDetail }

    // Seed so the stream exists, then start tailing.
    const t = 1_700_000_500_000
    await postEvents(
      session.id,
      [
        { type: 4, timestamp: t, data: { href: 'https://example.test/live' } },
        { type: 2, timestamp: t + 1, data: { node: {}, initialOffset: { top: 0, left: 0 } } },
      ],
      2,
    )

    let ready = false
    let resolveTarget: (value: { event?: { data?: { x?: number } } }) => void = () => {}
    const targetSeen = new Promise<{ event?: { data?: { x?: number } } }>((resolve) => {
      resolveTarget = resolve
    })

    const stream = await openSse(`/api/sessions/${session.id}/live?fromSeqNum=0`, (event, data) => {
      if (event === 'session-ready') ready = true
      if (event === 'session-event') {
        const payload = data as { event?: { data?: { x?: number } } }
        if (payload?.event?.data?.x === 999) resolveTarget(payload)
      }
    })

    try {
      // Wait for the stream to establish.
      const start = Date.now()
      while (!ready && Date.now() - start < 5000) await new Promise((resolve) => setTimeout(resolve, 50))
      expect(ready).toBe(true)

      // Append a distinguishable event while the tail is open — it must stream through.
      await postEvents(session.id, [{ type: 3, timestamp: t + 2, data: { source: 2, type: 2, id: 9, x: 999, y: 111 } }], 3)

      const target = await Promise.race([
        targetSeen,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out waiting for live event')), 10_000),
        ),
      ])
      expect(target.event?.data?.x).toBe(999)
    } finally {
      stream.close()
    }
  })

  it('round-trips an rrweb event larger than one S2 record', async () => {
    const { session } = (await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Large snapshot', source: 'integration' }),
    })) as { session: SessionDetail }

    await sleep(50)
    const t = Date.now() - 10
    const largeText = 'x'.repeat(1_200_000)
    const events: ReplayEvent[] = [
      { type: 4, timestamp: t, data: { href: 'https://example.test/large-snapshot' } },
      {
        type: 2,
        timestamp: t + 1,
        data: {
          node: { type: 0, childNodes: [], largeText },
          initialOffset: { top: 0, left: 0 },
        },
      },
      { type: 3, timestamp: t + 2, data: { source: 2, type: 2, id: 3, x: 222, y: 111 } },
    ]

    const append = await postEvents(session.id, events, events.length)
    expect(append.appended).toBe(events.length)

    const detail = ((await json(`/api/sessions/${session.id}`)) as { session: SessionDetail }).session
    const snapshot = detail.events.find((event) => event.type === 2)

    expect((snapshot?.data as { node?: { largeText?: string } } | undefined)?.node?.largeText?.length).toBe(
      largeText.length,
    )
    expect(detail.events.some((event) => (event.data as { x?: number } | undefined)?.x === 222)).toBe(true)
  })

  it('deletes a session from S2', async () => {
    const { session } = (await json('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'To delete', source: 'integration' }),
    })) as { session: SessionDetail }

    await json(`/api/sessions/${session.id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ type: 4, timestamp: 1, data: {} }], eventCount: 1 }),
    })

    const deleted = await json(`/api/sessions/${session.id}`, { method: 'DELETE' })
    expect(deleted.deleted).toBe(session.id)

    const list = (await json('/api/sessions?limit=50')) as ListSessionsResponse
    expect(list.sessions.some((summary) => summary.id === session.id)).toBe(false)
  })
})
