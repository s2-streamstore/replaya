import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { SessionDetail, ListSessionsResponse, ReplayEvent } from '../../src/shared/session.ts'

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

  afterAll(() => {
    server?.close()
  })

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init)
    if (!response.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${path} -> ${response.status} ${await response.text()}`)
    }
    return response.json()
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
