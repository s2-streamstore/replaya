import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Configure the server BEFORE importing it (config is read once at module load).
process.env.NODE_ENV = 'test'
process.env.REPLAYA_LOG_REQUESTS = 'false'
process.env.S2_ACCESS_TOKEN = 'dummy-token'
process.env.S2_BASIN = 'dummy-basin-name'
process.env.REPLAYA_INGEST_AUTH_REQUIRED = 'true'
process.env.REPLAYA_PROJECT_KEYS = 'test-key'
process.env.REPLAYA_APPEND_TOKEN_SECRET = 'test-secret'
process.env.REPLAYA_ALLOWED_CAPTURE_ORIGINS = 'https://app.example.com'

let server: Server
let base: string

beforeAll(async () => {
  const { app } = await import('../server/index.ts')
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo
      base = `http://127.0.0.1:${port}`
      resolve()
    })
  })
})

afterAll(() => {
  server?.close()
})

describe('recorder delivery (no auth required)', () => {
  it('serves recorder.js as JavaScript with masking on by default', async () => {
    const response = await fetch(`${base}/recorder.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    const body = await response.text()
    expect(body).toContain('maskAllInputs: !(script && script.dataset.maskAllInputs === "false")')
  })

  it('serves a same-origin recorder fixture in non-production', async () => {
    const response = await fetch(`${base}/recorder-test`)
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(body).toContain('apiHost: window.location.origin')
  })
})

describe('security posture', () => {
  it('sets hardening headers and hides x-powered-by', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-powered-by')).toBeNull()
  })

  it('health endpoint reports ingest auth is enabled', async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.security.ingestAuthRequired).toBe(true)
    expect(body.security.recorderTestEnabled).toBe(true)
  })
})

describe('ingest auth rejection', () => {
  it('rejects session creation without a project key', async () => {
    const response = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'test' }),
    })
    expect(response.status).toBe(401)
  })

  it('rejects event ingest with a valid project key but no append token', async () => {
    const response = await fetch(`${base}/api/sessions/session-abc/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-replaya-project-key': 'test-key' },
      body: JSON.stringify({ events: [{ type: 4, timestamp: 1 }] }),
    })
    expect(response.status).toBe(401)
  })
})

describe('session deletion', () => {
  it('validates the session id before touching storage', async () => {
    const response = await fetch(`${base}/api/sessions/not-a-valid-id`, { method: 'DELETE' })
    expect(response.status).toBe(400)
  })
})
