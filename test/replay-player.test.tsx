// @vitest-environment jsdom
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplayPlayer, type ReplayPlayerHandle } from '../src/ReplayPlayer'
import type { ReplayEvent } from '../src/shared/session'

type Handler = (payload?: unknown) => void

class MockRrwebPlayer {
  static instances: MockRrwebPlayer[] = []

  options: unknown
  listeners = new Map<string, Handler>()
  replayerListeners = new Map<string, Handler>()
  addEvent = vi.fn()
  goto = vi.fn()
  $destroy = vi.fn()
  addEventListener = vi.fn((event: string, handler: Handler) => {
    this.listeners.set(event, handler)
  })
  getReplayer = vi.fn(() => ({
    on: (event: string, handler: Handler) => {
      this.replayerListeners.set(event, handler)
    },
  }))

  constructor(options: unknown) {
    this.options = options
    const target = (options as { target?: HTMLElement }).target
    if (target) {
      const progress = document.createElement('div')
      progress.className = 'rr-progress'
      progress.getBoundingClientRect = () =>
        ({
          left: 0,
          right: 100,
          top: 0,
          bottom: 10,
          width: 100,
          height: 10,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect
      target.append(progress)
    }
    MockRrwebPlayer.instances.push(this)
  }

  finish() {
    this.replayerListeners.get('finish')?.()
  }

  updateProgress(value: number) {
    this.listeners.get('ui-update-progress')?.({ payload: value })
  }
}

interface ReplayPlayerTestProps {
  sessionId: string
  events: ReplayEvent[]
  live: boolean
  lastSeqNum: number
}

interface RrwebPlayerOptions {
  target: HTMLElement
  props: {
    events: ReplayEvent[]
    liveMode: boolean
    autoPlay: boolean
  }
}

type MockPlayer = InstanceType<typeof MockRrwebPlayer>

const mountedRoots: Root[] = []

function replayEvent(seqNum: number, timestamp: number): ReplayEvent {
  return {
    type: seqNum === 0 ? 4 : 3,
    timestamp,
    data: { source: 2, type: 2, id: seqNum },
    _replaya: { s2SeqNum: seqNum },
  }
}

function playerOptions(player: MockPlayer) {
  return player.options as RrwebPlayerOptions
}

function playerShell(container: HTMLElement) {
  const shell = container.querySelector('.replay-player-shell')
  expect(shell).toBeInstanceOf(HTMLElement)
  return shell as HTMLElement
}

function progressBar(container: HTMLElement) {
  const progress = container.querySelector('.rr-progress')
  expect(progress).toBeInstanceOf(HTMLElement)
  return progress as HTMLElement
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function waitForPlayer() {
  for (let attempt = 0; attempt < 10; attempt++) {
    await flushReact()
    const player = MockRrwebPlayer.instances.at(-1)
    if (player) return player
  }

  throw new Error('ReplayPlayer did not mount rrweb-player')
}

async function mountReplayPlayer(props: ReplayPlayerTestProps) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  const ref = createRef<ReplayPlayerHandle>()
  const createPlayer = (options: unknown) => new MockRrwebPlayer(options)

  const render = async (nextProps: ReplayPlayerTestProps) => {
    await act(async () => {
      root.render(<ReplayPlayer ref={ref} {...nextProps} createPlayer={createPlayer} />)
    })
    await flushReact()
  }

  await render(props)

  return {
    container,
    player: await waitForPlayer(),
    ref,
    rerender: render,
  }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  MockRrwebPlayer.instances.length = 0

  class TestResizeObserver implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', TestResizeObserver)
})

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('ReplayPlayer active-session playback', () => {
  it('mounts active sessions as ordinary rrweb replays and seeks to the live edge', async () => {
    const events = [replayEvent(0, 1_000), replayEvent(1, 1_250)]
    const { container, player } = await mountReplayPlayer({
      sessionId: 'session-live',
      events,
      live: true,
      lastSeqNum: 1,
    })

    expect(playerOptions(player).props.liveMode).toBe(false)
    expect(playerOptions(player).props.autoPlay).toBe(false)
    expect(playerOptions(player).props.events).toEqual(events)
    expect(player.goto).toHaveBeenCalledWith(250, false)
    expect(playerShell(container).dataset.followingLiveEdge).toBe('true')
  })

  it('buffers incoming live events while reviewing history, then plays through them on finish', async () => {
    const initialEvents = [replayEvent(0, 1_000), replayEvent(1, 1_100)]
    const bufferedEvents = [replayEvent(2, 1_200), replayEvent(3, 1_300)]
    const { container, player, ref, rerender } = await mountReplayPlayer({
      sessionId: 'session-live',
      events: initialEvents,
      live: true,
      lastSeqNum: 1,
    })

    await act(async () => {
      ref.current?.seek(50)
    })
    expect(playerShell(container).dataset.followingLiveEdge).toBe('false')

    player.addEvent.mockClear()
    player.goto.mockClear()

    await rerender({
      sessionId: 'session-live',
      events: [...initialEvents, ...bufferedEvents],
      live: true,
      lastSeqNum: 3,
    })

    expect(player.addEvent).not.toHaveBeenCalled()

    await act(async () => {
      player.finish()
    })

    expect(player.addEvent).toHaveBeenNthCalledWith(1, bufferedEvents[0])
    expect(player.addEvent).toHaveBeenNthCalledWith(2, bufferedEvents[1])
    expect(player.goto).toHaveBeenCalledWith(100, true)
    expect(playerShell(container).dataset.followingLiveEdge).toBe('false')
    expect(playerShell(container).dataset.playerState).toBe('playing')
  })

  it('re-enters live mode when a live-session scrub reaches the far right', async () => {
    const events = [replayEvent(0, 1_000), replayEvent(1, 1_100)]
    const { container, player, ref } = await mountReplayPlayer({
      sessionId: 'session-live',
      events,
      live: true,
      lastSeqNum: 1,
    })

    await act(async () => {
      ref.current?.seek(50)
    })
    expect(playerShell(container).dataset.followingLiveEdge).toBe('false')

    await act(async () => {
      player.updateProgress(1)
    })
    expect(playerShell(container).dataset.followingLiveEdge).toBe('false')

    await act(async () => {
      progressBar(container).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100 }))
      player.updateProgress(1)
    })
    expect(playerShell(container).dataset.followingLiveEdge).toBe('true')
  })
})
