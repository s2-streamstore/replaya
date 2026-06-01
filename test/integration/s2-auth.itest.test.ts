import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type { CreateSessionResponse, ListSessionsResponse, SessionDetail } from '../../src/shared/session.ts'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

// Full ingest-auth round trip against `s2 lite`: project key gates session
// creation, the returned append token gates event ingest. Skipped unless
// S2_TEST_ENDPOINT is set.
const S2_ENDPOINT = process.env.S2_TEST_ENDPOINT
const PROJECT_KEY = 'test-key'

if (S2_ENDPOINT) {
  process.env.NODE_ENV = 'test'
  process.env.REPLAYA_LOG_REQUESTS = 'false'
  process.env.S2_ACCESS_TOKEN = process.env.S2_ACCESS_TOKEN || 'ignored'
  process.env.S2_BASIN = 'replaya-it-auth'
  process.env.S2_ACCOUNT_ENDPOINT = S2_ENDPOINT
  process.env.S2_BASIN_ENDPOINT = S2_ENDPOINT
  process.env.REPLAYA_INGEST_AUTH_REQUIRED = 'true'
  process.env.REPLAYA_PROJECT_KEYS = PROJECT_KEY
  process.env.REPLAYA_APPEND_TOKEN_SECRET = 'integration-secret'
}

const integration = describe.skipIf(!S2_ENDPOINT)

integration('S2 integration (s2 lite): ingest auth round trip', () => {
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

  it('rejects session creation without a project key', async () => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'integration-auth' }),
    })
    expect(response.status).toBe(401)
  })

  it('accepts a recording with the project key + append token, rejects without the token', async () => {
    // Create with the project key → 201 + an append token.
    const createResponse = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-replaya-project-key': PROJECT_KEY },
      body: JSON.stringify({ title: 'Authed', source: 'integration-auth' }),
    })
    expect(createResponse.status).toBe(201)
    const created = (await createResponse.json()) as CreateSessionResponse
    const id = created.session.id
    expect(created.appendToken).toBeTruthy()

    const events = [{ type: 4, timestamp: 1_700_000_000_000, data: { href: 'https://example.test/authed' } }]

    // Append without the token → rejected.
    const noToken = await fetch(`${base}/api/sessions/${id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events, eventCount: 1 }),
    })
    expect(noToken.status).toBe(401)

    // Append with the token → accepted.
    const withToken = await fetch(`${base}/api/sessions/${id}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-replaya-session-token': created.appendToken as string },
      body: JSON.stringify({ events, eventCount: 1 }),
    })
    expect(withToken.status).toBe(200)
    expect((await withToken.json()).appended).toBe(1)

    // And the event is readable back.
    const detail = ((await (await fetch(`${base}/api/sessions/${id}`)).json()) as { session: SessionDetail }).session
    expect(detail.events.some((event) => event.type === 4)).toBe(true)
  })
})
