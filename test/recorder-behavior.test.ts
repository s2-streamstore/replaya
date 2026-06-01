// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recorderScript } from '../server/recorderScript.ts'

// Executes the real generated recorder script in a DOM with mocked transport
// and fake timers, so we assert runtime behavior (masking, flush, backoff,
// beacon size-guard, fail-safe start) rather than just matching source text.

type RecordOptions = { emit: (event: unknown) => void; maskAllInputs?: boolean }
type FetchRoute = (url: string, init: RequestInit | undefined) => Promise<unknown>

let recordOptions: RecordOptions | null = null
let fetchMock: ReturnType<typeof vi.fn>
let beaconMock: ReturnType<typeof vi.fn>
let route: FetchRoute

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

type Replaya = (command: string, options?: unknown) => Promise<unknown>

function loadRecorder() {
  recordOptions = null
  let pagehide: () => void = () => {}
  const win = window as unknown as Record<string, unknown>
  delete win.__replayaRecorderLoaded
  win.replaya = undefined
  win.rrweb = {
    record: (options: RecordOptions) => {
      recordOptions = options
      return () => {}
    },
  }

  // Capture only the pagehide handler this recorder registers, so triggering it
  // in a test doesn't fire stale listeners from earlier loads in the same window.
  const originalAdd = window.addEventListener.bind(window)
  ;(window as unknown as { addEventListener: typeof window.addEventListener }).addEventListener = ((
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (type === 'pagehide') pagehide = handler as () => void
    return originalAdd(type as keyof WindowEventMap, handler, options)
  }) as typeof window.addEventListener

  try {
    new Function(recorderScript())()
  } finally {
    ;(window as unknown as { addEventListener: typeof window.addEventListener }).addEventListener = originalAdd
  }

  return {
    replaya: window.replaya as unknown as Replaya,
    triggerPagehide: () => pagehide(),
  }
}

const emit = (event: unknown) => recordOptions?.emit(event)
const eventsCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/events'))

beforeEach(() => {
  vi.useFakeTimers()
  route = (url) => Promise.resolve(url.includes('/api/sessions/') ? okJson({ appended: 1, tailSeqNum: 0 }) : okJson({ session: { id: 'session-test' }, appendToken: 'tok' }))
  fetchMock = vi.fn((url: string, init?: RequestInit) => route(String(url), init))
  beaconMock = vi.fn(() => true)
  vi.stubGlobal('fetch', fetchMock)
  Object.defineProperty(window.navigator, 'sendBeacon', { value: beaconMock, configurable: true, writable: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('recorder behavior', () => {
  it('starts recording with input masking on by default', async () => {
    loadRecorder()
    await vi.advanceTimersByTimeAsync(1) // let createSession resolve
    expect(recordOptions).toBeTruthy()
    expect(recordOptions?.maskAllInputs).toBe(true)
  })

  it('buffers events and flushes them as a batch', async () => {
    loadRecorder()
    await vi.advanceTimersByTimeAsync(1)
    emit({ type: 3, timestamp: 1, data: { source: 2, type: 2 } })
    emit({ type: 3, timestamp: 2, data: { source: 2, type: 2 } })
    await vi.advanceTimersByTimeAsync(300) // flushEveryMs = 250

    expect(eventsCalls().length).toBeGreaterThanOrEqual(1)
    const body = JSON.parse(String(eventsCalls()[0][1]?.body))
    expect(body.events).toHaveLength(2)
  })

  it('retries a failed flush with backoff and does not lose events', async () => {
    let failNext = true
    route = (url) => {
      if (url.includes('/events')) {
        if (failNext) {
          failNext = false
          return Promise.reject(new Error('network down'))
        }
        return Promise.resolve(okJson({ appended: 1, tailSeqNum: 0 }))
      }
      return Promise.resolve(okJson({ session: { id: 'session-test' }, appendToken: 'tok' }))
    }
    loadRecorder()
    await vi.advanceTimersByTimeAsync(1)

    emit({ type: 3, timestamp: 1, data: { source: 2, type: 2 } })
    await vi.advanceTimersByTimeAsync(300) // first flush attempt -> fails, requeues
    expect(eventsCalls().length).toBe(1)

    // No immediate retry (backoff is ~1s, not the 250ms cadence).
    await vi.advanceTimersByTimeAsync(400)
    expect(eventsCalls().length).toBe(1)

    // After the backoff window, it retries and the event survives.
    await vi.advanceTimersByTimeAsync(1000)
    expect(eventsCalls().length).toBe(2)
    const retried = JSON.parse(String(eventsCalls()[1][1]?.body))
    expect(retried.events).toHaveLength(1)
  })

  it('falls back to keepalive fetch when the unload payload is too big for sendBeacon', async () => {
    const { triggerPagehide } = loadRecorder()
    await vi.advanceTimersByTimeAsync(1)
    emit({ type: 3, timestamp: 1, data: { source: 2, type: 2, blob: 'x'.repeat(70_000) } })

    triggerPagehide() // unload: flush(keepalive=true)
    await vi.advanceTimersByTimeAsync(1)

    const keepaliveEventCall = eventsCalls().find(([, init]) => (init as RequestInit | undefined)?.keepalive)
    expect(keepaliveEventCall).toBeTruthy() // >64KB went via fetch, not beacon
    const beaconedEvents = beaconMock.mock.calls.some(([url]) => String(url).includes('/events'))
    expect(beaconedEvents).toBe(false)
  })

  it('uses sendBeacon for a small unload payload', async () => {
    const { triggerPagehide } = loadRecorder()
    await vi.advanceTimersByTimeAsync(1)
    emit({ type: 3, timestamp: 1, data: { source: 2, type: 2 } })

    triggerPagehide()
    await vi.advanceTimersByTimeAsync(1)

    expect(beaconMock.mock.calls.some(([url]) => String(url).includes('/events'))).toBe(true)
  })

  it('does not throw into the host page when start fails', async () => {
    route = (url) =>
      url.includes('/api/sessions/')
        ? Promise.resolve(okJson({ appended: 0, tailSeqNum: 0 }))
        : Promise.reject(new Error('session create failed'))
    const { replaya } = loadRecorder()
    await vi.advanceTimersByTimeAsync(1)

    expect(recordOptions).toBeNull() // recording never started
    await expect(replaya('start')).resolves.toBeNull() // resolves, does not reject
  })
})
